import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestCanonicalJson } from "./canonical.js";
import { parseRepositoryConfigContract } from "./config.js";
import { parseExecutionPlanContract } from "./execution-plan.js";
import { parseGraphContract } from "./graph.js";
import {
  decideDifferentialRatchet,
  parseCitationContractProposal,
  parseRatchetDifferentialInput,
  parseStandardReceipt,
  validateTuneProposalContract,
  validateTuneSealedIntentContract,
  validateTuneTaskContract,
  validateRatchetDecision,
  validateStandardReceipt,
} from "./index.js";

const fixtureRoot = new URL("../fixtures", import.meta.url);

function readFixture(group: "valid" | "invalid", name: string): string {
  return readFileSync(join(fixtureRoot.pathname, group, name), "utf8");
}

function invalidFixtures(): string[] {
  return readdirSync(join(fixtureRoot.pathname, "invalid")).filter((name) => name.endsWith(".json")).sort();
}

function repositorySkillPolicy(tunable: boolean): {
  pinned_config: ReturnType<typeof parseRepositoryConfigContract>["value"];
  proposed_config: ReturnType<typeof parseRepositoryConfigContract>["value"];
} {
  const pinnedConfig = parseRepositoryConfigContract(readFixture("valid", "config-repository.json")).value;
  pinnedConfig.skills = [{
    id: "implement_unit",
    path: ".openthrottle/skills/implement_unit",
    tunable,
  }];
  return {
    pinned_config: pinnedConfig,
    proposed_config: structuredClone(pinnedConfig),
  };
}

function parseByName(name: string, raw: string): unknown {
  if (name.startsWith("config-")) return parseRepositoryConfigContract(raw, { source: name });
  if (name.startsWith("citation-contract")) return parseCitationContractProposal(raw, { source: name });
  if (name.startsWith("graph-")) return parseGraphContract(raw, { source: name });
  if (name === "execution-plan.json" || name.startsWith("execution-plan-")) {
    return parseExecutionPlanContract(raw, { source: name });
  }
  if (name.startsWith("ratchet-contract")) return parseRatchetDifferentialInput(raw, { source: name });
  if (name.startsWith("receipt-")) return parseStandardReceipt(raw, { source: name });
  throw new Error(`unrouted fixture ${name}`);
}

const invalidCases = [
  ["citation-contract-empty-claim-citations.json", /claims\[0\]\.citation_ids: must contain between 1 and 32 entries/],
  ["citation-contract-unknown-citation.json", /claims\.claim_one\.citation_ids: references an unknown citation/],
  ["citation-contract-unknown-field.json", /claims\[0\]\.confidence: unknown field/],
  ["citation-contract-unbounded-query.json", /query\.limit: must be an integer between 1 and 200/],
  ["citation-contract-unsupported-query.json", /query\.outcome: must be one of/],
  ["config-path-traversal.json", /ref: has an invalid format/],
  ["config-provider-secret-env.json", /must not name a provider-secret identifier/],
  ["config-unknown-field.json", /unexpected: unknown field/],
  ["execution-plan-unknown-field.json", /inline_prompt: unknown field/],
  ["graph-dependency-cycle.json", /depends_on: creates a cycle/],
  ["graph-command-after-candidate-phase.json", /nodes\.implement\.phases: candidate must immediately precede lead/],
  ["graph-duplicate-node.json", /nodes: must not contain duplicate IDs/],
  ["graph-disconnected-cycle.json", /nodes\.repair_a: is unreachable from entry_node/],
  ["graph-unknown-loop.json", /nodes\.implement\.phases\[0\]\.loop: references an unknown loop/],
  ["graph-unbounded-cycle.json", /transitions\.success: creates an unbounded cycle/],
  ["graph-excess-bounds.json", /max_parallel: must be an integer between 1 and 1/],
  ["graph-gate-worker-repo-write.json", /nodes\.implement\.phases\[3\]\.worker\.credentials: gate phases cannot request repo\.write/],
  ["graph-internal-node-kind.json", /nodes\[0\]\.kind: must be one of/],
  ["graph-duplicate-integrate-phase.json", /nodes\.implement\.phases: must not contain duplicate phase IDs/],
  ["graph-integrate-not-last-phase.json", /nodes\.implement\.phases\[3\]: integrate must be the last unit phase/],
  ["graph-loop-skill-not-allowed.json", /loops\.unit_loop\.skill: is not allowed by the worker/],
  ["graph-missing-integrate-phase.json", /nodes\.implement\.phases: must include exactly one integrate phase/],
  ["graph-provider-secret-credential.json", /credentials\[0\]: must be one of/],
  ["graph-simplify-before-implement-phase.json", /nodes\.implement\.phases\[0\]: simplify must not precede implement/],
  ["graph-skill-traversal.json", /workers\[0\]\.skills\[0\]: has an invalid format/],
  ["graph-unreachable-node.json", /nodes\.dead_command: is unreachable from entry_node/],
  ["graph-unknown-field.json", /prompt: unknown field/],
  ["execution-plan-duplicate-unit.json", /units: must not contain duplicate IDs/],
  ["execution-plan-cycle.json", /depends_on: creates a cycle/],
  ["execution-plan-bad-ref.json", /depends_on: references an unknown unit/],
  ["execution-plan-invalid-command.json", /commands\[0\]\.name: has an invalid format/],
  ["ratchet-contract-duplicate-artifact.json", /pinned: must not contain duplicates/],
  ["ratchet-contract-invalid-authority.json", /tuner_authority\.proposal_digest: has an invalid format/],
  ["ratchet-contract-unknown-field.json", /pinned\[0\]\.digest: unknown field/],
  ["receipt-bad-skill-ref.json", /producer\.skill: has an invalid format/],
  ["receipt-skill-traversal.json", /producer\.skill: has an invalid format/],
  ["receipt-semantic-assurance-upgrade.json", /assurance: semantic receipts cannot claim/],
  ["receipt-semantic-review-finding-string.json", /payload\.findings\[0\]: must be an object/],
  ["receipt-missing-fence.json", /fence\.request_hash: must be a non-empty string/],
  ["receipt-unit-completion-summary-array.json", /payload\.summary: must be a non-empty string/],
  ["receipt-unit-completion-missing-payload-field.json", /payload\.requested_human_input: must be an array/],
  ["receipt-unit-decision-bad-result.json", /result: must be one of: accept, revise, context_update, needs_human/],
  ["receipt-unknown-field.json", /executor_verified: unknown field/],
  ["receipt-invalid-generation.json", /fence\.generation: must be an integer between 1 and 1000000/],
  ["receipt-invalid-skill-package-digest.json", /producer\.skill_package_digest: has an invalid format/],
  ["receipt-invalid-native-session-id.json", /fence\.native_session_id: has an invalid format/],
] as const;

