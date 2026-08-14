import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import ship, { SHIP_SELECTION_FENCE, STRUCTURED_SHIP_UNAVAILABLE, assertStructuredShipAvailable, buildShipDescription, delegateIssue, parseMarkdown, parseShipArgs, validateGraphSelectionForShip } from "./ship.js";

const directories: string[] = [];

function temporaryProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "openthrottle-ship-test-"));
  directories.push(directory);
  return directory;
}

function cleanupDirectories(): void {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}

function executionPlanBlock(graphId = "structured"): string {
  const contract = JSON.parse(
    readFileSync(new URL("../../contracts/fixtures/valid/execution-plan-v2.json", import.meta.url), "utf8")
  ) as Record<string, unknown>;
  contract.graph_id = graphId;
  return `\`\`\`json openthrottle.execution-plan/v2\n${JSON.stringify(contract, null, 2)}\n\`\`\``;
}

function legacyExecutionPlanBlock(graphId = "structured"): string {
  const contract = JSON.parse(
    readFileSync(new URL("../../contracts/fixtures/valid/execution-plan.json", import.meta.url), "utf8")
  ) as Record<string, unknown>;
  contract.graph_id = graphId;
  return `\`\`\`json openthrottle.execution-plan/v1\n${JSON.stringify(contract, null, 2)}\n\`\`\``;
}

function writeStructuredConfig(
  directory: string,
  allowedGraphs = ["simple", "structured"],
  defaultGraph = "simple"
): void {
  writeFileSync(
    join(directory, ".openthrottle.yml"),
    stringify({
      schema: "openthrottle.config/v1",
      default_graph: defaultGraph,
      graphs: [
        { id: "simple", kind: "builtin", ref: "core/simple@1" },
        { id: "structured", kind: "builtin", ref: "core/structured@3" },
      ],
      intents: {
        implement: { default_graph: defaultGraph, allowed_graphs: allowedGraphs },
      },
    })
  );
}

function readShipSelection(description: string): unknown {
  const match = description.match(/```json openthrottle\.ship-selection\/v1\n([\s\S]*?)```/);
  if (!match) throw new Error("missing ship selection block");
  return JSON.parse(match[1]!.trim());
}

