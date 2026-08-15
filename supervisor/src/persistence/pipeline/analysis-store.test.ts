import {
  ANALYSIS_QUERY_ATTRIBUTIONS,
  ANALYSIS_QUERY_OUTCOMES,
  ANALYSIS_QUERY_REASONS,
} from "@openthrottle/contracts";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { setupPipelineStore, ticket } from "../../__fixtures__/pipeline-store.js";
import { FAULT_ATTRIBUTIONS } from "../../pipeline/fault-attribution.js";
import { PIPELINE_OUTCOMES, STAGE_OUTCOMES } from "../../pipeline/manifest.js";
import type { PipelineInstance } from "../../pipeline/store.js";
import { createAnalysisStore } from "./analysis-store.js";

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

const TS = "2026-08-08T00:00:00.000Z";

// Reuses the shared pipeline-store fixture (already exercised by
// instance-store.test.ts et al.) instead of hand-rolling the FK-satisfying
// tickets/agent_sessions/repository_config_snapshots/pipeline_instances rows
// run-outcome-store.test.ts's own local seedInstance duplicates elsewhere.
function seedInstance(setup: ReturnType<typeof setupPipelineStore>, sessionId: string): PipelineInstance {
  const manifest = setup.catalog.manifests.get("fixture/command@1")!;
  setup.tickets.upsert({
    ...ticket(sessionId),
    pipeline: {
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      manifest,
      repositoryConfig: setup.snapshot,
      runtime: setup.runtime,
      authorizedCapabilities: manifest.manifest.requires.capabilities,
      taskType: "implement" as const,
    },
  });
  return setup.pipelines.getInstanceForSession(sessionId)!;
}

function seedRunOutcome(
  database: Database.Database,
  instance: PipelineInstance,
  overrides: {
    outcome?: string;
    closedReason?: string;
    faultAttribution?: string | null;
    executionGraphId?: string | null;
    skillDigests?: Array<{ skill: string; skill_package_digest: string | null }>;
    createdAt?: string;
  } = {}
): void {
  database.prepare(`
    INSERT INTO run_outcomes (
      pipeline_instance_id, ticket_id, generation, execution_graph_id, plan_digest,
      base_commit, engine, outcome, closed_reason, fault_attribution, generations_consumed,
      repair_rounds_by_unit, phase_durations_ms, token_cost_usd, skill_digests, created_at
    ) VALUES (?, ?, 1, ?, NULL, '${"a".repeat(40)}', 'claude', ?, ?, ?, 1, '{}', '{}', NULL, ?, ?)
  `).run(
    instance.id,
    instance.ticket_id,
    overrides.executionGraphId ?? null,
    overrides.outcome ?? "shipped",
    overrides.closedReason ?? "success",
    overrides.faultAttribution ?? null,
    JSON.stringify(overrides.skillDigests ?? []),
    overrides.createdAt ?? TS
  );
}

