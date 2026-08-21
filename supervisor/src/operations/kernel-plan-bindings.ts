import {
  ATTEMPT_CHECKPOINT_SCHEMA,
  digestCanonicalJson,
  type AttemptCheckpoint,
  type BlobPointer,
  type DeliveryRecord,
  type JsonValue,
} from "@openthrottle/contracts";
import type { VolumeBlobStore } from "../persistence/blob-store.js";
import type { KernelRunEnvironmentPort } from "../persistence/kernel-runtime-context-store.js";
import type {
  KernelExternalStagePlanBinding,
  KernelPreparedExternalPlan,
} from "./kernel-external-plans.js";
import { CORE_EXTERNAL_PLAN_SHAPES } from "./kernel-external-plans.js";
import { inspectKernelCheckpointBundle } from "../runtime/kernel-checkpoint-bundle.js";
import {
  admissionPlannerEvidence,
  approvedAdmissionReviewEvidence,
} from "../app/kernel-admission-promotion.js";

const GIT_BUNDLE_SCHEMA = "openthrottle.git-checkpoint-bundle/v1" as const;

function runtimeIdentity(input: {
  pipeline_run_id: string;
  repository: string;
  base_commit: string;
  snapshot: string;
}): string {
  return digestCanonicalJson({ schema: "openthrottle.daytona-runtime-identity/v1", ...input });
}

function branch(runId: string, sourceReference: string): string {
  const slug = sourceReference.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "task";
  return `ot/${slug}-${digestCanonicalJson({ run_id: runId }).slice(0, 12)}`;
}

function exactGitCheckpoint(input: {
  checkpoints: ReadonlyMap<string, AttemptCheckpoint>;
  output_subject: string;
}): AttemptCheckpoint {
  const matches = [...input.checkpoints.values()].filter((checkpoint) =>
    checkpoint.output_subject === input.output_subject && "blob" in checkpoint.payload &&
    checkpoint.payload_schema === GIT_BUNDLE_SCHEMA &&
    checkpoint.payload.blob.encoding === "binary" &&
    checkpoint.payload.blob.media_type === "application/x-git-bundle");
  if (matches.length !== 1) {
    throw new Error(`external plan requires exactly one Git checkpoint for ${input.output_subject}`);
  }
  return matches[0]!;
}

function descriptor(blobs: VolumeBlobStore, checkpoint: AttemptCheckpoint) {
  if (!("blob" in checkpoint.payload) || checkpoint.output_subject === null) {
    throw new Error("external Git checkpoint has no materializable output");
  }
  const pointer = checkpoint.payload.blob;
  const inspected = inspectKernelCheckpointBundle({
    bytes: blobs.read(pointer),
    expected_commit: checkpoint.output_subject,
    allowed_ref: /^refs\/openthrottle\/(?:checkpoints|integrations)\/[a-f0-9]{64}$/,
  });
  return {
    file: `${pointer.digest}.bundle`,
    sha256: pointer.digest,
    bytes: pointer.bytes,
    media_type: "application/x-git-bundle" as const,
    payload_schema: GIT_BUNDLE_SCHEMA,
    ...inspected,
  };
}

function allConfirmed(schedules: Parameters<KernelExternalStagePlanBinding["evaluate"]>[0]["schedules"]): boolean {
  return schedules.every((schedule) => schedule.effects.every(({ delivery }) => delivery?.status === "confirmed"));
}

function deliveryResult(delivery: DeliveryRecord): Record<string, unknown> {
  if (
    delivery.payload_schema !== "openthrottle.effect-delivery/v1" ||
    !("inline" in delivery.payload) || !delivery.payload.inline ||
    typeof delivery.payload.inline !== "object" || Array.isArray(delivery.payload.inline)
  ) throw new Error("integration promotion requires a materialized effect delivery");
  const result = (delivery.payload.inline as Record<string, unknown>).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("integration promotion delivery has no result object");
  }
  return result as Record<string, unknown>;
}

