import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestCanonicalJson } from "./canonical.js";
import { parseRepositoryConfigContract } from "./config.js";
import { parseExecutionPlanContract } from "./execution-plan.js";
import { parseGraphContract } from "./graph.js";
import { parseStandardReceipt } from "./receipts.js";

const fixtureRoot = new URL("../fixtures", import.meta.url);

function readFixture(group: "valid" | "invalid", name: string): string {
  return readFileSync(join(fixtureRoot.pathname, group, name), "utf8");
}

function invalidFixtures(): string[] {
  return readdirSync(join(fixtureRoot.pathname, "invalid")).filter((name) => name.endsWith(".json")).sort();
}

function parseByName(name: string, raw: string): unknown {
  if (name.startsWith("config-")) return parseRepositoryConfigContract(raw, { source: name });
  if (name.startsWith("graph-")) return parseGraphContract(raw, { source: name });
  if (name === "execution-plan.json" || name.startsWith("execution-plan-")) {
    return parseExecutionPlanContract(raw, { source: name });
  }
  if (name.startsWith("receipt-")) return parseStandardReceipt(raw, { source: name });
  throw new Error(`unrouted fixture ${name}`);
}

const invalidCases = [
  ["config-path-traversal.json", /ref: has an invalid format/],
  ["config-provider-secret-env.json", /must not name a provider-secret identifier/],
  ["config-unknown-field.json", /unexpected: unknown field/],
  ["execution-plan-unknown-field.json", /inline_prompt: unknown field/],
  ["graph-dependency-cycle.json", /depends_on: creates a cycle/],
  ["graph-duplicate-node.json", /nodes: must not contain duplicate IDs/],
  ["graph-disconnected-cycle.json", /nodes\.repair_a: is unreachable from entry_node/],
  ["graph-unknown-loop.json", /nodes\.implement\.loop: references an unknown loop/],
  ["graph-unbounded-cycle.json", /transitions\.success: creates an unbounded cycle/],
  ["graph-excess-bounds.json", /max_parallel: must be an integer between 1 and 1/],
  ["graph-internal-node-kind.json", /nodes\[0\]\.kind: must be one of/],
  ["graph-loop-skill-not-allowed.json", /loops\.unit_loop\.skill: is not allowed by the worker/],
  ["graph-provider-secret-credential.json", /credentials\[0\]: must be one of/],
  ["graph-skill-traversal.json", /workers\[0\]\.skills\[0\]: has an invalid format/],
  ["graph-unreachable-node.json", /nodes\.dead_command: is unreachable from entry_node/],
  ["graph-unknown-field.json", /prompt: unknown field/],
  ["execution-plan-duplicate-unit.json", /units: must not contain duplicate IDs/],
  ["execution-plan-cycle.json", /depends_on: creates a cycle/],
  ["execution-plan-bad-ref.json", /depends_on: references an unknown unit/],
  ["execution-plan-invalid-command.json", /commands\[0\]\.name: has an invalid format/],
  ["receipt-bad-skill-ref.json", /producer\.skill: has an invalid format/],
  ["receipt-skill-traversal.json", /producer\.skill: has an invalid format/],
  ["receipt-semantic-assurance-upgrade.json", /assurance: semantic receipts cannot claim/],
  ["receipt-missing-fence.json", /fence\.request_hash: must be a non-empty string/],
  ["receipt-unit-completion-missing-payload-field.json", /payload\.requested_human_input: must be an array/],
  ["receipt-unit-decision-bad-result.json", /result: must be one of: accept, revise, context_update, needs_human/],
  ["receipt-unknown-field.json", /executor_verified: unknown field/],
] as const;

