import type Database from "better-sqlite3";
import { parseStandardReceipt } from "@openthrottle/contracts";
import { canonicalJson } from "../../pipeline/manifest.js";
import type {
  CoordinatorTransitionWrite,
  PipelineInstance,
  PipelineStageAttempt,
  RunOutcome,
} from "../../pipeline/store.js";
import { getLatestExecutionGraphForInstance } from "./unit-store.js";

export interface RunOutcomeStore {
  /** Called once, from within applyTransition's transaction, when write.terminalOutcome is set. */
  recordSettlement(
    instance: PipelineInstance,
    attempt: PipelineStageAttempt,
    write: CoordinatorTransitionWrite,
    timestamp: string
  ): void;
  getRunOutcome(pipelineInstanceId: string): RunOutcome | undefined;
  pruneRunOutcomes(beforeIso: string): number;
}

interface SkillDigest {
  skill: string;
  skill_package_digest: string | null;
}

export function createRunOutcomeStore(db: Database.Database): RunOutcomeStore {
  const runFaultStmt = db.prepare("SELECT fault_attribution FROM runs WHERE id = ?");
  const unitRepairRoundsStmt = db.prepare(
    "SELECT unit_id, repair_rounds FROM execution_units WHERE execution_graph_id = ?"
  );
  const stageAttemptSpansStmt = db.prepare(`
    SELECT stage_id, started_at, completed_at FROM pipeline_stage_attempts
    WHERE pipeline_instance_id = ? AND started_at IS NOT NULL AND completed_at IS NOT NULL
  `);
  const runCostSumStmt = db.prepare(`
    SELECT COALESCE(SUM(r.cost_usd), 0) AS total
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
    INSERT OR IGNORE INTO run_outcomes (
      pipeline_instance_id, linear_issue_id, generation, execution_graph_id, plan_digest,
      base_commit, engine, outcome, closed_reason, fault_attribution, generations_consumed,
      repair_rounds_by_unit, phase_durations_ms, token_cost_usd, skill_digests, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getStmt = db.prepare("SELECT * FROM run_outcomes WHERE pipeline_instance_id = ?");
  const pruneStmt = db.prepare("DELETE FROM run_outcomes WHERE created_at < ?");

  return {
    recordSettlement(instance, attempt, write, timestamp) {
      if (!write.terminalOutcome) return;
      const fault = attempt.run_id
        ? (runFaultStmt.get(attempt.run_id) as { fault_attribution: RunOutcome["fault_attribution"] } | undefined)
        : undefined;
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

      const costRow = runCostSumStmt.get(instance.id) as { total: number };

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
        instance.linear_issue_id,
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
