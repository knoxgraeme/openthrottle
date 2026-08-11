import type Database from "better-sqlite3";
import { parseStandardReceipt } from "@openthrottle/contracts";
import { canonicalJson, PIPELINE_OUTCOMES, STAGE_OUTCOMES } from "../../pipeline/manifest.js";
import { FAULT_ATTRIBUTIONS } from "../../pipeline/fault-attribution.js";
import type {
  CoordinatorTransitionWrite,
  PipelineInstance,
  PipelineStageAttempt,
  RunOutcome,
} from "../../pipeline/store.js";
import { getLatestExecutionGraphForInstance } from "./unit-store.js";

export interface RunOutcomeStore {
  /**
   * Called once per pipeline instance, at its terminal transition: either
   * applyTransition's normal settlement (persistence/pipeline/transition-store.ts,
   * within its own db.transaction) or supersedeOtherInstances' fencing of a
   * superseded generation (persistence/pipeline/instance-store.ts, within its
   * own separate db.transaction). `attempt` is undefined when the superseded
   * instance had no dispatchable/running attempt at fencing time.
   */
  recordSettlement(
    instance: PipelineInstance,
    attempt: PipelineStageAttempt | undefined,
    write: Pick<CoordinatorTransitionWrite, "terminalOutcome" | "outcome">,
    timestamp: string
  ): void;
  getRunOutcome(pipelineInstanceId: string): RunOutcome | undefined;
  pruneRunOutcomes(beforeIso: string): number;
}

interface SkillDigest {
  skill: string;
  skill_package_digest: string | null;
}

// No shared runtime vocabulary exists for this union elsewhere in the
// codebase (every other call site inlines the same literal union as a type,
// e.g. pipeline/types.ts's `Agent` type); exported so migrations/
// runner.test.ts can cross-check it against run_outcomes.engine's CHECK
// constraint the same way it does for PIPELINE_OUTCOMES/STAGE_OUTCOMES/
// FAULT_ATTRIBUTIONS.
export const ENGINES = ["claude", "codex", "opencode"] as const;