describe("ship", () => {
  afterEach(() => cleanupDirectories());

  it("uses the first level-one heading as title", () => {
    expect(parseMarkdown("preface\n# Ship it\n\nPlan body\n")).toEqual({
      title: "Ship it",
      body: "Plan body",
    });
    expect(() => parseMarkdown("## Not enough")).toThrow(/Heading/);
  });

  it("parses the optional graph selection without changing the file argument", () => {
    expect(parseShipArgs(["plan.md", "--graph", "structured"])).toEqual({
      file: "plan.md",
      graphId: "structured",
    });
    expect(parseShipArgs(["plan.md"])).toEqual({ file: "plan.md" });
    expect(() => parseShipArgs(["plan.md", "--graph"])).toThrow(/requires/);
  });

  it("persists an explicit simple graph selection while leaving implicit simple unchanged", () => {
    expect(buildShipDescription("Plan body")).toBe("Plan body");
    expect(readShipSelection(buildShipDescription("Plan body", "simple"))).toEqual({
      schema: SHIP_SELECTION_FENCE,
      graph_id: "simple",
    });
  });

  it("validates structured graph selections and matching execution plans", async () => {
    const directory = temporaryProject();
    writeStructuredConfig(directory);
    const planPath = join(directory, "plan.md");
    writeFileSync(planPath, "# Ship it\n\nPlan body");
    const previousCwd = process.cwd();
    try {
      process.chdir(directory);
      expect(() => validateGraphSelectionForShip(planPath, undefined)).not.toThrow();
      expect(() => validateGraphSelectionForShip(planPath, "simple")).not.toThrow();

      writeFileSync(planPath, `# Ship it\n\n${executionPlanBlock("structured")}`);
      expect(() => validateGraphSelectionForShip(planPath, "simple")).toThrow(/graph_id must match/);
      const structured = validateGraphSelectionForShip(planPath, "structured");
      expect(structured).toMatchObject({ graphId: "structured", consumesUnits: true });
      const unreachable = vi.fn().mockRejectedValue(new Error("network unreachable"));
      await expect(assertStructuredShipAvailable(structured, unreachable)).rejects.toThrow(STRUCTURED_SHIP_UNAVAILABLE);

      writeFileSync(planPath, `# Ship it\n\n${executionPlanBlock("other")}`);
      expect(() => validateGraphSelectionForShip(planPath, "structured")).toThrow(/graph_id must match/);
    } finally {
      process.chdir(previousCwd);
    }
  });

  describe("assertStructuredShipAvailable", () => {
    const graph = { graphId: "structured", consumesUnits: true } as unknown as Parameters<typeof assertStructuredShipAvailable>[0];
    const nonUnitGraph = { graphId: "simple", consumesUnits: false } as unknown as Parameters<typeof assertStructuredShipAvailable>[0];

    it("does nothing for graphs that do not consume units, without a capability check", async () => {
      const request = vi.fn();
      await expect(assertStructuredShipAvailable(undefined, request)).resolves.toBeUndefined();
      await expect(assertStructuredShipAvailable(nonUnitGraph, request)).resolves.toBeUndefined();
      expect(request).not.toHaveBeenCalled();
    });

    it("fails closed when the supervisor is unreachable", async () => {
      const request = vi.fn().mockRejectedValue(new Error("fetch failed"));
      await expect(assertStructuredShipAvailable(graph, request)).rejects.toThrow(STRUCTURED_SHIP_UNAVAILABLE);
    });

    it("fails closed on an unauthenticated/error response", async () => {
      const request = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
      await expect(assertStructuredShipAvailable(graph, request)).rejects.toThrow(STRUCTURED_SHIP_UNAVAILABLE);
    });

    it("fails closed on a malformed capability body", async () => {
      const request = vi.fn().mockResolvedValue(Response.json({ release: "r1" }));
      await expect(assertStructuredShipAvailable(graph, request)).rejects.toThrow(/stale or malformed/);
    });

    it("fails closed when the exact structured capability is missing", async () => {
      const request = vi.fn().mockResolvedValue(
        Response.json({ release: "openthrottle-snapshot/v7", capabilityDigest: "a".repeat(64), capabilities: ["ce/implement@1"] })
      );
      await expect(assertStructuredShipAvailable(graph, request)).rejects.toThrow(STRUCTURED_SHIP_UNAVAILABLE);
      expect(request).toHaveBeenCalledWith("/capabilities");
    });

    it("permits structured mutation for matching active evidence", async () => {
      const request = vi.fn().mockResolvedValue(
        Response.json({
          release: "openthrottle-snapshot/v7",
          capabilityDigest: "a".repeat(64),
          capabilities: ["ce/implement@1", "graph/for-each-unit@1"],
        })
      );
      await expect(assertStructuredShipAvailable(graph, request)).resolves.toBeUndefined();
    });
  });

  it("rejects invalid structured ship input before Linear calls", async () => {
    const directory = temporaryProject();
    writeStructuredConfig(directory);
    const planPath = join(directory, "plan.md");
    writeFileSync(planPath, `# Ship it\n\n${executionPlanBlock("other")}`);
    const previousCwd = process.cwd();
    const exit = process.exit;
    const fetchMock = vi.fn();
    const originalFetch = globalThis.fetch;
    process.exit = ((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      process.chdir(directory);
      await expect(ship([planPath, "--graph", "structured"])).rejects.toThrow(/exit 1/);
      writeFileSync(planPath, `# Ship it\n\n${legacyExecutionPlanBlock("structured")}`);
      await expect(ship([planPath, "--graph", "structured"])).rejects.toThrow(/exit 1/);
      const nonCanonical = executionPlanBlock("structured").replace(
        "json openthrottle.execution-plan/v2",
        "json"
      );
      writeFileSync(planPath, `# Ship it\n\n${nonCanonical}`);
      await expect(ship([planPath, "--graph", "structured"])).rejects.toThrow(/exit 1/);
      writeFileSync(planPath, `# Ship it\n\n${executionPlanBlock("structured")}`);
      await expect(ship([planPath, "--graph", "simple"])).rejects.toThrow(/exit 1/);
      writeStructuredConfig(directory, ["structured"]);
      writeFileSync(planPath, "# Ship it\n\nPlan body");
      await expect(ship([planPath, "--graph", "simple"])).rejects.toThrow(/exit 1/);
      writeStructuredConfig(directory, ["simple", "structured"], "structured");
      await expect(ship([planPath])).rejects.toThrow(/exit 1/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
      process.exit = exit;
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects a canonical plan selection without local config before Linear calls", async () => {
    const directory = temporaryProject();
    const planPath = join(directory, "plan.md");
    writeFileSync(planPath, `# Ship it\n\n${executionPlanBlock("structured")}`);
    const originalFetch = globalThis.fetch;
    const previousCwd = process.cwd();
    const exit = process.exit;
    const fetchMock = vi.fn();
    process.exit = ((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      process.chdir(directory);
      expect(() => validateGraphSelectionForShip(planPath)).toThrow(/cannot validate execution_plan\.graph_id structured/);
      await expect(ship([planPath])).rejects.toThrow(/exit 1/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
      process.exit = exit;
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps no-graph simple ship compatible without local graph config", async () => {
    const directory = temporaryProject();
    const planPath = join(directory, "plan.md");
    writeFileSync(planPath, "# Ship it\n\nPlan body");
    const originalFetch = globalThis.fetch;
    const previousLinearKey = process.env.LINEAR_API_KEY;
    const previousTeamId = process.env.LINEAR_TEAM_ID;
    const previousAgentAppId = process.env.OT_AGENT_APP_ID;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("IssueCreate")) {
        return Response.json({
          data: {
            issueCreate: {
              success: true,
              issue: { id: "issue-1", identifier: "OPE-1", url: "https://linear.test/OPE-1" },
            },
          },
        });
      }
      throw new Error("unexpected Linear query");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.LINEAR_API_KEY = "linear-key";
    process.env.LINEAR_TEAM_ID = "team-1";
    delete process.env.OT_AGENT_APP_ID;
    try {
      await ship([planPath]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({
        variables: {
          input: {
            teamId: "team-1",
            title: "Ship it",
            description: "Plan body",
          },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (previousLinearKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousLinearKey;
      if (previousTeamId === undefined) delete process.env.LINEAR_TEAM_ID;
      else process.env.LINEAR_TEAM_ID = previousTeamId;
      if (previousAgentAppId === undefined) delete process.env.OT_AGENT_APP_ID;
      else process.env.OT_AGENT_APP_ID = previousAgentAppId;
    }
  });

  it("creates then delegates a first-assignment issue with delegateId", async () => {
    const directory = temporaryProject();
    const planPath = join(directory, "plan.md");
    writeFileSync(planPath, "# Ship it\n\nPlan body");
    const originalFetch = globalThis.fetch;
    const previousLinearKey = process.env.LINEAR_API_KEY;
    const previousTeamId = process.env.LINEAR_TEAM_ID;
    const previousAgentAppId = process.env.OT_AGENT_APP_ID;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("IssueCreate")) {
        return Response.json({
          data: {
            issueCreate: {
              success: true,
              issue: { id: "issue-1", identifier: "OPE-1", url: "https://linear.test/OPE-1" },
            },
          },
        });
      }
      if (body.query.includes("IssueUpdate")) {
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      throw new Error("unexpected Linear query");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.LINEAR_API_KEY = "linear-key";
    process.env.LINEAR_TEAM_ID = "team-1";
    process.env.OT_AGENT_APP_ID = "app-actor-1";
    try {
      await ship([planPath]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({
        variables: {
          input: {
            teamId: "team-1",
            title: "Ship it",
            description: "Plan body",
          },
        },
      });
      expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toMatchObject({
        variables: { id: "issue-1", input: { delegateId: "app-actor-1" } },
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (previousLinearKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousLinearKey;
      if (previousTeamId === undefined) delete process.env.LINEAR_TEAM_ID;
      else process.env.LINEAR_TEAM_ID = previousTeamId;
      if (previousAgentAppId === undefined) delete process.env.OT_AGENT_APP_ID;
      else process.env.OT_AGENT_APP_ID = previousAgentAppId;
    }
  });

  it("rejects valid structured input before any Linear call", async () => {
    const directory = temporaryProject();
    writeStructuredConfig(directory);
    const planPath = join(directory, "plan.md");
    writeFileSync(planPath, `# Ship it\n\nPrepared body\n\n${executionPlanBlock("structured")}`);
    const originalFetch = globalThis.fetch;
    const previousCwd = process.cwd();
    const previousLinearKey = process.env.LINEAR_API_KEY;
    const exit = process.exit;
    const fetchMock = vi.fn();
    process.exit = ((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.LINEAR_API_KEY = "linear-key";
    try {
      process.chdir(directory);
      await expect(ship([planPath, "--graph", "structured"])).rejects.toThrow(/exit 1/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
      process.exit = exit;
      globalThis.fetch = originalFetch;
      if (previousLinearKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousLinearKey;
    }
  });

  it("makes no Linear request when the supervisor reports the structured capability is missing", async () => {
    const directory = temporaryProject();
    writeStructuredConfig(directory);
    const planPath = join(directory, "plan.md");
    writeFileSync(planPath, `# Ship it\n\nPrepared body\n\n${executionPlanBlock("structured")}`);
    const originalFetch = globalThis.fetch;
    const previousCwd = process.cwd();
    const previousLinearKey = process.env.LINEAR_API_KEY;
    const previousSupervisorUrl = process.env.OT_SUPERVISOR_URL;
    const previousStatusToken = process.env.OT_STATUS_TOKEN;
    const exit = process.exit;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/capabilities")) {
        return Response.json({
          release: "openthrottle-snapshot/v7",
          capabilityDigest: "a".repeat(64),
          capabilities: ["ce/implement@1"],
        });
      }
      throw new Error("unexpected Linear query before capability gate resolved");
    });
    process.exit = ((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.LINEAR_API_KEY = "linear-key";
    process.env.OT_SUPERVISOR_URL = "https://supervisor.test";
    process.env.OT_STATUS_TOKEN = "operator-token";
    try {
      process.chdir(directory);
      await expect(ship([planPath, "--graph", "structured"])).rejects.toThrow(/exit 1/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toContain("/capabilities");
    } finally {
      process.chdir(previousCwd);
      process.exit = exit;
      globalThis.fetch = originalFetch;
      if (previousLinearKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousLinearKey;
      if (previousSupervisorUrl === undefined) delete process.env.OT_SUPERVISOR_URL;
      else process.env.OT_SUPERVISOR_URL = previousSupervisorUrl;
      if (previousStatusToken === undefined) delete process.env.OT_STATUS_TOKEN;
      else process.env.OT_STATUS_TOKEN = previousStatusToken;
    }
  });

  it("ships structured input once the supervisor advertises the exact active capability", async () => {
    const directory = temporaryProject();
    writeStructuredConfig(directory);
    const planPath = join(directory, "plan.md");
    writeFileSync(planPath, `# Ship it\n\nPrepared body\n\n${executionPlanBlock("structured")}`);
    const originalFetch = globalThis.fetch;
    const previousCwd = process.cwd();
    const previousLinearKey = process.env.LINEAR_API_KEY;
    const previousTeamId = process.env.LINEAR_TEAM_ID;
    const previousAgentAppId = process.env.OT_AGENT_APP_ID;
    const previousSupervisorUrl = process.env.OT_SUPERVISOR_URL;
    const previousStatusToken = process.env.OT_STATUS_TOKEN;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/capabilities")) {
        return Response.json({
          release: "openthrottle-snapshot/v7",
          capabilityDigest: "a".repeat(64),
          capabilities: ["ce/implement@1", "graph/for-each-unit@1"],
        });
      }
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("IssueCreate")) {
        return Response.json({
          data: {
            issueCreate: {
              success: true,
              issue: { id: "issue-1", identifier: "OPE-1", url: "https://linear.test/OPE-1" },
            },
          },
        });
      }
      throw new Error("unexpected Linear query");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.LINEAR_API_KEY = "linear-key";
    process.env.LINEAR_TEAM_ID = "team-1";
    process.env.OT_SUPERVISOR_URL = "https://supervisor.test";
    process.env.OT_STATUS_TOKEN = "operator-token";
    delete process.env.OT_AGENT_APP_ID;
    try {
      process.chdir(directory);
      await ship([planPath, "--graph", "structured"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]![0]).toContain("/capabilities");
    } finally {
      process.chdir(previousCwd);
      globalThis.fetch = originalFetch;
      if (previousLinearKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousLinearKey;
      if (previousTeamId === undefined) delete process.env.LINEAR_TEAM_ID;
      else process.env.LINEAR_TEAM_ID = previousTeamId;
      if (previousAgentAppId === undefined) delete process.env.OT_AGENT_APP_ID;
      else process.env.OT_AGENT_APP_ID = previousAgentAppId;
      if (previousSupervisorUrl === undefined) delete process.env.OT_SUPERVISOR_URL;
      else process.env.OT_SUPERVISOR_URL = previousSupervisorUrl;
      if (previousStatusToken === undefined) delete process.env.OT_STATUS_TOKEN;
      else process.env.OT_STATUS_TOKEN = previousStatusToken;
    }
  });

  it("delegates with IssueUpdateInput.delegateId", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ data: { issueUpdate: { success: true } } })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await delegateIssue("linear-key", "issue-1", "app-actor-1");
      const init = fetchMock.mock.calls[0]![1]!;
      expect(JSON.parse(String(init.body))).toMatchObject({
        variables: { id: "issue-1", input: { delegateId: "app-actor-1" } },
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects a false issueUpdate success result", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      Response.json({ data: { issueUpdate: { success: false } } })
    ) as unknown as typeof fetch;
    try {
      await expect(delegateIssue("linear-key", "issue-1", "app-actor-1")).rejects.toThrow(
        "success: false"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