describe("Stage C contract fixtures", () => {
  function tuneTask(): Record<string, unknown> {
    return {
      schema: "openthrottle.tune-task/v1",
      id: "tune_contracts",
      target: {
        kind: "skill",
        id: "implement_unit",
        path: "skills/tasks/implement-unit/SKILL.md",
        digest: "a".repeat(64),
      },
      query: { outcome: "failure", graph: "structured", limit: 50 },
      scope: "repository",
      window: {
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-12T00:00:00.000Z",
        limit: 200,
      },
      baseline: {
        base_ref: "main",
        base_digest: "b".repeat(64),
        runtime_release: "openthrottle-snapshot/v12",
        capability_digest: "c".repeat(64),
      },
      policy: {
        allow_edit_paths: ["skills/tasks/implement-unit", "docs/solutions"],
        requires_citation_gate: true,
        requires_ratchet: true,
        max_changed_files: 2,
      },
    };
  }

  function tuneIntent(): Record<string, unknown> {
    const task = tuneTask();
    return {
      schema: "openthrottle.tune-sealed-intent/v1",
      id: "intent_one",
      task,
      task_digest: validateTuneTaskContract(task).digest,
      sealed_at: "2026-08-12T00:01:00.000Z",
      authority_digest: "d".repeat(64),
    };
  }

  function corpusRow(): Record<string, unknown> {
    return {
      id: "row_one",
      pipeline_instance_id: "pipeline-1",
      generation: 5,
      graph_id: "structured",
      outcome: "failure",
      reason: "failure",
      created_at: "2026-08-11T00:00:00.000Z",
      artifact_digests: ["e".repeat(64)],
      row_digest: "f".repeat(64),
    };
  }

  it("accepts bounded command diagnostic tails and rejects oversized UTF-8 tails", () => {
    const receipt = JSON.parse(readFixture("valid", "receipt-unit-decision.json")) as Record<string, unknown>;
    receipt.type = "command_result";
    receipt.assurance = "executor_verified";
    receipt.result = "failure";
    receipt.producer = {
      worker_id: "executor",
      skill: "builtin://command@1",
      capability_digest: "e".repeat(64),
      skill_package_digest: null,
    };
    receipt.payload = {
      command: "test",
      exit_code: 1,
      summary: "Repository command test exited with 1.",
      stdout_digest: "a".repeat(64),
      stderr_digest: "b".repeat(64),
      stdout_tail: "AssertionError: expected 2 to equal 3",
      stderr_tail: "FAIL runner/command.test.mjs",
    };

    expect(validateStandardReceipt(receipt, { source: "command receipt" }).value.payload).toMatchObject({
      stdout_tail: "AssertionError: expected 2 to equal 3",
      stderr_tail: "FAIL runner/command.test.mjs",
    });
    expect(() => validateStandardReceipt({
      ...receipt,
      payload: { ...(receipt.payload as Record<string, unknown>), stdout_tail: "💥".repeat(129) },
    }, { source: "command receipt" })).toThrow(/stdout_tail: must contain at most 512 UTF-8 bytes/);
    for (const result of ["success", "not_configured"] as const) {
      for (const tailField of ["stdout_tail", "stderr_tail"] as const) {
        expect(() => validateStandardReceipt({
          ...receipt,
          result,
          payload: {
            command: "test",
            exit_code: 0,
            summary: "No failed command output.",
            [tailField]: "unexpected diagnostic tail",
          },
        }, { source: "command receipt" })).toThrow(/diagnostic tails are only valid for failed command receipts/);
      }
    }
  });

  it("keeps the committed repository bootstrap on all four npm projects", () => {
    const config = readFileSync(new URL("../../.openthrottle.yml", import.meta.url), "utf8");
    for (const project of ["contracts", "supervisor", "cli", "sandbox"]) {
      expect(config).toContain(`npm ci --prefix ${project}`);
    }
  });

  it("accepts and normalizes the frozen valid corpora", () => {
    const fixtures = [
      "config-repository.json",
      "citation-contract.json",
      "graph-structured.json",
      "execution-plan.json",
      "ratchet-contract.json",
      "receipt-unit-completion.json",
      "receipt-unit-decision.json",
      "receipt-repository-skill.json",
    ];

    for (const fixture of fixtures) {
      const raw = readFixture("valid", fixture);
      const validated = parseByName(fixture, raw) as { value: unknown; normalized: string; digest: string };
      expect(JSON.parse(validated.normalized)).toEqual(validated.value);
      expect(validated.digest).toBe(digestCanonicalJson(validated.value));
    }
  });

  it("validates tune proposals against the sealed intent fields, not digest equality alone", () => {
    const intent = tuneIntent();
    const task = intent.task as Record<string, unknown>;
    const proposal: Record<string, unknown> = {
      schema: "openthrottle.tune-proposal/v1",
      id: "proposal_one",
      intent,
      corpus_rows: [corpusRow()],
      corpus_digest: "1".repeat(64),
      target: structuredClone(task.target),
      query: structuredClone(task.query),
      scope: task.scope,
      window: structuredClone(task.window),
      baseline: structuredClone(task.baseline),
      policy: structuredClone(task.policy),
      outcome: "propose",
      changes: [{
        path: "skills/tasks/implement-unit/SKILL.md",
        operation: "modify",
        before_digest: "2".repeat(64),
        after_digest: "3".repeat(64),
        rationale: "Tighten bounded receipt guidance.",
      }],
      citation_contract_digest: "4".repeat(64),
      ratchet_contract_digest: "5".repeat(64),
    };

    expect(validateTuneSealedIntentContract(intent).digest).toBeTruthy();
    expect(validateTuneProposalContract(proposal).value.changes).toHaveLength(1);

    const mismatched = structuredClone(proposal);
    (mismatched.query as Record<string, unknown>).graph = "other_graph";
    expect(() => validateTuneProposalContract(mismatched, { source: "proposal" }))
      .toThrow(/proposal\.query: must match sealed intent query/);
  });

  it("rejects raw untyped prose in tune corpus rows and changes outside the sealed policy", () => {
    const intent = tuneIntent();
    const task = intent.task as Record<string, unknown>;
    const proposal: Record<string, unknown> = {
      schema: "openthrottle.tune-proposal/v1",
      id: "proposal_one",
      intent,
      corpus_rows: [{ ...corpusRow(), raw_ticket_text: "untrusted prose" }],
      corpus_digest: "1".repeat(64),
      target: structuredClone(task.target),
      query: structuredClone(task.query),
      scope: task.scope,
      window: structuredClone(task.window),
      baseline: structuredClone(task.baseline),
      policy: structuredClone(task.policy),
      outcome: "propose",
      changes: [],
      citation_contract_digest: "4".repeat(64),
      ratchet_contract_digest: "5".repeat(64),
    };

    expect(() => validateTuneProposalContract(proposal, { source: "proposal" }))
      .toThrow(/raw_ticket_text: unknown field/);
    proposal.corpus_rows = [corpusRow()];
    proposal.changes = [{
      path: "supervisor/src/index.ts",
      operation: "modify",
      before_digest: "2".repeat(64),
      after_digest: "3".repeat(64),
      rationale: "Outside authorized tune target.",
    }];
    expect(() => validateTuneProposalContract(proposal, { source: "proposal" }))
      .toThrow(/outside policy allow_edit_paths/);
  });

  it("requires claims and their dispositions to cite evidence", () => {
    const raw = readFixture("valid", "citation-contract.json");
    const proposal = JSON.parse(raw) as {
      claims: Array<{ citation_ids: string[] }>;
      dispositions: Array<{ citation_ids: string[] }>;
    };

    proposal.dispositions[0]!.citation_ids = [];
    expect(() => parseCitationContractProposal(JSON.stringify(proposal), { source: "proposal" }))
      .toThrow(/dispositions\[0\]\.citation_ids: must contain between 1 and 32 entries/);
  });

  it("returns stable ratchet rejection reasons for proposed-versus-pinned differences", () => {
    const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
      source: "ratchet",
    });
    const accepted = decideDifferentialRatchet(parsed.value);
    expect(accepted.outcome).toBe("accept");
    expect(accepted.reject_reasons).toEqual([]);
    expect(accepted.differences).toEqual([]);
    expect(validateRatchetDecision(accepted).digest).toBeTruthy();

    const changed = structuredClone(parsed.value);
    changed.proposed[0]!.artifact_digest = "f".repeat(64);
    changed.proposed[0]!.kind = "review";
    changed.proposed[0]!.provenance_digest = "e".repeat(64);
    changed.proposed.push({
      id: "extra_review",
      kind: "review",
      artifact_digest: "d".repeat(64),
      provenance_digest: "c".repeat(64),
    });
    changed.human_authority = null;

    expect(decideDifferentialRatchet(changed)).toMatchObject({
      outcome: "reject",
      reject_reasons: [
        "artifact_digest_changed",
        "artifact_kind_changed",
        "provenance_digest_changed",
        "missing_pinned_artifact",
        "human_authority_missing",
      ],
      differences: [
        { reason: "artifact_digest_changed", artifact_id: "unit_receipt" },
        { reason: "artifact_kind_changed", artifact_id: "unit_receipt" },
        { reason: "provenance_digest_changed", artifact_id: "unit_receipt" },
        { reason: "missing_pinned_artifact", artifact_id: "extra_review" },
        { reason: "human_authority_missing" },
      ],
    });
  });

  it("bounds complete ratchet differences while retaining every rejection reason", () => {
    const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
      source: "ratchet",
    });
    const bounded = structuredClone(parsed.value);
    bounded.pinned = Array.from({ length: 64 }, (_, index) => ({
      id: `pinned_${index}`,
      kind: "standard_receipt" as const,
      artifact_digest: "a".repeat(64),
      provenance_digest: "b".repeat(64),
    }));
    bounded.proposed = Array.from({ length: 64 }, (_, index) => ({
      id: `proposed_${index}`,
      kind: "review" as const,
      artifact_digest: "c".repeat(64),
      provenance_digest: "d".repeat(64),
    }));
    bounded.human_authority = null;
    bounded.tuner_authority = null;

    const decision = decideDifferentialRatchet(bounded);
    expect(decision.outcome).toBe("reject");
    expect(decision.differences).toHaveLength(128);
    expect(decision.reject_reasons).toEqual([
      "missing_proposed_artifact",
      "missing_pinned_artifact",
      "human_authority_missing",
      "tuner_authority_missing",
    ]);
    expect(decision.differences).toEqual(expect.arrayContaining([
      { reason: "human_authority_missing" },
      { reason: "tuner_authority_missing" },
    ]));
    expect(validateRatchetDecision(decision).value).toEqual(decision);
  });

  it("distinguishes human and tuner authority by actor identity, not unrelated digest roles", () => {
    const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
      source: "ratchet",
    });
    const sameDigest = structuredClone(parsed.value);
    sameDigest.human_authority!.approval_digest = sameDigest.tuner_authority!.proposal_digest;
    expect(decideDifferentialRatchet(sameDigest)).toMatchObject({
      outcome: "accept",
      reject_reasons: [],
    });

    const sameActor = structuredClone(parsed.value);
    sameActor.human_authority!.actor_id = sameActor.tuner_authority!.tuner_id;
    expect(decideDifferentialRatchet(sameActor)).toMatchObject({
      outcome: "reject",
      reject_reasons: ["authority_conflict"],
      differences: [{ reason: "authority_conflict" }],
    });
  });

  it("accepts monotonic repository config and graph policy shrinkage", () => {
    const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
      source: "ratchet",
    });
    const pinnedConfig = parseRepositoryConfigContract(readFixture("valid", "config-repository.json")).value;
    const proposedConfig = structuredClone(pinnedConfig);
    pinnedConfig.limits = { max_turns: 200, task_timeout: 7200 };
    proposedConfig.limits = { max_turns: 100, task_timeout: 3600 };
    pinnedConfig.mcp_servers = { github: { command: "mcp-github" } };
    proposedConfig.mcp_servers = {};
    proposedConfig.commands = {
      ...proposedConfig.commands,
      audit: "npm audit --audit-level high",
    };

    const pinnedGraph = parseGraphContract(readFixture("valid", "graph-structured.json"), {
      config: pinnedConfig,
    }).value;
    const proposedGraph = structuredClone(pinnedGraph);
    proposedGraph.workers[0]!.credentials = ["repo.read"];
    proposedGraph.loops[0]!.timeout_seconds = 1800;

    expect(decideDifferentialRatchet({
      ...parsed.value,
      pinned_config: pinnedConfig,
      proposed_config: proposedConfig,
      pinned_graph: pinnedGraph,
      proposed_graph: proposedGraph,
    })).toMatchObject({
      outcome: "accept",
      reject_reasons: [],
      differences: [],
    });
  });

  it("rejects non-monotonic config policy with stable reasons", () => {
    const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
      source: "ratchet",
    });
    const pinnedConfig = parseRepositoryConfigContract(readFixture("valid", "config-repository.json")).value;
    const proposedConfig = structuredClone(pinnedConfig);
    proposedConfig.limits = { max_turns: 201, task_timeout: 7201 };
    delete proposedConfig.commands!.test;
    delete proposedConfig.test;
    proposedConfig.mcp_servers = { github: { command: "mcp-github" } };

    const pinnedGraph = parseGraphContract(readFixture("valid", "graph-structured.json"), {
      config: pinnedConfig,
    }).value;
    const proposedGraph = structuredClone(pinnedGraph);
    proposedGraph.workers[0]!.credentials = ["repo.read", "model.invoke", "provider.read", "mcp"];
    proposedGraph.workers[0]!.allowed_mcp_servers = ["github"];
    proposedGraph.nodes[0]!.phases = proposedGraph.nodes[0]!.phases!.filter((phase) => phase.id !== "command");

    const decision = decideDifferentialRatchet({
      ...parsed.value,
      pinned_config: pinnedConfig,
      proposed_config: proposedConfig,
      pinned_graph: pinnedGraph,
      proposed_graph: proposedGraph,
    });

    expect(decision.outcome).toBe("reject");
    expect(decision.reject_reasons).toEqual(expect.arrayContaining([
      "credential_scope_expanded",
      "mcp_scope_expanded",
      "gate_weakened",
      "resource_limit_increased",
    ]));
    expect(decision.differences).toEqual(expect.arrayContaining([
      { reason: "resource_limit_increased", path: "config.limits.max_turns" },
      { reason: "resource_limit_increased", path: "config.limits.task_timeout" },
      { reason: "gate_weakened", path: "config.commands.test" },
      { reason: "mcp_scope_expanded", path: "config.mcp_servers.github" },
      { reason: "credential_scope_expanded", path: "graph.workers.implementer.credentials" },
      { reason: "mcp_scope_expanded", path: "graph.workers.implementer.allowed_mcp_servers" },
      { reason: "gate_weakened", path: "graph.nodes.implement.phases[1]" },
    ]));
    expect(validateRatchetDecision(decision).digest).toBeTruthy();
  });

  it("compares absent repository limits against their canonical runtime defaults", () => {
    const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
      source: "ratchet",
    });
    const pinnedConfig = parseRepositoryConfigContract(readFixture("valid", "config-repository.json")).value;
    delete pinnedConfig.limits;

    const monotonicConfig = structuredClone(pinnedConfig);
    monotonicConfig.limits = { max_turns: 100, task_timeout: 3_600 };
    expect(decideDifferentialRatchet({
      ...parsed.value,
      pinned_config: pinnedConfig,
      proposed_config: monotonicConfig,
    })).toMatchObject({ outcome: "accept", reject_reasons: [] });

    const increasedConfig = structuredClone(pinnedConfig);
    increasedConfig.limits = { max_turns: 201, task_timeout: 7_201 };
    expect(decideDifferentialRatchet({
      ...parsed.value,
      pinned_config: pinnedConfig,
      proposed_config: increasedConfig,
    })).toMatchObject({
      outcome: "reject",
      reject_reasons: ["resource_limit_increased"],
      differences: [
        { reason: "resource_limit_increased", path: "config.limits.max_turns" },
        { reason: "resource_limit_increased", path: "config.limits.task_timeout" },
      ],
    });
  });

  it("rejects unsupported timestamps and normalizes equivalent ISO offsets", () => {
    const raw = readFixture("valid", "citation-contract.json");
    const proposal = JSON.parse(raw) as {
      citations: Array<{
        query: { from?: string };
        expected_result: Array<{ created_at: string }>;
      }>;
    };

    for (const unsupported of [
      "2026",
      "2026-08-08",
      "08/08/2026",
      "0",
      "2026-02-30T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-08-08T24:00:00Z",
      "2026-08-08T00:00:00+24:00",
    ]) {
      proposal.citations[0]!.query.from = unsupported;
      expect(() => parseCitationContractProposal(JSON.stringify(proposal), { source: "proposal" }))
        .toThrow(/query\.from: must be an ISO-8601 timestamp/);
    }

    proposal.citations[0]!.query.from = "2026-08-08T02:00:00+0200";
    proposal.citations[0]!.expected_result[0]!.created_at = "2026-08-08T02:00:00+02:00";
    const parsed = parseCitationContractProposal(JSON.stringify(proposal), { source: "proposal" });
    expect(parsed.value.citations[0]!.query.from).toBe("2026-08-08T00:00:00.000Z");
    expect(parsed.value.citations[0]!.expected_result[0]!.created_at).toBe("2026-08-08T00:00:00.000Z");
  });

  it("rejects reversed citation windows after normalization while allowing equality", () => {
    const proposal = JSON.parse(readFixture("valid", "citation-contract.json")) as {
      citations: Array<{ query: { from?: string; to?: string } }>;
    };
    proposal.citations[0]!.query.from = "2026-08-08T03:00:00+02:00";
    proposal.citations[0]!.query.to = "2026-08-08T00:00:00Z";
    expect(() => parseCitationContractProposal(JSON.stringify(proposal), { source: "proposal" }))
      .toThrow(/query: from must not be later than to/);

    proposal.citations[0]!.query.from = "2026-08-08T02:00:00+02:00";
    const parsed = parseCitationContractProposal(JSON.stringify(proposal), { source: "proposal" });
    expect(parsed.value.citations[0]!.query).toMatchObject({
      from: "2026-08-08T00:00:00.000Z",
      to: "2026-08-08T00:00:00.000Z",
    });
  });

  it("rejects declared citations that no claim or disposition references", () => {
    const proposal = JSON.parse(readFixture("valid", "citation-contract.json")) as {
      citations: Array<Record<string, unknown>>;
    };
    proposal.citations.push({
      id: "orphan_citation",
      query: { outcome: "failed" },
      expected_result: [],
      source_digests: ["b".repeat(64)],
    });

    expect(() => parseCitationContractProposal(JSON.stringify(proposal), { source: "proposal" }))
      .toThrow(/citations\.orphan_citation: must be referenced by a claim or disposition/);
  });

  it("requires unique grades to cover every claim disposition", () => {
    const proposal = JSON.parse(readFixture("valid", "citation-contract.json")) as {
      claims: Array<Record<string, unknown>>;
      citations: Array<Record<string, unknown>>;
      dispositions: Array<Record<string, unknown>>;
      grades: Array<{ id: string; disposition_claim_ids: string[] }>;
    };
    proposal.grades[0]!.disposition_claim_ids = [];
    expect(() => parseCitationContractProposal(JSON.stringify(proposal), { source: "proposal" }))
      .toThrow(/grades\[0\]\.disposition_claim_ids: must contain between 1 and 64 entries/);

    proposal.claims.push({ id: "claim_two", text: "Second claim.", citation_ids: ["citation_two"] });
    proposal.citations.push({
      id: "citation_two",
      query: { outcome: "shipped" },
      expected_result: [],
      source_digests: ["b".repeat(64)],
    });
    proposal.dispositions.push({
      claim_id: "claim_two",
      disposition: "supported",
      rationale: "Second disposition.",
      citation_ids: ["citation_two"],
    });
    proposal.grades[0]!.disposition_claim_ids = ["claim_failed_agent_runs"];
    expect(() => parseCitationContractProposal(JSON.stringify(proposal), { source: "proposal" }))
      .toThrow(/grades: must include every claim disposition/);

    proposal.grades[0]!.disposition_claim_ids.push("claim_two");
    proposal.grades.push({ ...proposal.grades[0]!, disposition_claim_ids: ["claim_two"] });
    expect(() => parseCitationContractProposal(JSON.stringify(proposal), { source: "proposal" }))
      .toThrow(/grades: must not contain duplicate IDs/);
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
    (graph.nodes[0]!.phases as Array<{ id: string; kind: string; commands?: string[] }>).splice(1, 0, {
      id: "command",
      kind: "command",
      commands: ["missing"],
    });
    expect(() => parseGraphContract(JSON.stringify(graph), { source: "graph", config: config.value }))
      .toThrow(/nodes\.implement\.phases\[1\]\.commands: references an unknown repository command/);
    (graph.nodes[0]!.phases as unknown[]).splice(1, 1);
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
      skills?: Array<{ id: string; path: string; tunable?: boolean }>;
    };
    config.skills = [{ id: "implement_unit", path: ".openthrottle/skills/implement_unit", tunable: false }];
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

    graph.workers[0]!.skills = ["builtin://implement-unit@1"];
    graph.loops[0]!.skill = "builtin://implement-unit@1";
    graph.workers[1]!.skills = ["repo://accept_unit"];
    graph.loops[1]!.skill = "repo://accept_unit";
    config.skills = [{ id: "accept_unit", path: ".openthrottle/skills/accept_unit" }];
    const parsedGateConfig = parseRepositoryConfigContract(JSON.stringify(config), { source: "config" });
    expect(() => parseGraphContract(JSON.stringify(graph), { source: "graph", config: parsedGateConfig.value }))
      .not.toThrow();

    config.skills = [{ id: "bad", path: "../skills/bad" }];
    expect(() => parseRepositoryConfigContract(JSON.stringify(config), { source: "config" }))
      .toThrow(/config\.skills\[0\]\.path: has an invalid format/);

    config.skills = [{ id: "bad", path: ".openthrottle/skills/not-bad" }];
    expect(() => parseRepositoryConfigContract(JSON.stringify(config), { source: "config" }))
      .toThrow(/config\.skills\[0\]\.path: must be exactly \.openthrottle\/skills\/bad/);
  });

  it("lets the ratchet accept only craft and reference edits in tunable repository skills", () => {
    const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
      source: "ratchet",
    });
    const skill = {
      id: "implement_unit",
      tunable: true,
      files: [{
        path: ".openthrottle/skills/implement_unit/SKILL.md",
        content: [
          "---",
          "name: implement_unit",
          "description: Implements one unit",
          "---",
          "# Implement Unit",
          "## Authority Fence",
          "Do not commit.",
          "```json",
          "{\"schema\":\"openthrottle.receipt/v1\",\"type\":\"unit_completion\"}",
          "```",
          "## Craft",
          "Prefer the smallest correct increment.",
          "## Command Allowlist",
          "Allowed commands: test, build.",
        ].join("\n"),
      }, {
        path: ".openthrottle/skills/implement_unit/agents/openai.yaml",
        content: "tools: [shell]\n",
      }, {
        path: ".openthrottle/skills/implement_unit/references/method.md",
        content: "Original reference guidance.",
      }],
    };
    const proposedSkill = structuredClone(skill);
    proposedSkill.files[0]!.content = proposedSkill.files[0]!.content.replace(
      "Prefer the smallest correct increment.",
      "Prefer focused edits with evidence."
    );
    proposedSkill.files[2]!.content = "Updated reference guidance.";
    proposedSkill.files.push({
      path: ".openthrottle/skills/implement_unit/references/observations.md",
      content: "Additional reference guidance.",
    });

    expect(decideDifferentialRatchet({
      ...parsed.value,
      ...repositorySkillPolicy(true),
      pinned_repository_skills: [skill],
      proposed_repository_skills: [proposedSkill],
    })).toMatchObject({
      outcome: "accept",
      reject_reasons: [],
      differences: [],
    });
  });

  it.each([
    "```sh\ngit push origin main\n```\n",
    "Launch shellcheck across the repository.\n",
    "Issue `git push origin main`.\n",
    "    rm worktree\n",
    "     rm worktree\n",
    "        rm worktree\n",
    "\t  rm worktree\n",
    "> ```sh\n> rm worktree\n> ```\n",
    "-     rm worktree\n",
  ])("defense-in-depth rejects an obvious executable reference surface: %s", (guidance) => {
    const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
      source: "ratchet",
    });
    const skill = {
      id: "implement_unit",
      tunable: true,
      files: [{
        path: ".openthrottle/skills/implement_unit/SKILL.md",
        content: "---\nname: implement_unit\n---\n# Implement Unit\n## Craft\nWrite focused code.\n",
      }, {
        path: ".openthrottle/skills/implement_unit/references/method.md",
        content: "Prefer focused evidence.\n",
      }],
    };
    const proposed = structuredClone(skill);
    proposed.files[1]!.content = guidance;

    expect(decideDifferentialRatchet({
      ...parsed.value,
      ...repositorySkillPolicy(true),
      pinned_repository_skills: [skill],
      proposed_repository_skills: [proposed],
    })).toMatchObject({
      outcome: "reject",
      reject_reasons: ["skill_immutable_changed"],
      differences: [{
        reason: "skill_immutable_changed",
        path: "repository_skills.implement_unit.files..openthrottle/skills/implement_unit/references/method.md.executable_guidance_lint",
      }],
    });
  });

  it.each([" ", "  ", "   "])(
    "keeps a %s-space prose indent tunable because it is not an indented code block",
    (indent) => {
      const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
        source: "ratchet",
      });
      const skill = {
        id: "implement_unit",
        tunable: true,
        files: [{
          path: ".openthrottle/skills/implement_unit/SKILL.md",
          content: "---\nname: implement_unit\n---\n# Implement Unit\n## Craft\nPrefer focused evidence.\n",
        }, {
          path: ".openthrottle/skills/implement_unit/references/method.md",
          content: "Original reference guidance.\n",
        }],
      };
      const proposed = structuredClone(skill);
      proposed.files[1]!.content = `${indent}Additional reference guidance.\n`;

      expect(decideDifferentialRatchet({
        ...parsed.value,
        ...repositorySkillPolicy(true),
        pinned_repository_skills: [skill],
        proposed_repository_skills: [proposed],
      })).toMatchObject({ outcome: "accept", reject_reasons: [] });
    }
  );

  it("rejects locked repository skills and immutable skill policy edits", () => {
    const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
      source: "ratchet",
    });
    const skill = {
      id: "implement_unit",
      tunable: false,
      files: [{
        path: ".openthrottle/skills/implement_unit/SKILL.md",
        content: [
          "---",
          "name: implement_unit",
          "description: Implements one unit",
          "---",
          "# Implement Unit",
          "## Authority Fence",
          "Do not commit.",
          "## Craft",
          "Prefer the smallest correct increment.",
          "## Command Allowlist",
          "Allowed commands: test, build.",
        ].join("\n"),
      }, {
        path: ".openthrottle/skills/implement_unit/agents/openai.yaml",
        content: "tools: [shell]\n",
      }],
    };
    const lockedEdit = structuredClone(skill);
    lockedEdit.files[0]!.content = lockedEdit.files[0]!.content.replace("increment", "step");

    expect(decideDifferentialRatchet({
      ...parsed.value,
      ...repositorySkillPolicy(false),
      pinned_repository_skills: [skill],
      proposed_repository_skills: [lockedEdit],
    })).toMatchObject({
      outcome: "reject",
      reject_reasons: ["skill_locked"],
      differences: [{ reason: "skill_locked", path: "repository_skills.implement_unit" }],
    });

    const tunable = { ...skill, tunable: true };
    const proposed = structuredClone(tunable);
    proposed.tunable = false;
    proposed.files[0]!.content = proposed.files[0]!.content
      .replace("Do not commit.", "Commit when finished.")
      .replace("Allowed commands: test, build.", "Allowed commands: test.");
    proposed.files[1]!.content = "tools: [shell, network]\n";

    const decision = decideDifferentialRatchet({
      ...parsed.value,
      ...repositorySkillPolicy(true),
      pinned_repository_skills: [tunable],
      proposed_repository_skills: [proposed],
    });
    expect(decision.outcome).toBe("reject");
    expect(decision.reject_reasons).toEqual(["skill_immutable_changed"]);
    expect(decision.differences).toEqual(expect.arrayContaining([
      { reason: "skill_immutable_changed", path: "repository_skills.implement_unit.tunable" },
      { reason: "skill_immutable_changed", path: "repository_skills.implement_unit.SKILL.md.immutable_sections" },
      {
        reason: "skill_immutable_changed",
        path: "repository_skills.implement_unit.files..openthrottle/skills/implement_unit/agents/openai.yaml",
      },
    ]));
  });

  it("rejects repository skill edits with forbidden tokens or oversized files", () => {
    const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
      source: "ratchet",
    });
    const skill = {
      id: "implement_unit",
      tunable: true,
      files: [{
        path: ".openthrottle/skills/implement_unit/SKILL.md",
        content: "---\nname: implement_unit\n---\n# Implement Unit\n## Craft\nWrite code.\n",
      }],
    };
    const proposed = structuredClone(skill);
    proposed.files[0]!.content = proposed.files[0]!.content.replace("Write code.", "Call ce-work first.");
    proposed.files.push({
      path: ".openthrottle/skills/implement_unit/references/oversized.md",
      content: "a".repeat(64 * 1024 + 1),
    });

    const decision = decideDifferentialRatchet({
      ...parsed.value,
      ...repositorySkillPolicy(true),
      pinned_repository_skills: [skill],
      proposed_repository_skills: [proposed],
    });
    expect(decision.outcome).toBe("reject");
    expect(decision.reject_reasons).toEqual(expect.arrayContaining([
      "skill_bounds_exceeded",
      "skill_forbidden_token",
    ]));
  });

  it.each([
    "Call AskUserQuestion before editing.",
    "Invoke `mcp__github__create_issue` before editing.",
    "Run npm audit before editing.",
  ])("rejects a new interactive or command invocation in craft: %s", (instruction) => {
    const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
      source: "ratchet",
    });
    const skill = {
      id: "implement_unit",
      tunable: true,
      files: [{
        path: ".openthrottle/skills/implement_unit/SKILL.md",
        content: "---\nname: implement_unit\n---\n# Implement Unit\n## Craft\nWrite focused code.\n",
      }],
    };
    const proposed = structuredClone(skill);
    proposed.files[0]!.content = proposed.files[0]!.content.replace("Write focused code.", instruction);

    expect(decideDifferentialRatchet({
      ...parsed.value,
      ...repositorySkillPolicy(true),
      pinned_repository_skills: [skill],
      proposed_repository_skills: [proposed],
    })).toMatchObject({ outcome: "reject" });
  });

  it("keeps nested command and tool allowlist subsections immutable", () => {
    const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
      source: "ratchet",
    });
    const skill = {
      id: "implement_unit",
      tunable: true,
      files: [{
        path: ".openthrottle/skills/implement_unit/SKILL.md",
        content: [
          "---",
          "name: implement_unit",
          "---",
          "# Implement Unit",
          "## Craft",
          "Prefer focused edits.",
          "### Tool allowlist",
          "- shell",
          "- filesystem",
          "### Heuristics",
          "Keep patches small.",
        ].join("\n"),
      }],
    };
    const proposed = structuredClone(skill);
    proposed.files[0]!.content = proposed.files[0]!.content
      .replace("- filesystem", "- network")
      .replace("Keep patches small.", "Prefer cohesive patches.");

    expect(decideDifferentialRatchet({
      ...parsed.value,
      ...repositorySkillPolicy(true),
      pinned_repository_skills: [skill],
      proposed_repository_skills: [proposed],
    })).toMatchObject({
      outcome: "reject",
      reject_reasons: ["skill_immutable_changed"],
      differences: [{
        reason: "skill_immutable_changed",
        path: "repository_skills.implement_unit.SKILL.md.immutable_sections",
      }],
    });
  });

  it("keeps annotated canonical contract fences immutable inside craft sections", () => {
    const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
      source: "ratchet",
    });
    const skill = {
      id: "implement_unit",
      tunable: true,
      files: [{
        path: ".openthrottle/skills/implement_unit/SKILL.md",
        content: [
          "---",
          "name: implement_unit",
          "---",
          "# Implement Unit",
          "## Method",
          "```json openthrottle.receipt/v1",
          "{\"schema\":\"openthrottle.receipt/v1\",\"type\":\"unit_completion\"}",
          "```",
          "Tune this explanation.",
        ].join("\n"),
      }],
    };
    const proposed = structuredClone(skill);
    proposed.files[0]!.content = proposed.files[0]!.content
      .replace("unit_completion", "semantic_review")
      .replace("Tune this explanation.", "Prefer concise explanations.");

    expect(decideDifferentialRatchet({
      ...parsed.value,
      ...repositorySkillPolicy(true),
      pinned_repository_skills: [skill],
      proposed_repository_skills: [proposed],
    })).toMatchObject({
      outcome: "reject",
      reject_reasons: ["skill_immutable_changed"],
      differences: expect.arrayContaining([{
        reason: "skill_immutable_changed",
        path: "repository_skills.implement_unit.SKILL.md.canonical_contract_blocks",
      }]),
    });
  });

  it("binds package tunability to the exact repository config", () => {
    const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
      source: "ratchet",
    });
    const pinnedConfig = parseRepositoryConfigContract(readFixture("valid", "config-repository.json")).value;
    pinnedConfig.skills = [{
      id: "implement_unit",
      path: ".openthrottle/skills/implement_unit",
      tunable: false,
    }];
    const proposedConfig = structuredClone(pinnedConfig);
    const skill = {
      id: "implement_unit",
      tunable: true,
      files: [{
        path: ".openthrottle/skills/implement_unit/SKILL.md",
        content: "---\nname: implement_unit\n---\n# Implement Unit\n## Craft\nWrite code.\n",
      }],
    };
    const proposed = structuredClone(skill);
    proposed.files[0]!.content = proposed.files[0]!.content.replace("Write code.", "Write focused code.");

    expect(decideDifferentialRatchet({
      ...parsed.value,
      pinned_config: pinnedConfig,
      proposed_config: proposedConfig,
      pinned_repository_skills: [skill],
      proposed_repository_skills: [proposed],
    })).toMatchObject({
      outcome: "reject",
      reject_reasons: ["skill_immutable_changed"],
      differences: [{
        reason: "skill_immutable_changed",
        path: "repository_skills.implement_unit.tunable_binding",
      }],
    });
  });

  it("rejects skill policy without sealed config authority and package paths outside their skill", () => {
    const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
      source: "ratchet",
    });
    const skill = {
      id: "implement_unit",
      tunable: true,
      files: [{
        path: ".openthrottle/skills/implement_unit/SKILL.md",
        content: "---\nname: implement_unit\n---\n# Implement Unit\n## Craft\nWrite code.\n",
      }],
    };
    const proposed = structuredClone(skill);
    proposed.files[0]!.content = proposed.files[0]!.content.replace("Write code.", "Write focused code.");

    expect(decideDifferentialRatchet({
      ...parsed.value,
      pinned_repository_skills: [skill],
      proposed_repository_skills: [proposed],
    })).toMatchObject({
      outcome: "reject",
      reject_reasons: ["skill_immutable_changed"],
      differences: [{
        reason: "skill_immutable_changed",
        path: "repository_skills.tunable_binding",
      }],
    });

    const escaped = structuredClone(proposed);
    escaped.files.push({
      path: ".openthrottle/skills/another_skill/references/injected.md",
      content: "Injected reference.",
    });
    expect(() => decideDifferentialRatchet({
      ...parsed.value,
      ...repositorySkillPolicy(true),
      pinned_repository_skills: [skill],
      proposed_repository_skills: [escaped],
    })).toThrow(/must stay within \.openthrottle\/skills\/implement_unit/);
  });

  it.each([
    ["missing", "name: implement_unit\n## Craft\nWrite code.\n"],
    ["unterminated", "---\nname: implement_unit\n## Craft\nWrite code.\n"],
  ])("rejects %s proposed skill frontmatter without throwing", (_label, proposedContent) => {
    const parsed = parseRatchetDifferentialInput(readFixture("valid", "ratchet-contract.json"), {
      source: "ratchet",
    });
    const skill = {
      id: "implement_unit",
      tunable: true,
      files: [{
        path: ".openthrottle/skills/implement_unit/SKILL.md",
        content: "---\nname: implement_unit\n---\n# Implement Unit\n## Craft\nWrite code.\n",
      }],
    };
    const proposed = structuredClone(skill);
    proposed.files[0]!.content = proposedContent;

    expect(decideDifferentialRatchet({
      ...parsed.value,
      ...repositorySkillPolicy(true),
      pinned_repository_skills: [skill],
      proposed_repository_skills: [proposed],
    })).toMatchObject({
      outcome: "reject",
      reject_reasons: ["skill_immutable_changed"],
      differences: expect.arrayContaining([{
        reason: "skill_immutable_changed",
        path: "repository_skills.implement_unit.SKILL.md.frontmatter",
      }]),
    });
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