describe("analysis store", () => {
  it("filters run_outcomes by outcome, reason, attribution, graph, and skill digest", () => {
    const setup = setupPipelineStore();
    db = setup.db;
    const instance1 = seedInstance(setup, "session-1");
    const instance2 = seedInstance(setup, "session-2");
    seedRunOutcome(db, instance1, {
      outcome: "shipped",
      closedReason: "success",
      executionGraphId: "graph-1",
      skillDigests: [{ skill: "builtin://ce/implement@1", skill_package_digest: null }],
    });
    seedRunOutcome(db, instance2, {
      outcome: "failed",
      closedReason: "failure",
      faultAttribution: "provider",
      executionGraphId: "graph-2",
      skillDigests: [{ skill: "builtin://final-review@1", skill_package_digest: "e".repeat(64) }],
    });

    const store = createAnalysisStore(db);

    expect(store.listRunOutcomes({ outcome: "shipped" }).map((r) => r.pipeline_instance_id)).toEqual([instance1.id]);
    expect(store.listRunOutcomes({ reason: "failure" }).map((r) => r.pipeline_instance_id)).toEqual([instance2.id]);
    expect(store.listRunOutcomes({ attribution: "provider" }).map((r) => r.pipeline_instance_id)).toEqual([instance2.id]);
    expect(store.listRunOutcomes({ graph: "graph-1" }).map((r) => r.pipeline_instance_id)).toEqual([instance1.id]);
    expect(store.listRunOutcomes({ skillDigest: "builtin://final-review@1" }).map((r) => r.pipeline_instance_id)).toEqual([instance2.id]);
    // The filter must match the actual 64-char skill_package_digest too, not
    // just the skill identifier -- a caller distinguishing repository skill
    // versions has no other way to ask "which runs used exactly this
    // package" (PR #156 review).
    expect(store.listRunOutcomes({ skillDigest: "e".repeat(64) }).map((r) => r.pipeline_instance_id)).toEqual([instance2.id]);
    expect(store.listRunOutcomes({}).map((r) => r.pipeline_instance_id).sort()).toEqual([instance1.id, instance2.id].sort());
  });

  it("filters run_outcomes by an inclusive created_at time range", () => {
    const setup = setupPipelineStore();
    db = setup.db;
    const instance1 = seedInstance(setup, "session-1");
    const instance2 = seedInstance(setup, "session-2");
    seedRunOutcome(db, instance1, { createdAt: "2026-08-01T00:00:00.000Z" });
    seedRunOutcome(db, instance2, { createdAt: "2026-08-08T00:00:00.000Z" });

    const store = createAnalysisStore(db);

    expect(
      store.listRunOutcomes({ from: "2026-08-05T00:00:00.000Z" }).map((r) => r.pipeline_instance_id)
    ).toEqual([instance2.id]);
    expect(
      store.listRunOutcomes({ to: "2026-08-05T00:00:00.000Z" }).map((r) => r.pipeline_instance_id)
    ).toEqual([instance1.id]);

    // The ISO-8601 basic offset form (no colon) is just as unambiguous as the
    // extended form above and Date.parse itself already accepts it -- the
    // shape check must not reject it here while /status/journal accepts it;
    // both endpoints now validate through the shared query-filters.ts
    // (PR #158 review: the hand-copied regexes had diverged on exactly this).
    expect(
      store.listRunOutcomes({ from: "2026-08-05T02:00:00+0200" }).map((r) => r.pipeline_instance_id)
    ).toEqual([instance2.id]);
    expect(
      store.listRunOutcomes({ to: "2026-08-05T02:00:00+0200" }).map((r) => r.pipeline_instance_id)
    ).toEqual([instance1.id]);
  });

  it("clamps an oversized limit to the query cap and keeps at least one row", () => {
    const setup = setupPipelineStore();
    db = setup.db;
    const instance1 = seedInstance(setup, "session-1");
    seedRunOutcome(db, instance1);

    const store = createAnalysisStore(db);

    expect(store.listRunOutcomes({ limit: 100_000 })).toHaveLength(1);
    expect(store.listRunOutcomes({ limit: 0 })).toHaveLength(1);
  });

  it("rejects a non-safe-integer limit instead of silently falling back to the default", () => {
    // Every other filter on this endpoint fails closed on a malformed value;
    // `Number("abc")`/`Number("Infinity")`/`Number("1.5")` all reach here as
    // a non-safe-integer number, and previously fell back to the 200-row
    // default silently instead (PR #156 follow-up review).
    db = setupPipelineStore().db;
    const store = createAnalysisStore(db);

    expect(() => store.listRunOutcomes({ limit: Number.NaN })).toThrow(/limit must be a safe integer/);
    expect(() => store.listRunOutcomes({ limit: Number.POSITIVE_INFINITY })).toThrow(/limit must be a safe integer/);
    expect(() => store.listRunOutcomes({ limit: 1.5 })).toThrow(/limit must be a safe integer/);
  });

  it("rejects an unrecognized outcome, reason, or attribution instead of silently matching nothing", () => {
    db = setupPipelineStore().db;
    const store = createAnalysisStore(db);

    expect(() => store.listRunOutcomes({ outcome: "not_a_real_outcome" })).toThrow(/outcome must be one of/);
    expect(() => store.listRunOutcomes({ reason: "not_a_real_reason" })).toThrow(/reason must be one of/);
    expect(() => store.listRunOutcomes({ attribution: "not_a_real_attribution" })).toThrow(/attribution must be one of/);
  });

  // The CLI rejects --outcome/--reason/--attribution locally against the
  // contracts vocabularies (cli/src/analysis.ts), while this store validates
  // the same three params against the supervisor-owned ones. The two lists
  // share no source, so a value added here bottom-up per incident (see
  // fault-attribution.ts) would otherwise make `openthrottle analysis` exit 1
  // on a filter the endpoint serves fine -- same must-pin shape as the
  // run_outcomes CHECK vocabularies in migrations/runner.test.ts.
  it.each([
    ["outcome", ANALYSIS_QUERY_OUTCOMES, PIPELINE_OUTCOMES],
    ["reason", ANALYSIS_QUERY_REASONS, STAGE_OUTCOMES],
    ["attribution", ANALYSIS_QUERY_ATTRIBUTIONS, FAULT_ATTRIBUTIONS],
  ] as const)("keeps the %s filter vocabulary in sync with the contracts vocabulary the CLI filters on", (
    _field,
    contractVocabulary,
    supervisorVocabulary
  ) => {
    expect(new Set(contractVocabulary)).toEqual(new Set(supervisorVocabulary));
    expect(contractVocabulary).toHaveLength(supervisorVocabulary.length);
  });

  it("accepts every value the CLI's contracts vocabularies allow through the filter flags", () => {
    // Set equality above is the structural proof; this is the behavioral one --
    // every value the CLI will let an operator type reaches a real query
    // instead of throwing "must be one of".
    db = setupPipelineStore().db;
    const store = createAnalysisStore(db);

    for (const outcome of ANALYSIS_QUERY_OUTCOMES) {
      expect(store.listRunOutcomes({ outcome })).toEqual([]);
    }
    for (const reason of ANALYSIS_QUERY_REASONS) {
      expect(store.listRunOutcomes({ reason })).toEqual([]);
    }
    for (const attribution of ANALYSIS_QUERY_ATTRIBUTIONS) {
      expect(store.listRunOutcomes({ attribution })).toEqual([]);
    }
  });

  it("rejects a malformed time filter", () => {
    db = setupPipelineStore().db;
    const store = createAnalysisStore(db);

    expect(() => store.listRunOutcomes({ from: "not-a-date" })).toThrow(/from must be an ISO-8601 timestamp/);
    expect(() => store.listRunOutcomes({ to: "not-a-date" })).toThrow(/to must be an ISO-8601 timestamp/);
  });

  it("rejects a value Date.parse would loosely accept but that is not ISO-8601 shaped", () => {
    // Date.parse's non-standard fallback parser accepts both of these
    // (`0` -> epoch, `08/08/2026` -> a valid local date), so relying on
    // Date.parse alone would silently query an unintended time range
    // instead of failing closed (PR #156 review).
    db = setupPipelineStore().db;
    const store = createAnalysisStore(db);

    expect(() => store.listRunOutcomes({ from: "0" })).toThrow(/from must be an ISO-8601 timestamp/);
    expect(() => store.listRunOutcomes({ from: "08/08/2026" })).toThrow(/from must be an ISO-8601 timestamp/);
    expect(() => store.listRunOutcomes({ to: "2026-08-08" })).toThrow(/to must be an ISO-8601 timestamp/);
    expect(() => store.listRunOutcomes({ to: "2026-02-30T00:00:00Z" }))
      .toThrow(/to must be an ISO-8601 timestamp/);
    expect(store.listRunOutcomes({ from: "2026-08-08T00:00:00.000Z" })).toEqual([]);
    expect(store.listRunOutcomes({ from: "2026-08-08T00:00:00+00:00" })).toEqual([]);
    expect(store.listRunOutcomes({ from: "2026-08-08T00:00:00+0000" })).toEqual([]);
  });
});
