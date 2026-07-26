import type Database from "better-sqlite3";
import type {
  PipelineEffectIntent,
  PipelineInstance,
  PipelinePublicationReceipt,
  PipelineStageAttempt,
  PipelineStatusProjection,
  PipelineStore,
} from "../../pipeline/store.js";
import { sanitizeText } from "../../shared/sanitize.js";

function boundedStatusError(value: string | null | undefined): string | null {
  if (!value) return null;
  return sanitizeText(value).slice(0, 500);
}

function whoseMove(
  status: PipelineInstance["status"],
  terminalOutcome: PipelineInstance["terminal_outcome"]
): PipelineStatusProjection["whose_move"] {
  if (status === "waiting_human" || status === "publication_blocked") return "waiting on you";
  if (status === "waiting_provider") return "waiting on GitHub";
  if (terminalOutcome !== null || ["shipped", "no_change", "needs_human", "canceled", "superseded", "failed"].includes(status)) {
    return "finished";
  }
  return "working";
}

function publicationStateFor(
  publications: PipelinePublicationReceipt[],
  instanceStatus: PipelineInstance["status"]
): PipelineStatusProjection["publication_state"] {
  if (publications.some((item) => item.status === "dead") || instanceStatus === "publication_blocked") {
    return "blocked";
  }
  if (publications.some((item) => item.status === "failed")) return "failed";
  if (publications.some((item) => item.status === "pending" || item.status === "processing")) return "pending";
  if (publications.some((item) => item.status === "acknowledged")) return "acknowledged";
  return "none";
}

function effectStateFor(effects: PipelineEffectIntent[]): PipelineStatusProjection["effect_state"] {
  if (effects.some((item) => item.status === "dead")) return "blocked";
  if (effects.some((item) => item.status === "failed")) return "failed";
  if (effects.some((item) => item.status === "pending" || item.status === "processing")) return "pending";
  return "none";
}

function gateErrorMessage(
  failedGate: {
    evaluator_kind: string;
    payload: string | null;
    artifact_payload: string | null;
  } | undefined
): string | null {
  if (!failedGate) return null;
  for (const payload of [failedGate.artifact_payload, failedGate.payload]) {
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as { summary?: unknown; outcome?: unknown; result?: unknown };
      if (typeof parsed.summary === "string" && parsed.summary.length > 0) return parsed.summary;
      if (typeof parsed.outcome === "string") return `${failedGate.evaluator_kind} gate failed: ${parsed.outcome}`;
      if (typeof parsed.result === "string") return `${failedGate.evaluator_kind} gate failed: ${parsed.result}`;
    } catch {
      // Try the next payload form.
    }
  }
  return `${failedGate.evaluator_kind} gate failed`;
}

function newestStatusError(
  newestEffect: (PipelineEffectIntent & { status_sort_at: string }) | undefined,
  failedGate: { created_at: string } | undefined,
  gateError: string | null
): string | null {
  if (!newestEffect) return gateError;
  if (!failedGate) return newestEffect.last_error;
  return Date.parse(newestEffect.status_sort_at) >= Date.parse(failedGate.created_at)
    ? newestEffect.last_error
    : gateError;
}

