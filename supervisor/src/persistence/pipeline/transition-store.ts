import type Database from "better-sqlite3";
import { canonicalJson, digestNormalized, type PipelineManifest } from "../../pipeline/manifest.js";
import { parsePipelinePublication } from "../../pipeline/publication.js";
import type {
  CoordinatorTransitionWrite,
  PipelineInboxEventRecord,
  PipelineInstance,
  PipelineStageAttempt,
  PipelineStore,
} from "../../pipeline/store.js";
import {
  createPipelinePublicationWriter,
  deterministicId,
  validatePinnedInstance,
} from "./helpers.js";
import { createJournalStore } from "./journal-store.js";
import { createRunOutcomeStore } from "./run-outcome-store.js";

function attemptStatusForOutcome(
  outcome: CoordinatorTransitionWrite["outcome"]
): PipelineStageAttempt["status"] {
  if (outcome === "canceled") return "canceled";
  if (outcome === "superseded") return "superseded";
  if (outcome === "failure" || outcome === "retryable_infrastructure_failure") return "failed";
  return "completed";
}

export function createTransitionStore(db: Database.Database, now: () => string): Pick<
  PipelineStore,
  "getInboxEvent" | "listPendingInboxEvents" | "enqueueInboxEvent" | "applyTransition"
> {
  const getInstanceStmt = db.prepare("SELECT * FROM pipeline_instances WHERE id = ?");
  const getAttemptStmt = db.prepare("SELECT * FROM pipeline_stage_attempts WHERE id = ?");
  const persistPublication = createPipelinePublicationWriter(db);
  const journal = createJournalStore(db, now);
  const runOutcomes = createRunOutcomeStore(db);

  const maybeRecordRunNote = (
    instance: PipelineInstance,
    attempt: PipelineStageAttempt,
    write: CoordinatorTransitionWrite
  ): void => {
    const manifest = JSON.parse(instance.normalized_manifest) as PipelineManifest;
    const stage = manifest.stages.find((candidate) => candidate.id === attempt.stage_id);
    if (stage?.executor.kind !== "agent") return;
    const stageResult = write.artifacts?.find((artifact) => artifact.kind === "stage_result");
    if (!stageResult) return;
    let payload: {
      summary?: unknown;
      evidence?: unknown;
      findings?: unknown;
      uncertainty?: unknown;
    };
    try {
      payload = JSON.parse(stageResult.payload) as typeof payload;
    } catch {
      return;
    }
    const summary = typeof payload.summary === "string" ? payload.summary : "";
    const evidence = Array.isArray(payload.evidence)
      ? payload.evidence.filter((item): item is string => typeof item === "string").slice(0, 10)
      : [];
    const findings = Array.isArray(payload.findings)
      ? payload.findings.filter((item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null
        ).slice(0, 10)
      : [];
    const uncertainty = Array.isArray(payload.uncertainty)
      ? payload.uncertainty.filter((item): item is string => typeof item === "string").slice(0, 10)
      : [];
    const operatorCredentialSignal = write.outcome === "retryable_infrastructure_failure" &&
      /model credential expired/i.test(summary) &&
      /CODEX_AUTH_JSON/.test(summary);
    const notable = attempt.stage_id.startsWith("repair_") ||
      uncertainty.length > 0 ||
      write.outcome === "no_change" ||
      operatorCredentialSignal;
    if (!notable) return;
    const note = [
      summary,
      uncertainty.length > 0 ? `Uncertainty: ${uncertainty.join(" ")}` : "",
      findings.length > 0
        ? `Findings: ${findings.map((finding) => String(finding.summary ?? "")).filter(Boolean).join(" ")}`
        : "",
    ].filter(Boolean).join("\n\n");
    if (!note.trim()) return;
    journal.recordJournalEntry({
      id: deterministicId("journal", [attempt.id, stageResult.hash, "run_note"]),
      issueId: instance.linear_issue_id,
      instanceId: instance.id,
      runId: attempt.run_id,
      actor: "stage_agent",
      kind: "run_note",
      trigger: `${attempt.stage_id} proposal projection`,
      action: "Projected notable stage proposal fields into the orchestration journal.",
      outcome: write.outcome,
      refs: {
        stage: attempt.stage_id,
        attempt_id: attempt.id,
        run_id: attempt.run_id,
        result_hash: write.resultHash,
        evidence_count: evidence.length,
        finding_count: findings.length,
      },
      note,
      structured: {
        suggested_outcome: write.outcome,
        uncertainty,
        evidence_refs: evidence,
      },
    });
  };

  const enqueueInboxEvent = db.transaction((input: {
    id: string;
    instanceId: string;
    generation: number;
    kind: string;
    payload: string;
    subject?: string | null;
  }): "pending" | "stale" | "consumed" => {
    const instance = getInstanceStmt.get(input.instanceId) as PipelineInstance | undefined;
    if (!instance) throw new Error(`unknown pipeline instance ${input.instanceId}`);
    const status = input.generation === instance.generation &&
      (input.kind === "stage_result" || input.subject == null ||
        instance.immutable_subject == null || input.subject === instance.immutable_subject)
      ? "pending"
      : "stale";
    const payloadHash = digestNormalized(input.payload);
    const existing = db.prepare("SELECT * FROM pipeline_inbox_events WHERE id = ?").get(input.id) as
      | { pipeline_instance_id: string; generation: number; kind: string; payload_hash: string; status: string }
      | undefined;
    if (existing) {
      if (
        existing.pipeline_instance_id !== input.instanceId || existing.generation !== input.generation ||
        existing.kind !== input.kind || existing.payload_hash !== payloadHash
      ) throw new Error(`pipeline inbox event ${input.id} already exists with different content`);
      return existing.status === "stale" ? "stale" : existing.status === "consumed" ? "consumed" : "pending";
    }
    db.prepare(`
      INSERT INTO pipeline_inbox_events (
        id, pipeline_instance_id, generation, kind, payload, payload_hash, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.instanceId, input.generation, input.kind, input.payload, payloadHash, status, now());
    return status;
  });

  const applyTransition = db.transaction((
    write: CoordinatorTransitionWrite,
    faultAfterWrite?: (writeCount: number) => void
  ): PipelineInstance => {
    let writes = 0;
    const wrote = () => faultAfterWrite?.(++writes);
    const instance = getInstanceStmt.get(write.instanceId) as PipelineInstance | undefined;
    if (!instance) throw new Error(`unknown pipeline instance ${write.instanceId}`);
    validatePinnedInstance(db, instance);
    if (instance.state_version !== write.expectedVersion || instance.status !== write.expectedStatus) {
      throw new Error(`pipeline instance ${write.instanceId} transition compare-and-set failed`);
    }
    const attempt = getAttemptStmt.get(write.attemptId) as PipelineStageAttempt | undefined;
    if (!attempt || attempt.pipeline_instance_id !== instance.id || attempt.stage_id !== instance.active_stage_id) {
      throw new Error(`attempt ${write.attemptId} is not active for pipeline instance ${instance.id}`);
    }
    if (["completed", "canceled", "superseded", "failed"].includes(attempt.status)) {
      throw new Error(`attempt ${write.attemptId} is already terminal`);
    }
    const event = db.prepare(`
      SELECT pipeline_instance_id, generation, payload_hash, status
      FROM pipeline_inbox_events WHERE id = ?
    `).get(write.eventId) as
      | { pipeline_instance_id: string; generation: number; payload_hash: string; status: string }
      | undefined;
    if (
      !event || event.pipeline_instance_id !== instance.id || event.generation !== instance.generation ||
      event.payload_hash !== write.eventPayloadHash || event.status !== "pending"
    ) throw new Error(`pipeline inbox event ${write.eventId} fence mismatch`);
    const timestamp = now();
    if (write.exhaustedEffectId) {
      const exhausted = db.prepare(`
        UPDATE pipeline_effect_intents
        SET status = 'dead', next_attempt_at = ?, last_error = ?
        WHERE id = ? AND pipeline_instance_id = ? AND status = 'processing'
      `).run(
        timestamp,
        write.exhaustedEffectError ?? "pipeline effect attempts exhausted",
        write.exhaustedEffectId,
        instance.id
      );
      if (exhausted.changes !== 1) {
        throw new Error(`pipeline effect ${write.exhaustedEffectId} is not processing`);
      }
      wrote();
    }
    const attemptStatus = attemptStatusForOutcome(write.outcome);
    db.prepare(`
      UPDATE pipeline_stage_attempts
      SET status = ?, outcome = ?, result_hash = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(attemptStatus, write.outcome, write.resultHash, timestamp, timestamp, attempt.id);
    wrote();
    for (const artifact of write.artifacts ?? []) {
      if (digestNormalized(artifact.payload) !== artifact.hash) throw new Error(`artifact ${artifact.id ?? artifact.kind} hash mismatch`);
      db.prepare(`
        INSERT INTO pipeline_artifacts (
          id, pipeline_instance_id, attempt_id, kind, schema_version,
          assurance, subject, payload, artifact_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifact.id ?? deterministicId("artifact", [instance.id, attempt.id, artifact.kind, artifact.hash]),
        instance.id, attempt.id, artifact.kind, artifact.schemaVersion, artifact.assurance,
        artifact.subject ?? null, artifact.payload, artifact.hash, timestamp
      );
      wrote();
    }
    if (write.gateReceipt) {
      const receipt = write.gateReceipt;
      if (digestNormalized(receipt.payload) !== receipt.hash) {
        throw new Error(`gate receipt ${receipt.id ?? attempt.id} hash mismatch`);
      }
      const artifactHashes = canonicalJson([...receipt.artifactHashes].sort());
      if (artifactHashes !== canonicalJson(receipt.artifactHashes)) {
        throw new Error(`gate receipt ${receipt.id ?? attempt.id} artifact hashes are not canonical`);
      }
      const acceptedHashes = new Set((write.artifacts ?? []).map((artifact) => artifact.hash));
      if (receipt.artifactHashes.some((hash) => !acceptedHashes.has(hash))) {
        throw new Error(`gate receipt ${receipt.id ?? attempt.id} references unaccepted evidence`);
      }
      db.prepare(`
        INSERT INTO pipeline_gate_receipts (
          id, pipeline_instance_id, attempt_id, evaluator_kind, policy_digest,
          subject, result, artifact_hashes, receipt_hash, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.id ?? deterministicId("gate", [instance.id, attempt.id, receipt.hash]),
        instance.id, attempt.id, receipt.evaluatorKind, receipt.policyDigest,
        receipt.subject ?? null, receipt.result, artifactHashes, receipt.hash,
        receipt.payload, timestamp
      );
      wrote();
    }
    maybeRecordRunNote(instance, attempt, write);
    wrote();
    db.prepare(`
      UPDATE pipeline_instance_stages
      SET status = ?,
          attempt_count = attempt_count + ?,
          reentry_count = reentry_count + ?,
          updated_at = ?
      WHERE pipeline_instance_id = ? AND stage_id = ?
    `).run(
      write.nextStageId === attempt.stage_id ? write.nextStageStatus ?? "dispatchable" :
        write.outcome === "success" || write.outcome === "no_change" ? "passed" : "failed",
      write.nextStageId === attempt.stage_id && write.nextAttempt ? 1 : 0,
      write.nextStageId === attempt.stage_id ? write.reentryIncrement ?? 0 : 0,
      timestamp, instance.id, attempt.stage_id
    );
    wrote();
    if (write.nextStageId && write.nextStageId !== attempt.stage_id) {
      const next = db.prepare(`
        UPDATE pipeline_instance_stages SET
          status = ?, attempt_count = attempt_count + ?,
          reentry_count = reentry_count + ?, updated_at = ?
        WHERE pipeline_instance_id = ? AND stage_id = ? AND status IN ('pending', 'waiting', 'failed', 'passed')
      `).run(
        write.nextStageStatus ?? "dispatchable",
        write.nextAttempt ? 1 : 0,
        write.reentryIncrement ?? 0,
        timestamp,
        instance.id,
        write.nextStageId
      );
      if (next.changes !== 1) throw new Error(`next stage ${write.nextStageId} is not dispatchable`);
      wrote();
    }
    if (write.nextAttempt) {
      db.prepare(`
        INSERT INTO pipeline_stage_attempts (
          id, pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal,
          request_hash, idempotency_key, context_revision, native_context_policy,
          planned_run_id, expected_subject, native_session_id, request_payload,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        write.nextAttempt.id ?? deterministicId("attempt", [
          instance.id, write.nextAttempt.stageId, write.nextAttempt.attemptOrdinal, write.nextAttempt.reentryOrdinal,
        ]),
        instance.id, write.nextAttempt.stageId, write.nextAttempt.attemptOrdinal,
        write.nextAttempt.reentryOrdinal, write.nextAttempt.requestHash,
        write.nextAttempt.idempotencyKey, write.nextAttempt.contextRevision,
        write.nextAttempt.contextPolicy, write.nextAttempt.plannedRunId,
        write.nextAttempt.expectedSubject, write.nextAttempt.nativeSessionId,
        write.nextAttempt.requestPayload, timestamp, timestamp
      );
      wrote();
    }
    const nextVersion = instance.state_version + 1;
    const update = db.prepare(`
      UPDATE pipeline_instances SET
        status = ?, active_stage_id = ?, wait_reason = ?, state_version = ?,
        attempt_count = attempt_count + ?, reentry_count = reentry_count + ?,
        immutable_subject = CASE WHEN ? IS NULL THEN immutable_subject ELSE ? END,
        published_commit = CASE WHEN ? THEN NULL WHEN ? IS NULL THEN published_commit ELSE ? END,
        published_subject = CASE WHEN ? THEN NULL WHEN ? IS NULL THEN published_subject ELSE ? END,
        terminal_outcome = ?,
        updated_at = ?
      WHERE id = ? AND state_version = ? AND status = ?
    `).run(
      write.nextStatus, write.nextStageId ?? null, write.waitReason ?? null, nextVersion,
      write.nextAttempt ? 1 : 0, write.reentryIncrement ?? 0,
      write.immutableSubject ?? null, write.immutableSubject ?? null,
      write.clearPublishedCommit ? 1 : 0, write.publishedCommit ?? null, write.publishedCommit ?? null,
      write.clearPublishedCommit ? 1 : 0, write.publishedSubject ?? null, write.publishedSubject ?? null,
      write.terminalOutcome ?? null,
      timestamp, instance.id, write.expectedVersion, write.expectedStatus
    );
    if (update.changes !== 1) throw new Error(`pipeline instance ${instance.id} transition compare-and-set failed`);
    wrote();
    if (write.terminalOutcome === "canceled" || write.terminalOutcome === "superseded") {
      db.prepare(`
        UPDATE pipeline_effect_intents
        SET status = 'dead', last_error = 'canceled by a terminal pipeline control event'
        WHERE pipeline_instance_id = ?
          AND kind IN ('provision', 'dispatch_stage', 'idle')
          AND status IN ('pending', 'processing', 'failed')
      `).run(instance.id);
      wrote();
    }
    for (const effect of write.effects) {
      const payloadHash = digestNormalized(effect.payload);
      const publicationKind = effect.kind === "publish_linear"
        ? "linear_ledger" as const
        : effect.kind === "publish_github"
          ? "github_summary" as const
          : undefined;
      if (publicationKind) {
        persistPublication({
          instance,
          attemptId: attempt.id,
          kind: publicationKind,
          idempotencyKey: effect.idempotencyKey,
          payload: effect.payload,
          timestamp,
        });
        if (publicationKind === "linear_ledger" && effect.payload.includes("\"structured_execution\"")) {
          try {
            const envelope = parsePipelinePublication(effect.payload);
            if (envelope.structured_execution) {
              journal.recordJournalEntry({
                id: deterministicId("journal", [instance.id, attempt.id, write.resultHash, "structured-ledger"]),
                issueId: instance.linear_issue_id,
                instanceId: instance.id,
                runId: attempt.run_id,
                actor: "supervisor",
                kind: "run_note",
                trigger: `${attempt.stage_id} structured publication`,
                action: "Projected the structured unit and gate ledger through the durable publication path.",
                outcome: write.outcome,
                refs: {
                  stage: attempt.stage_id,
                  attempt_id: attempt.id,
                  publication_kind: publicationKind,
                  result_hash: write.resultHash,
                },
                structured: {
                  unit_count: envelope.structured_execution.units.length,
                  aggregate_artifact_hash: envelope.structured_execution.graph?.aggregate_artifact_hash ?? null,
                },
              });
              wrote();
            }
          } catch {
            // The publication writer already validates payload shape; this
            // journal projection is audit-only and must not block transition.
          }
        }
        wrote();
      }
      db.prepare(`
        INSERT INTO pipeline_effect_intents (
          id, pipeline_instance_id, transition_version, kind, idempotency_key,
          payload, payload_hash, status, next_attempt_at, created_at, acknowledged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        effect.id ?? deterministicId("effect", [instance.id, nextVersion, effect.kind, effect.idempotencyKey]),
        instance.id, nextVersion, effect.kind, effect.idempotencyKey,
        effect.payload, payloadHash, publicationKind ? "acknowledged" : "pending",
        timestamp, timestamp, publicationKind ? timestamp : null
      );
      wrote();
    }
    if (write.nextStageId?.startsWith("repair_")) {
      journal.recordJournalEntry({
        id: deterministicId("journal", [instance.id, attempt.id, write.nextStageId, "relayed_finding"]),
        issueId: instance.linear_issue_id,
        instanceId: instance.id,
        runId: attempt.run_id,
        actor: "supervisor",
        kind: "relayed_finding",
        trigger: `${attempt.stage_id} produced ${write.outcome}`,
        action: `Scheduled ${write.nextStageId} for repair.`,
        outcome: write.outcome,
        refs: {
          stage: attempt.stage_id,
          attempt_id: attempt.id,
          next_stage: write.nextStageId,
          next_attempt: write.nextAttempt?.id ?? null,
          result_hash: write.resultHash,
        },
      });
      wrote();
    }
    if (attempt.stage_id === "publish" && write.outcome === "success") {
      journal.recordJournalEntry({
        id: deterministicId("journal", [instance.id, attempt.id, "published"]),
        issueId: instance.linear_issue_id,
        instanceId: instance.id,
        runId: attempt.run_id,
        actor: "supervisor",
        kind: "published",
        trigger: "Publish stage settled",
        action: "Recorded executor-verified publication output.",
        outcome: write.outcome,
        refs: {
          stage: attempt.stage_id,
          attempt_id: attempt.id,
          commit: write.publishedCommit ?? write.immutableSubject ?? null,
          result_hash: write.resultHash,
        },
      });
      wrote();
    }
    if (write.terminalOutcome) {
      journal.recordJournalEntry({
        id: deterministicId("journal", [instance.id, attempt.id, write.terminalOutcome, "terminal_observed"]),
        issueId: instance.linear_issue_id,
        instanceId: instance.id,
        runId: attempt.run_id,
        actor: "supervisor",
        kind: "terminal_observed",
        trigger: `${attempt.stage_id} transition settled`,
        action: "Observed a terminal pipeline outcome.",
        outcome: write.terminalOutcome,
        refs: {
          stage: attempt.stage_id,
          attempt_id: attempt.id,
          result_hash: write.resultHash,
          subject: write.publishedCommit ?? write.immutableSubject ?? null,
        },
      });
      wrote();
      runOutcomes.recordSettlement(instance, attempt, write, timestamp);
      wrote();
    }
    const consumed = db.prepare(`
      UPDATE pipeline_inbox_events SET status = 'consumed', consumed_at = ?
      WHERE id = ? AND pipeline_instance_id = ? AND status = 'pending'
    `).run(timestamp, write.eventId, instance.id);
    if (consumed.changes !== 1) throw new Error(`pipeline inbox event ${write.eventId} is not pending`);
    wrote();
    return getInstanceStmt.get(instance.id) as PipelineInstance;
  });

  return {
    getInboxEvent(id) {
      return db.prepare("SELECT * FROM pipeline_inbox_events WHERE id = ?")
        .get(id) as PipelineInboxEventRecord | undefined;
    },
    listPendingInboxEvents(kind, limit = 50) {
      return db.prepare(`
        SELECT * FROM pipeline_inbox_events
        WHERE kind = ? AND status = 'pending'
        ORDER BY created_at, id LIMIT ?
      `).all(kind, limit) as PipelineInboxEventRecord[];
    },
    enqueueInboxEvent,
    applyTransition,
  };
}