function persistedRuntimeIdentity(records: ReadonlyMap<string, import("@openthrottle/contracts").ExecutionRecord>): string {
  const identities = [...records.values()].flatMap((record) => {
    if (
      record.kind !== "delivery" || record.status !== "confirmed" ||
      record.payload_schema !== "openthrottle.effect-delivery/v1" ||
      !("inline" in record.payload) || !record.payload.inline ||
      typeof record.payload.inline !== "object" || Array.isArray(record.payload.inline) ||
      record.payload.inline.effect_kind !== "daytona/create-sandbox@1"
    ) return [];
    const result = record.payload.inline.result;
    return result && typeof result === "object" && !Array.isArray(result) &&
      typeof result.identity === "string" && /^[a-f0-9]{64}$/.test(result.identity)
      ? [result.identity]
      : [];
  });
  if (identities.length !== 1) throw new Error("external plan has no exact persisted Daytona runtime identity");
  return identities[0]!;
}

function lifecycleBinding(input: {
  external_kind: "core/daytona-provision@1" | "core/daytona-stop@1" | "core/daytona-cleanup@1";
  environments: KernelRunEnvironmentPort;
}): KernelExternalStagePlanBinding {
  const shape = CORE_EXTERNAL_PLAN_SHAPES[input.external_kind];
  return {
    external_kind: input.external_kind,
    stage_kind: "effect",
    subject_policy: "preserve",
    phases: shape.phases,
    async prepare({ run, context }) {
      const environment = input.environments.loadExactRunEnvironment(run.id);
      const identity = input.external_kind === "core/daytona-provision@1"
        ? runtimeIdentity({
          pipeline_run_id: run.id,
          repository: environment.repository,
          base_commit: run.current_subject,
          snapshot: environment.runtime_snapshot,
        })
        : persistedRuntimeIdentity(context.records);
      return {
        verified_output_subject: null,
        checkpoint_payload: { identity, runtime_snapshot: environment.runtime_snapshot },
        phases: shape.phases.map((phase) => ({
          id: phase.id,
          effects: phase.effects.map(({ effect_kind }) => ({
            kind: effect_kind,
            idempotency_key: `${run.id}:${effect_kind}:${identity}`,
            target: `daytona:${identity}`,
            subject: null,
            payload: {
              schema: effect_kind === "daytona/create-sandbox@1"
                ? "openthrottle.daytona-create/v1"
                : effect_kind === "daytona/start-sandbox@1"
                  ? "openthrottle.daytona-start/v1"
                  : effect_kind === "daytona/stop-sandbox@1"
                    ? "openthrottle.daytona-stop/v1"
                    : "openthrottle.daytona-cleanup/v1",
              identity,
              pipeline_run_id: run.id,
              repository: environment.repository,
              base_branch: environment.base_branch,
              base_commit: run.current_subject,
              snapshot: environment.runtime_snapshot,
            },
          })),
        })),
      };
    },
    evaluate: ({ schedules }) => allConfirmed(schedules)
      ? { outcome: "success", summary: `${input.external_kind} completed` }
      : { outcome: "failure", summary: `${input.external_kind} was rejected` },
  };
}

