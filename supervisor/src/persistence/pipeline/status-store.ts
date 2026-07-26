import type Database from "better-sqlite3";
import type {
  PipelineEffectIntent,
  PipelineInstance,
  PipelinePublicationReceipt,
  PipelineStageAttempt,
  PipelineStatusProjection,
  PipelineStore,
} from "../../pipeline/store.js";

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
      const publications = db.prepare(`
        SELECT * FROM pipeline_publication_receipts
        WHERE pipeline_instance_id = ?
        ORDER BY updated_at DESC, created_at DESC, id DESC
      `).all(instance.id) as PipelinePublicationReceipt[];
      const latest = publications[0];
      const blockedPublication = publications.find((item) => item.status === "dead");
      const failedPublication = publications.find((item) => item.status === "failed");
      const pendingPublication = publications.find((item) =>
        item.status === "pending" || item.status === "processing"
      );
      const publicationState: PipelineStatusProjection["publication_state"] =
        publications.some((item) => item.status === "dead") || instance.status === "publication_blocked"
          ? "blocked"
          : publications.some((item) => item.status === "failed")
            ? "failed"
            : publications.some((item) => item.status === "pending" || item.status === "processing")
              ? "pending"
              : publications.some((item) => item.status === "acknowledged")
                ? "acknowledged"
                : "none";
      const effects = db.prepare(`
        SELECT * FROM pipeline_effect_intents
        WHERE pipeline_instance_id = ?
          AND NOT (
            status = 'dead' AND last_error = 'canceled by a terminal pipeline control event'
          )
        ORDER BY created_at DESC, id DESC
      `).all(instance.id) as PipelineEffectIntent[];
      const blockedEffect = effects.find((item) => item.status === "dead");
      const failedEffect = effects.find((item) => item.status === "failed");
      const pendingEffect = effects.find((item) => item.status === "pending" || item.status === "processing");
      const relevantEffect = blockedEffect ?? failedEffect ?? pendingEffect;
      const effectState: PipelineStatusProjection["effect_state"] = blockedEffect
        ? "blocked"
        : failedEffect
          ? "failed"
          : pendingEffect
            ? "pending"
            : "none";
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
      return {
        execution_mode: "pipeline",
        instance_id: instance.id,
        pipeline_id: instance.pipeline_id,
        pipeline_version: instance.pipeline_version,
        task_type: instance.task_type,
        status: instance.status,
        stage_id: instance.active_stage_id ?? attempt?.stage_id ?? null,
        attempt_ordinal: attempt?.attempt_ordinal ?? null,
        retry_count: retries.count,
        reentry_count: instance.reentry_count,
        wait_reason: instance.wait_reason,
        subject: instance.immutable_subject,
        published_commit: instance.published_commit,
        gate_result: gate?.result ?? null,
        assurance: gate?.assurance ?? null,
        policy_digest: gate?.policy_digest ?? null,
        context_policy: attempt?.native_context_policy ?? null,
        publication_state: publicationState,
        publication_id: (blockedPublication ?? failedPublication ?? pendingPublication ?? latest)?.id ?? null,
        publication_external_id:
          (blockedPublication ?? failedPublication ?? pendingPublication ?? latest)?.external_id ?? null,
        publication_error:
          (blockedPublication ?? failedPublication ?? publications.find((item) => item.last_error))?.last_error ?? null,
        recovery_action: publicationState === "blocked" && blockedPublication
          ? `POST /tickets/:identifier/publications/${blockedPublication.id}/retry`
          : null,
        effect_state: effectState,
        effect_kind: relevantEffect?.kind ?? null,
        effect_status: relevantEffect?.status ?? null,
        effect_attempts: relevantEffect?.attempts ?? null,
        effect_error: relevantEffect?.last_error ?? null,
        sandbox_event_id: sandboxEvent?.event_id ?? null,
        sandbox_event_attempts: sandboxEvent?.attempts ?? null,
        sandbox_ingestion_error: sandboxEvent?.last_error ?? null,
      };
    },
  };
}