describe("Stage C contract fixtures", () => {
  it("keeps the committed repository bootstrap on all four npm projects", () => {
    const config = readFileSync(new URL("../../.openthrottle.yml", import.meta.url), "utf8");
    for (const project of ["contracts", "supervisor", "cli", "sandbox"]) {
      expect(config).toContain(`npm ci --prefix ${project}`);
    }
  });

  it("accepts and normalizes the frozen valid corpora", () => {
    const fixtures = [
      "config-repository.json",
      "graph-structured.json",
      "execution-plan.json",
      "receipt-unit-completion.json",
      "receipt-unit-decision.json",
    ];

    for (const fixture of fixtures) {
      const raw = readFixture("valid", fixture);
      const validated = parseByName(fixture, raw) as { value: unknown; normalized: string; digest: string };
      expect(JSON.parse(validated.normalized)).toEqual(validated.value);
      expect(validated.digest).toBe(digestCanonicalJson(validated.value));
    }
  });

  it("keeps map ordering irrelevant while preserving authored array order", () => {
    const raw = readFixture("valid", "execution-plan.json");
    const first = parseExecutionPlanContract(raw, { source: "plan" });
    const reordered = JSON.parse(raw) as Record<string, unknown>;
    reordered.acceptance = {
      fixtures_reject: "Invalid corpora reject with stable diagnostic paths.",
      schemas_exported: "Contracts package exports parser and validator entry points.",
    };
    reordered.instructions = {
      add_corpora: "Add valid and invalid fixture corpora for deterministic validation.",
      freeze_schemas: "Freeze closed public schemas with strict unknown-field rejection.",
    };
    const second = parseExecutionPlanContract(JSON.stringify(reordered), { source: "plan" });

    expect(second.normalized).toBe(first.normalized);
    expect(second.digest).toBe(first.digest);

    const reversed = JSON.parse(raw) as { units: unknown[] };
    reversed.units = [...reversed.units].reverse();
    expect(parseExecutionPlanContract(JSON.stringify(reversed), { source: "plan" }).digest).not.toBe(first.digest);
  });

  it.each(invalidCases)("rejects invalid fixture %s with a stable path", (fixture, message) => {
    expect(() => parseByName(fixture, readFixture("invalid", fixture))).toThrow(message);
  });

  it("routes every invalid corpus fixture through a parser", () => {
    expect(invalidFixtures()).toEqual(invalidCases.map(([fixture]) => fixture).sort());
  });

  it("validates graph command and MCP references against repository config", () => {
    const config = parseRepositoryConfigContract(readFixture("valid", "config-repository.json"), { source: "config" });
    config.value.mcp_servers = {
      local: { command: "node", args: [], env: {} },
    };
    const graphRaw = readFixture("valid", "graph-structured.json");
    const graph = JSON.parse(graphRaw) as {
      workers: Array<Record<string, unknown>>;
      loops: Array<Record<string, unknown>>;
      nodes: Array<Record<string, unknown>>;
    };
    graph.nodes.push({
      id: "test",
      kind: "command",
      command: "test",
      depends_on: [],
      transitions: { success: { terminal: "completed" } },
    });
    graph.nodes[0]!.transitions = {
      ...(graph.nodes[0]!.transitions as Record<string, unknown>),
      no_change: { to: "test" },
    };
    expect(() => parseGraphContract(JSON.stringify(graph), { source: "graph", config: config.value })).not.toThrow();

    graph.nodes[2]!.command = "missing";
    expect(() => parseGraphContract(JSON.stringify(graph), { source: "graph", config: config.value }))
      .toThrow(/nodes\.test\.command: references an unknown repository command/);

    graph.nodes[2]!.command = "test";
    graph.workers[0]!.credentials = ["repo.read", "model.invoke", "mcp"];
    graph.workers[0]!.allowed_mcp_servers = ["missing"];
    expect(() => parseGraphContract(JSON.stringify(graph), { source: "graph", config: config.value }))
      .toThrow(/workers\.implementer\.allowed_mcp_servers: references an unknown MCP server/);

    graph.workers[0]!.credentials = ["repo.read", "model.invoke"];
    graph.workers[0]!.allowed_mcp_servers = ["local"];
    expect(() => parseGraphContract(JSON.stringify(graph), { source: "graph", config: config.value }))
      .toThrow(/workers\.implementer\.allowed_mcp_servers: requires the mcp credential scope/);

    graph.workers[0]!.allowed_mcp_servers = [];
    graph.loops[0]!.worker = "missing";
    expect(() => parseGraphContract(JSON.stringify(graph), { source: "graph", config: config.value }))
      .toThrow(/loops\.unit_loop\.worker: references an unknown worker/);
  });

  it("validates repository skill references against config allowlisted directories", () => {
    const config = JSON.parse(readFixture("valid", "config-repository.json")) as {
      skills?: Array<{ id: string; path: string }>;
    };
    config.skills = [{ id: "implement_unit", path: ".agents/skills/implement-unit" }];
    const parsedConfig = parseRepositoryConfigContract(JSON.stringify(config), { source: "config" });
    expect(parsedConfig.value.skills).toEqual(config.skills);

    const graph = JSON.parse(readFixture("valid", "graph-structured.json")) as {
      workers: Array<Record<string, unknown>>;
      loops: Array<Record<string, unknown>>;
    };
    graph.workers[0]!.skills = ["repo://implement_unit"];
    graph.loops[0]!.skill = "repo://implement_unit";
    expect(() => parseGraphContract(JSON.stringify(graph), { source: "graph", config: parsedConfig.value }))
      .not.toThrow();

    graph.loops[0]!.skill = "repo://missing";
    graph.workers[0]!.skills = ["repo://missing"];
    expect(() => parseGraphContract(JSON.stringify(graph), { source: "graph", config: parsedConfig.value }))
      .toThrow(/workers\.implementer\.skills: references an undeclared repository skill/);

    config.skills = [{ id: "bad", path: "../skills/bad" }];
    expect(() => parseRepositoryConfigContract(JSON.stringify(config), { source: "config" }))
      .toThrow(/config\.skills\[0\]\.path: has an invalid format/);
  });

  it("rejects provider-secret identifiers in config values and headers", () => {
    const config = JSON.parse(readFixture("valid", "config-repository.json")) as {
      mcp_servers: Record<string, unknown>;
    };
    config.mcp_servers.local = {
      command: "node",
      env: { SAFE_ENV: "${GITHUB_TOKEN}" },
    };
    expect(() => parseRepositoryConfigContract(JSON.stringify(config), { source: "config" }))
      .toThrow(/mcp_servers\.local\.env\.SAFE_ENV: must not name a provider-secret identifier/);

    config.mcp_servers.local = {
      url: "https://mcp.example.test",
      headers: { Authorization: "Bearer ${OT_STATUS_TOKEN}" },
    };
    expect(() => parseRepositoryConfigContract(JSON.stringify(config), { source: "config" }))
      .toThrow(/mcp_servers\.local\.headers\.Authorization: must not name a provider-secret identifier/);
  });

  it("normalizes repository command aliases from the canonical commands map", () => {
    const config = JSON.parse(readFixture("valid", "config-repository.json")) as {
      commands: Record<string, string>;
      test?: string;
      lint?: string;
      build?: string;
    };
    delete config.test;
    delete config.lint;
    delete config.build;

    const parsed = parseRepositoryConfigContract(JSON.stringify(config), { source: "config" });

    expect(parsed.value.commands).toMatchObject({
      test: config.commands.test,
      lint: config.commands.lint,
      build: config.commands.build,
    });
    expect(parsed.value.test).toBe(config.commands.test);
    expect(parsed.value.lint).toBe(config.commands.lint);
    expect(parsed.value.build).toBe(config.commands.build);
    expect(JSON.parse(parsed.normalized)).toMatchObject({
      commands: config.commands,
      test: config.commands.test,
      lint: config.commands.lint,
      build: config.commands.build,
    });
  });

  it("synthesizes canonical commands from legacy aliases and rejects mismatches", () => {
    const config = JSON.parse(readFixture("valid", "config-repository.json")) as {
      commands?: Record<string, string>;
      test: string;
      lint: string;
      build: string;
    };
    delete config.commands;

    const parsed = parseRepositoryConfigContract(JSON.stringify(config), { source: "config" });

    expect(parsed.value.commands).toMatchObject({
      test: config.test,
      lint: config.lint,
      build: config.build,
    });

    const conflicting = JSON.parse(readFixture("valid", "config-repository.json")) as {
      commands: Record<string, string>;
      test: string;
    };
    conflicting.test = "npm run different";
    expect(() => parseRepositoryConfigContract(JSON.stringify(conflicting), { source: "config" }))
      .toThrow(/config\.test: must match commands\.test/);
  });
});