export function createKernelExternalPlanBindings(input: {
  environments: KernelRunEnvironmentPort;
  blob_store: VolumeBlobStore;
}): readonly KernelExternalStagePlanBinding[] {
  const publishShape = CORE_EXTERNAL_PLAN_SHAPES["core/publish@1"];
  const integrationShape = CORE_EXTERNAL_PLAN_SHAPES["core/integrate-unit@1"];
  const waitShape = CORE_EXTERNAL_PLAN_SHAPES["core/provider-wait@1"];
  const promotionShape = CORE_EXTERNAL_PLAN_SHAPES["kernel/promote-admission@1"];
  const publish: KernelExternalStagePlanBinding = {
    external_kind: "core/publish@1",
    stage_kind: "effect",
    subject_policy: "preserve",
    phases: publishShape.phases,
    async prepare({ run, context }) {
      const environment = input.environments.loadExactRunEnvironment(run.id);
      const checkpoint = exactGitCheckpoint({ checkpoints: context.checkpoints, output_subject: run.current_subject });
      const artifact = descriptor(input.blob_store, checkpoint);
      const taskBranch = branch(run.id, environment.source_reference);
      return {
        verified_output_subject: null,
        checkpoint_payload: { checkpoint_id: checkpoint.id, ref: `refs/heads/${taskBranch}` },
        phases: [
          { id: "push-checkpoint", effects: [{
            kind: "github/push-checkpoint@1",
            idempotency_key: `${run.id}:push:${run.current_subject}`,
            target: `github:${environment.repository}:refs/heads/${taskBranch}`,
            subject: run.current_subject,
            payload: {
              schema: "openthrottle.github-push-checkpoint/v1",
              repository: environment.repository,
              ref: `refs/heads/${taskBranch}`,
              expected_old_subject: checkpoint.input_subject,
              expected_new_subject: run.current_subject,
              checkpoint_blob: (checkpoint.payload as { blob: BlobPointer }).blob as unknown as JsonValue,
              checkpoint_tree: artifact.tree,
            },
          }] },
          { id: "pull-request", effects: [{
            kind: "github/upsert-pull-request@1",
            idempotency_key: `${run.id}:pull-request:${run.current_subject}`,
            target: `github:${environment.repository}:pull:${taskBranch}`,
            subject: run.current_subject,
            payload: {
              schema: "openthrottle.github-pull-request/v1",
              repository: environment.repository,
              branch: taskBranch,
              base_branch: environment.base_branch,
              expected_head_subject: run.current_subject,
              title: environment.title.slice(0, 256),
              body: `OpenThrottle execution ${run.id} for ${environment.source_reference}.`,
              ownership_marker: `openthrottle:run:${digestCanonicalJson({ run_id: run.id })}`,
            },
          }] },
        ],
      };
    },
    evaluate: ({ schedules }) => allConfirmed(schedules)
      ? { outcome: "success", summary: "checkpoint and pull request published" }
      : { outcome: "failure", summary: "publication was rejected" },
  };

  const integrate: KernelExternalStagePlanBinding = {
    external_kind: "core/integrate-unit@1",
    stage_kind: "effect",
    subject_policy: "advance",
    phases: integrationShape.phases,
    async prepare({ run, attempt, context }) {
      const environment = input.environments.loadExactRunEnvironment(run.id);
      const candidates = [...context.checkpoints.values()].filter((checkpoint) =>
        checkpoint.output_subject !== null && checkpoint.output_subject !== attempt.input_subject &&
        "blob" in checkpoint.payload && checkpoint.payload_schema === GIT_BUNDLE_SCHEMA);
      if (candidates.length !== 1) throw new Error("unit integration requires one exact candidate checkpoint");
      const candidate = candidates[0]!;
      const artifact = descriptor(input.blob_store, candidate);
      const identity = persistedRuntimeIdentity(context.records);
      return {
        verified_output_subject: null,
        checkpoint_payload: { candidate_checkpoint_id: candidate.id },
        phases: [
          { id: "integrate-checkpoint", effects: [{
            kind: "daytona/integrate-checkpoint@1",
            idempotency_key: `${run.id}:${attempt.id}:integrate:${candidate.id}`,
            target: `daytona:${identity}:integration:${candidate.id}`,
            subject: null,
            payload: {
              schema: "openthrottle.daytona-integration/v1",
              identity,
              pipeline_run_id: run.id,
              attempt_id: attempt.id,
              definition_bundle_hash: run.definition_bundle_hash,
              current_subject: attempt.input_subject,
              candidate_checkpoint_id: candidate.id,
              candidate_input_subject: candidate.input_subject,
              candidate_output_subject: candidate.output_subject!,
              candidate_blob: (candidate.payload as { blob: BlobPointer }).blob as unknown as JsonValue,
              candidate_artifact: artifact,
            },
          }] },
          { id: "push-checkpoint", effects: [{
            kind: "github/push-checkpoint@1",
            idempotency_key: `${run.id}:${attempt.id}:push:pending`,
            target: `github:${environment.repository}:pending-integration`,
            subject: null,
            payload: { schema: "openthrottle.pending-integration-push/v1" },
          }] },
        ],
      };
    },
    async promote({ run, attempt, prepared, schedules }) {
      const delivery = schedules[0]?.effects[0]?.delivery;
      if (!delivery || delivery.status !== "confirmed") throw new Error("integration promotion lacks confirmed delivery");
      const evidence = deliveryResult(delivery);
      if (
        evidence.schema !== "openthrottle.daytona-integration-delivery/v1" || evidence.state !== "integrated" ||
        typeof evidence.output_subject !== "string" || typeof evidence.checkpoint_id !== "string" ||
        evidence.checkpoint_payload_schema !== GIT_BUNDLE_SCHEMA ||
        !evidence.checkpoint_blob || typeof evidence.checkpoint_blob !== "object" || Array.isArray(evidence.checkpoint_blob)
      ) throw new Error("integration delivery is not promotable");
      const output = evidence.output_subject;
      const checkpoint: AttemptCheckpoint = {
        schema: ATTEMPT_CHECKPOINT_SCHEMA,
        id: evidence.checkpoint_id,
        pipeline_run_id: run.id,
        attempt_id: attempt.id,
        request_hash: attempt.request_hash,
        definition_bundle_hash: attempt.definition_bundle_hash,
        input_subject: attempt.input_subject,
        output_subject: output,
        native_session_id: null,
        payload_schema: GIT_BUNDLE_SCHEMA,
        payload: { blob: evidence.checkpoint_blob as BlobPointer },
        captured_at: delivery.created_at,
      };
      const environment = input.environments.loadExactRunEnvironment(run.id);
      const taskBranch = branch(run.id, environment.source_reference);
      const artifact = descriptor(input.blob_store, checkpoint);
      const promoted: KernelPreparedExternalPlan = {
        ...prepared,
        verified_output_subject: output,
        phases: [prepared.phases[0]!, {
          id: "push-checkpoint",
          effects: [{
            kind: "github/push-checkpoint@1",
            idempotency_key: `${run.id}:${attempt.id}:push:${output}`,
            target: `github:${environment.repository}:refs/heads/${taskBranch}`,
            subject: output,
            payload: {
              schema: "openthrottle.github-push-checkpoint/v1",
              repository: environment.repository,
              ref: `refs/heads/${taskBranch}`,
              expected_old_subject: attempt.input_subject,
              expected_new_subject: output,
              checkpoint_blob: evidence.checkpoint_blob as JsonValue,
              checkpoint_tree: artifact.tree,
            },
          }],
        }],
      };
      return { prepared: promoted, checkpoint, delivery_record_id: delivery.id };
    },
    evaluate: ({ schedules }) => allConfirmed(schedules)
      ? { outcome: "all_integrated", summary: "unit checkpoint integrated and durably pushed" }
      : { outcome: "failure", summary: "unit integration was rejected" },
  };

  const wait: KernelExternalStagePlanBinding = {
    external_kind: "core/provider-wait@1",
    stage_kind: "wait",
    subject_policy: "preserve",
    phases: waitShape.phases,
    async prepare({ run }) {
      const environment = input.environments.loadExactRunEnvironment(run.id);
      return {
        verified_output_subject: null,
        checkpoint_payload: { subject: run.current_subject },
        phases: [{ id: "observe", effects: [{
          kind: "github/provider-wait@1",
          idempotency_key: `${run.id}:provider:${run.current_subject}`,
          target: `github:${environment.repository}:checks:${run.current_subject}`,
          subject: run.current_subject,
          payload: {
            schema: "openthrottle.github-provider-wait/v1",
            repository: environment.repository,
            subject: run.current_subject,
          },
        }] }],
      };
    },
    evaluate: ({ schedules }) => allConfirmed(schedules)
      ? { outcome: "success", summary: "provider verification succeeded" }
      : { outcome: "failure", summary: "provider verification failed" },
  };

  const promoteAdmission: KernelExternalStagePlanBinding = {
    external_kind: "kernel/promote-admission@1",
    stage_kind: "effect",
    subject_policy: "preserve",
    phases: promotionShape.phases,
    async prepare({ run, attempt, context }) {
      if (run.pipeline_id !== "core/admission") {
        throw new Error("admission promotion can only run from the sealed core/admission pipeline");
      }
      const planners = [...context.records.values()]
        .map(admissionPlannerEvidence)
        .filter((candidate): candidate is NonNullable<ReturnType<typeof admissionPlannerEvidence>> =>
          candidate !== null);
      const reviewers = [...context.records.values()]
        .map(approvedAdmissionReviewEvidence)
        .filter((candidate): candidate is NonNullable<ReturnType<typeof approvedAdmissionReviewEvidence>> =>
          candidate !== null);
      if (planners.length !== 1 || reviewers.length !== 1) {
        throw new Error("admission promotion requires one exact planner and reviewer ResultRecord");
      }
      const planner = planners[0]!;
      const reviewer = reviewers[0]!;
      const environment = input.environments.loadExactRunEnvironment(run.id);
      const selectedPipeline = planner.route === "structured" ? "core/structured" : "core/implement";
      const plannerHash = digestCanonicalJson(planner.record);
      const reviewerHash = digestCanonicalJson(reviewer);
      const promotionIdentity = digestCanonicalJson({
        schema: "openthrottle.kernel-admission-promotion-identity/v1",
        work_item_id: environment.work_item_id,
        source_commit: attempt.input_subject,
        selected_pipeline: selectedPipeline,
        planner_result_hash: plannerHash,
        reviewer_result_hash: reviewerHash,
      });
      const targetRunId = `run-${promotionIdentity.slice(0, 48)}`;
      const targetAttemptId = `attempt-${digestCanonicalJson({
        schema: "openthrottle.kernel-promoted-initial-attempt/v1",
        target_run_id: targetRunId,
        selected_pipeline: selectedPipeline,
      }).slice(0, 48)}`;
      return {
        verified_output_subject: null,
        checkpoint_payload: {
          target_run_id: targetRunId,
          selected_pipeline: selectedPipeline,
          planner_result_hash: plannerHash,
          reviewer_result_hash: reviewerHash,
        },
        phases: [{ id: "promote", effects: [{
          kind: "kernel/promote-admission@1",
          idempotency_key: `admission:${promotionIdentity}`,
          target: `kernel:run:${targetRunId}`,
          subject: attempt.input_subject,
          payload: {
            schema: "openthrottle.kernel-admission-promotion-intent/v1",
            source_pipeline_run_id: run.id,
            source_attempt_id: attempt.id,
            work_item_id: environment.work_item_id,
            repository: environment.repository,
            source_commit: attempt.input_subject,
            selected_pipeline: selectedPipeline,
            target_run_id: targetRunId,
            target_initial_attempt_id: targetAttemptId,
            planner_result_id: planner.record.id,
            planner_result_hash: plannerHash,
            reviewer_result_id: reviewer.id,
            reviewer_result_hash: reviewerHash,
          },
        }] }],
      };
    },
    evaluate: ({ schedules }) => allConfirmed(schedules)
      ? { outcome: "success", summary: "admission target pipeline attached" }
      : { outcome: "failure", summary: "admission target promotion was rejected" },
  };

  return [
    lifecycleBinding({
      external_kind: "core/daytona-provision@1",
      environments: input.environments,
    }),
    lifecycleBinding({
      external_kind: "core/daytona-stop@1",
      environments: input.environments,
    }),
    lifecycleBinding({
      external_kind: "core/daytona-cleanup@1",
      environments: input.environments,
    }),
    integrate,
    promoteAdmission,
    publish,
    wait,
  ];
}