export function createStatusStore(db: Database.Database): Pick<PipelineStore, "getStatusForIssue"> {
  return {
    getStatusForIssue(issueId: string): PipelineStatusProjection | undefined {
      const instance = db.prepare(`
        SELECT pi.* FROM session_executions se
        JOIN pipeline_instances pi ON pi.id = se.pipeline_instance_id
        JOIN tickets t ON t.linear_session_id = se.linear_session_id
        WHERE t.linear_issue_id = ? AND se.execution_mode = 'pipeline'
      `).get(issueId) as PipelineInstance | undefined;
      if (!instance) return undefined;
      const attempt = db.prepare(`
        SELECT * FROM pipeline_stage_attempts
        WHERE pipeline_instance_id = ?
        ORDER BY attempt_ordinal DESC, reentry_ordinal DESC LIMIT 1
      `).get(instance.id) as PipelineStageAttempt | undefined;
      const retries = db.prepare(`
        SELECT COUNT(*) AS count FROM pipeline_stage_attempts
        WHERE pipeline_instance_id = ? AND status = 'failed'
      `).get(instance.id) as { count: number };
      const gate = db.prepare(`
        SELECT pgr.*, pa.assurance FROM pipeline_gate_receipts pgr
        LEFT JOIN pipeline_artifacts pa
          ON pa.pipeline_instance_id = pgr.pipeline_instance_id
         AND pa.attempt_id = pgr.attempt_id
        WHERE pgr.pipeline_instance_id = ?
        ORDER BY pgr.created_at DESC, pgr.id DESC LIMIT 1
      `).get(instance.id) as {
        result: string;
        policy_digest: string;
        assurance: string | null;
      } | undefined;
      const failedGate = db.prepare(`
        SELECT pgr.evaluator_kind, pgr.payload, pgr.created_at, pa.payload AS artifact_payload
        FROM pipeline_gate_receipts pgr
        LEFT JOIN pipeline_artifacts pa
          ON pa.pipeline_instance_id = pgr.pipeline_instance_id
         AND pa.attempt_id = pgr.attempt_id
         AND instr(pgr.artifact_hashes, pa.artifact_hash) > 0
        WHERE pgr.pipeline_instance_id = ? AND pgr.result = 'failed'
        ORDER BY pgr.created_at DESC, pgr.id DESC LIMIT 1
      `).get(instance.id) as
        | { evaluator_kind: string; payload: string | null; created_at: string; artifact_payload: string | null }
        | undefined;
      const publications = db.prepare(`
        SELECT * FROM pipeline_publication_receipts
        WHERE pipeline_instance_id = ?
        ORDER BY updated_at DESC, created_at DESC, id DESC
      `).all(instance.id) as PipelinePublicationReceipt[];
      const publishedPr = db.prepare(`
        SELECT external_url, target_url FROM pipeline_publication_receipts
        WHERE pipeline_instance_id = ? AND kind = 'pull_request'
        ORDER BY acknowledged_at DESC, updated_at DESC, created_at DESC, id DESC
        LIMIT 1
      `).get(instance.id) as { external_url: string | null; target_url: string | null } | undefined;
      const latest = publications[0];
      const blockedPublication = publications.find((item) => item.status === "dead");
      const failedPublication = publications.find((item) => item.status === "failed");
      const pendingPublication = publications.find((item) =>
        item.status === "pending" || item.status === "processing"
      );
      const publicationState = publicationStateFor(publications, instance.status);
      const effects = db.prepare(`
        SELECT *,
          CASE WHEN status IN ('failed', 'dead') THEN next_attempt_at ELSE created_at END AS status_sort_at
        FROM pipeline_effect_intents
        WHERE pipeline_instance_id = ?
          AND NOT (
            status = 'dead' AND last_error = 'canceled by a terminal pipeline control event'
          )
        ORDER BY status_sort_at DESC, created_at DESC, id DESC
      `).all(instance.id) as Array<PipelineEffectIntent & { status_sort_at: string }>;
      const blockedEffect = effects.find((item) => item.status === "dead");
      const failedEffect = effects.find((item) => item.status === "failed");
      const pendingEffect = effects.find((item) => item.status === "pending" || item.status === "processing");
      const relevantEffect = blockedEffect ?? failedEffect ?? pendingEffect;
      const effectState = effectStateFor(effects);
      // Diagnostics preserve the pipeline-instance boundary: join through the
      // run/attempt binding so a superseded generation's failed events can
      // never surface on (or mask a failure in) the current instance.
      const sandboxEvent = db.prepare(`
        SELECT se.event_id, se.attempts, se.last_error
        FROM sandbox_events se
        JOIN pipeline_stage_attempts psa
          ON se.run_id IN (psa.run_id, psa.planned_run_id)
        WHERE psa.pipeline_instance_id = ?
          AND se.status = 'failed'
          AND se.last_error IS NOT NULL
          AND se.ingestion_diagnosed_at IS NOT NULL
        ORDER BY se.attempts DESC, se.created_at DESC, se.event_id DESC
        LIMIT 1
      `).get(instance.id) as
        | { event_id: string; attempts: number; last_error: string | null }
        | undefined;
      const gateError = gateErrorMessage(failedGate);
      const failedOrDeadEffects = effects.filter((item) => item.status === "failed" || item.status === "dead");
      const newestEffect = failedOrDeadEffects[0];
      const lastError = newestStatusError(newestEffect, failedGate, gateError);
      return {
        execution_mode: "pipeline",
        instance_id: instance.id,
        pipeline_id: instance.pipeline_id,
        pipeline_version: instance.pipeline_version,
        generation: instance.generation,
        task_type: instance.task_type,
        status: instance.status,
        terminal_outcome: instance.terminal_outcome,
        stage_id: instance.active_stage_id ?? attempt?.stage_id ?? null,
        attempt_ordinal: attempt?.attempt_ordinal ?? null,
        reentry_ordinal: attempt?.reentry_ordinal ?? null,
        retry_count: retries.count,
        reentry_count: instance.reentry_count,
        wait_reason: instance.wait_reason,
        whose_move: whoseMove(instance.status, instance.terminal_outcome),
        last_error: boundedStatusError(lastError),
        last_state_change_at: instance.updated_at,
        subject: instance.immutable_subject,
        published_commit: instance.published_commit,
        published_pr_url: publishedPr?.external_url ?? publishedPr?.target_url ?? null,
        gate_result: gate?.result ?? null,
        assurance: gate?.assurance ?? null,
        policy_digest: gate?.policy_digest ?? null,
        context_policy: attempt?.native_context_policy ?? null,
        publication_state: publicationState,
        publication_id: (blockedPublication ?? failedPublication ?? pendingPublication ?? latest)?.id ?? null,
        publication_external_id:
          (blockedPublication ?? failedPublication ?? pendingPublication ?? latest)?.external_id ?? null,
        publication_error:
          boundedStatusError((blockedPublication ?? failedPublication ?? publications.find((item) => item.last_error))?.last_error),
        recovery_action: publicationState === "blocked" && blockedPublication
          ? `POST /tickets/:identifier/publications/${blockedPublication.id}/retry`
          : null,
        effect_state: effectState,
        effect_kind: relevantEffect?.kind ?? null,
        effect_status: relevantEffect?.status ?? null,
        effect_attempts: relevantEffect?.attempts ?? null,
        effect_error: boundedStatusError(relevantEffect?.last_error),
        sandbox_event_id: sandboxEvent?.event_id ?? null,
        sandbox_event_attempts: sandboxEvent?.attempts ?? null,
        sandbox_ingestion_error: boundedStatusError(sandboxEvent?.last_error),
      };
    },
  };
}
