import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import ship, { SHIP_SELECTION_FENCE, buildShipDescription, delegateIssue, parseMarkdown, parseShipArgs, validateGraphSelectionForShip } from "./ship.js";

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
    readFileSync(new URL("../../contracts/fixtures/valid/execution-plan.json", import.meta.url), "utf8")
  ) as Record<string, unknown>;
  contract.graph_id = graphId;
  return `\`\`\`json openthrottle.execution-plan/v1\n${JSON.stringify(contract, null, 2)}\n\`\`\``;
}

function writeStructuredConfig(directory: string, allowedGraphs = ["simple", "structured"]): void {
  writeFileSync(
    join(directory, ".openthrottle.yml"),
    stringify({
      schema: "openthrottle.config/v1",
      default_graph: "simple",
      graphs: [
        { id: "simple", kind: "builtin", ref: "core/simple@1" },
        { id: "structured", kind: "builtin", ref: "core/structured@1" },
      ],
      intents: {
        implement: { default_graph: "simple", allowed_graphs: allowedGraphs },
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

  it("validates structured graph selections and matching execution plans", () => {
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
      expect(() => validateGraphSelectionForShip(planPath, "structured")).not.toThrow();

      writeFileSync(planPath, `# Ship it\n\n${executionPlanBlock("other")}`);
      expect(() => validateGraphSelectionForShip(planPath, "structured")).toThrow(/graph_id must match/);
    } finally {
      process.chdir(previousCwd);
    }
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
      writeFileSync(planPath, `# Ship it\n\n${executionPlanBlock("structured")}`);
      await expect(ship([planPath, "--graph", "simple"])).rejects.toThrow(/exit 1/);
      writeStructuredConfig(directory, ["structured"]);
      writeFileSync(planPath, "# Ship it\n\nPlan body");
      await expect(ship([planPath, "--graph", "simple"])).rejects.toThrow(/exit 1/);
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

  it("ships valid structured input with the execution plan in the Linear body", async () => {
    const directory = temporaryProject();
    writeStructuredConfig(directory);
    const planPath = join(directory, "plan.md");
    writeFileSync(planPath, `# Ship it\n\nPrepared body\n\n${executionPlanBlock("structured")}`);
    const originalFetch = globalThis.fetch;
    const previousCwd = process.cwd();
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
      process.chdir(directory);
      await ship([planPath, "--graph", "structured"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
      const description = String(payload.variables.input.description);
      expect(description).toContain("openthrottle.execution-plan/v1");
      expect(readShipSelection(description)).toEqual({
        schema: SHIP_SELECTION_FENCE,
        graph_id: "structured",
      });
    } finally {
      process.chdir(previousCwd);
      globalThis.fetch = originalFetch;
      if (previousLinearKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousLinearKey;
      if (previousTeamId === undefined) delete process.env.LINEAR_TEAM_ID;
      else process.env.LINEAR_TEAM_ID = previousTeamId;
      if (previousAgentAppId === undefined) delete process.env.OT_AGENT_APP_ID;
      else process.env.OT_AGENT_APP_ID = previousAgentAppId;
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