export function createRunOutcomeStore(db: Database.Database): RunOutcomeStore {
  const runFaultStmt = db.prepare("SELECT fault_attribution FROM runs WHERE id = ?");
  const unitRepairRoundsStmt = db.prepare(
    "SELECT unit_id, repair_rounds FROM execution_units WHERE execution_graph_id = ?"
  );
  const stageAttemptSpansStmt = db.prepare(`
    SELECT stage_id, started_at, completed_at FROM pipeline_stage_attempts
    WHERE pipeline_instance_id = ? AND started_at IS NOT NULL AND completed_at IS NOT NULL
  `);
  // No production path stamps runs.cost_usd yet (real cost plumbing is
  // out of scope here), so SUM legitimately returns NULL -- never coalesced
  // to a fabricated 0 -- until a real producer starts reporting cost.
  const runCostSumStmt = db.prepare(`
    SELECT SUM(r.cost_usd) AS total
    FROM runs r
    JOIN pipeline_stage_attempts a ON a.run_id = r.id
    WHERE a.pipeline_instance_id = ?
  `);
  // No DISTINCT: skillDigests below already dedupes by (skill, digest), so a
  // SQL-level DISTINCT over the full receipt TEXT blob would add a sort/
  // compare pass across every row without reducing the row count in
  // practice -- each receipt carries per-attempt metadata, so exact text
  // matches are effectively unheard of.
  const receiptsStmt = db.prepare(`
    SELECT receipt FROM execution_work_attempts
    WHERE pipeline_instance_id = ? AND receipt IS NOT NULL
  `);
  const insertStmt = db.prepare(`
    INSERT INTO run_outcomes (
      pipeline_instance_id, ticket_id, generation, execution_graph_id, plan_digest,
      base_commit, engine, outcome, closed_reason, fault_attribution, generations_consumed,
      repair_rounds_by_unit, phase_durations_ms, token_cost_usd, skill_digests, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getStmt = db.prepare("SELECT * FROM run_outcomes WHERE pipeline_instance_id = ?");
  const pruneStmt = db.prepare("DELETE FROM run_outcomes WHERE created_at < ?");

  return {
    recordSettlement(instance, attempt, write, timestamp) {
      if (!write.terminalOutcome) return;
      // PK idempotency, made explicit instead of leaning on INSERT OR IGNORE:
      // that statement form ignores every constraint violation, not just the
      // primary-key replay this guards, so a CHECK/NOT-NULL violation from
      // vocabulary drift would otherwise vanish the same way -- the exact
      // silent row-drop this corpus exists to prevent. Recorded exactly once.
      const existing = getStmt.get(instance.id) as RunOutcome | undefined;
      if (existing) {
        // An Issue close can race the exact pull-request merge webhook. The
        // coordinator permits only that cryptographically fenced
        // canceled->shipped correction; keep the learning corpus aligned
        // with the final provider fact instead of permanently recording the
        // transient cancellation.
        if (existing.outcome === "canceled" && write.terminalOutcome === "shipped") {
          db.prepare(`
            UPDATE run_outcomes
            SET outcome = 'shipped', closed_reason = ?, created_at = ?
            WHERE pipeline_instance_id = ? AND outcome = 'canceled'
          `).run(write.outcome, timestamp, instance.id);
        }
        return;
      }
      const fault = attempt?.run_id
        ? (runFaultStmt.get(attempt.run_id) as { fault_attribution: RunOutcome["fault_attribution"] } | undefined)
        : undefined;
      // write.terminalOutcome/write.outcome/instance.agent are TS-typed to
      // closed enums, but that is load-bearing only at the call site -- a
      // future caller built from less-trusted data (a cast, a new producer,
      // or -- for engine -- a legacy row backfilled by
      // migrations/definitions.ts's backfillPipelineExecutionIdentity from a
      // NULL/missing ticket) would otherwise fail only at the DB CHECK
      // constraint, an opaque SqliteError naming neither field nor value
      // (same rationale as insertGateReceipt's GATE_RECEIPT_REASONS check).
      // This is measurement data, not a pipeline-correctness gate, so
      // failing here is a warn-and-skip (like the receipt-parse failure
      // below) rather than a throw that would abort the caller's
      // transaction -- which, for both call sites, already committed the
      // real terminal_outcome/state_version write -- over a corpus-only
      // concern. fault_attribution is the only nullable column of the four
      // (null legitimately means "not a fault"); outcome/closed_reason/engine
      // are all NOT NULL, so a null there -- e.g. a legacy pipeline_instances
      // row whose `agent` a correlated backfill left NULL -- must warn-and-skip
      // exactly like an unrecognized value would, not be waved through.
      const vocabularyChecks: Array<{ label: string; value: string | null; vocab: readonly string[]; nullable?: true }> = [
        { label: "outcome", value: write.terminalOutcome, vocab: PIPELINE_OUTCOMES },
        { label: "closed_reason", value: write.outcome, vocab: STAGE_OUTCOMES },
        { label: "engine", value: instance.agent, vocab: ENGINES },
        { label: "fault_attribution", value: fault?.fault_attribution ?? null, vocab: FAULT_ATTRIBUTIONS, nullable: true },
      ];
      for (const check of vocabularyChecks) {
        if (check.value === null) {
          if (check.nullable) continue;
          console.warn(`[run-outcome-store] skipped settlement for ${instance.id}: missing ${check.label}`);
          return;
        }
        if (!check.vocab.includes(check.value)) {
          console.warn(`[run-outcome-store] skipped settlement for ${instance.id}: unrecognized ${check.label} ${JSON.stringify(check.value)}`);
          return;
        }
      }
      const graph = getLatestExecutionGraphForInstance(db, instance.id);

      const repairRoundsByUnit = graph
        ? Object.fromEntries(
            (unitRepairRoundsStmt.all(graph.id) as Array<{ unit_id: string; repair_rounds: number }>).map(
              (row) => [row.unit_id, row.repair_rounds]
            )
          )
        : {};

      const phaseDurationsMs: Record<string, number> = {};
      for (const row of stageAttemptSpansStmt.all(instance.id) as Array<{
        stage_id: string;
        started_at: string;
        completed_at: string;
      }>) {
        const durationMs = Date.parse(row.completed_at) - Date.parse(row.started_at);
        if (Number.isFinite(durationMs) && durationMs >= 0) {
          phaseDurationsMs[row.stage_id] = (phaseDurationsMs[row.stage_id] ?? 0) + durationMs;
        }
      }

      const costRow = runCostSumStmt.get(instance.id) as { total: number | null };

      // Parsed via the same contract-validated parser every other receipt
      // reader uses (structured-child-runtime.ts), instead of an ad hoc
      // shape cast, so a receipt-contract change is caught here too. Every
      // persisted receipt was already validated by this exact parser before
      // it was written (unit-store-phase-reducer.ts's insertGateReceipt/
      // markActionCompleted path), so failure is not expected -- the
      // try/catch is defense-in-depth against a row this reader shouldn't
      // have to trust blindly, not a normal-path branch.
      const skillDigests = new Map<string, SkillDigest>();
      for (const row of receiptsStmt.all(instance.id) as Array<{ receipt: string }>) {
        let producer: { skill: string; skill_package_digest: string | null } | undefined;
        try {
          producer = parseStandardReceipt(row.receipt, {
            source: `run_outcomes.${instance.id}.receipt`,
          }).value.producer;
        } catch (error) {
          // Measurement data, not correctness-critical: skip the row rather
          // than abort the settlement transaction, but warn since a silently
          // shrinking skill_digests defeats this column's stated purpose
          // (making skill tuning measurable) with no other observable signal.
          console.warn(`[run-outcome-store] skipped an unparseable receipt for ${instance.id}:`, error);
          continue;
        }
        skillDigests.set(`${producer.skill}\0${producer.skill_package_digest ?? ""}`, {
          skill: producer.skill,
          skill_package_digest: producer.skill_package_digest,
        });
      }

      insertStmt.run(
        instance.id,
        instance.ticket_id,
        instance.generation,
        graph?.id ?? null,
        graph?.plan_digest ?? null,
        instance.base_commit,
        instance.agent,
        write.terminalOutcome,
        write.outcome,
        fault?.fault_attribution ?? null,
        instance.generation,
        canonicalJson(repairRoundsByUnit),
        canonicalJson(phaseDurationsMs),
        costRow.total,
        canonicalJson([...skillDigests.values()]),
        timestamp
      );
    },
    getRunOutcome(pipelineInstanceId) {
      return getStmt.get(pipelineInstanceId) as RunOutcome | undefined;
    },
    pruneRunOutcomes(beforeIso) {
      return pruneStmt.run(beforeIso).changes as number;
    },
  };
}
