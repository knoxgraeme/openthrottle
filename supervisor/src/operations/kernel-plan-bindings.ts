import {
  ATTEMPT_CHECKPOINT_SCHEMA,
  digestCanonicalJson,
  validateFilesystemConfigContract,
  type AttemptCheckpoint,
  type BlobPointer,
  type DeliveryRecord,
  type ExecutionRecord,
  type JsonValue,
} from "@openthrottle/contracts";
import type { VolumeBlobStore } from "../persistence/blob-store.js";
import type { KernelRunEnvironmentPort } from "../persistence/kernel-runtime-context-store.js";
import type {
  KernelExternalStagePlanBinding,
  KernelPreparedExternalPlan,
} from "./kernel-external-plans.js";
import { CORE_EXTERNAL_PLAN_SHAPES } from "./kernel-external-plans.js";
import {
  KERNEL_INTEGRATION_ANCESTRY_MAX_ENTRIES,
  inspectKernelCheckpointBundle,
  inspectKernelCheckpointBundleAdvertisement,
} from "../runtime/kernel-checkpoint-bundle.js";
import { KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES } from "../runtime/kernel-wire.js";
import {
  admissionPlannerEvidence,
  approvedAdmissionReviewEvidence,
} from "../app/kernel-admission-promotion.js";
import {
  exactConfirmedGithubPushDelivery,
  isGithubPushDelivery,
} from "../pipeline/kernel/github-push-delivery.js";

const GIT_BUNDLE_SCHEMA = "openthrottle.git-checkpoint-bundle/v1" as const;

function githubProviderEvidencePolicy(
  bundle: Parameters<KernelExternalStagePlanBinding["prepare"]>[0]["bundle"],
) {
  const matches = bundle.entries.filter((entry) =>
    entry.definition_kind === "config" && entry.definition_id === "repository" &&
    entry.origin.kind === "repository" && entry.path === ".openthrottle/config.yml");
  if (matches.length !== 1) {
    throw new Error("provider wait requires one exact repository config in its DefinitionBundle");
  }
  const config = validateFilesystemConfigContract(matches[0]!.normalized_payload, {
    source: "definition_bundle.config:repository",
  }).value;
  const policy = config.provider_evidence?.github;
  if (!policy) throw new Error("provider wait requires a sealed GitHub provider-evidence policy");
  return policy;
}

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

interface PublicationAnchor {
  subject: string;
  ref_mode: "create" | "update";
  delivery_record_id: string | null;
}

function latestConfirmedTaskRefPush(input: {
  records: ReadonlyMap<string, ExecutionRecord>;
  pipeline_run_id: string;
  repository: string;
  ref: string;
  source_commit: string;
}): PublicationAnchor {
  const externalIdentity = `github:${input.repository}:${input.ref}`;
  const records = [...input.records.values()];
  for (const record of records) {
    if (
      record.kind === "delivery" && record.external_identity === externalIdentity &&
      !isGithubPushDelivery(record)
    ) throw new Error("confirmed task-ref push evidence has no exact delivery envelope");
  }
  const evidence = exactConfirmedGithubPushDelivery({
    records,
    label: "confirmed task-ref push evidence",
    pipeline_run_id: input.pipeline_run_id,
  });
  if (evidence === null) {
    return { subject: input.source_commit, ref_mode: "create", delivery_record_id: null };
  }
  if (
    evidence.repository !== input.repository || evidence.ref !== input.ref ||
    evidence.record.external_identity !== externalIdentity
  ) {
    throw new Error("confirmed task-ref push evidence does not match its sealed target");
  }
  return {
    subject: evidence.sha,
    ref_mode: "update",
    delivery_record_id: evidence.record.id,
  };
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

function descriptor(
  blobs: VolumeBlobStore,
  checkpoint: AttemptCheckpoint,
  checkpointBaseSubject: string,
  requiredAncestry?: { ancestor: string; descendant: string },
  sealedBytes?: Uint8Array,
) {
  if (!("blob" in checkpoint.payload) || checkpoint.output_subject === null) {
    throw new Error("external Git checkpoint has no materializable output");
  }
  const pointer = checkpoint.payload.blob;
  const inspected = inspectKernelCheckpointBundle({
    bytes: sealedBytes ?? blobs.read(pointer),
    expected_commit: checkpoint.output_subject,
    shallow_boundary: checkpointBaseSubject,
    expected_parent: checkpoint.output_subject === checkpoint.input_subject
      ? undefined
      : checkpoint.input_subject,
    ...(requiredAncestry === undefined ? {} : {
      required_ancestor: requiredAncestry.ancestor,
      required_descendant: requiredAncestry.descendant,
    }),
    allowed_ref: /^refs\/openthrottle\/(?:checkpoints|integrations)\/[a-f0-9]{64}$/,
  });
  if (
    inspected.ref.startsWith("refs/openthrottle/checkpoints/") &&
    (
      inspected.ref !== `refs/openthrottle/checkpoints/${checkpoint.request_hash}`
    )
  ) {
    throw new Error("ordinary Git checkpoint does not bind its exact request ref and sole input parent");
  }
  return {
    file: `${pointer.digest}.bundle`,
    sha256: pointer.digest,
    bytes: pointer.bytes,
    media_type: "application/x-git-bundle" as const,
    payload_schema: GIT_BUNDLE_SCHEMA,
    ref: inspected.ref,
    commit: inspected.commit,
    tree: inspected.tree,
  };
}

interface PreparedIntegrationAncestryEntry {
  checkpoint_id: string;
  input_subject: string;
  output_subject: string;
  checkpoint_blob: BlobPointer;
  checkpoint_artifact: ReturnType<typeof descriptor>;
}

function exactIntegrationCheckpointContext(input: {
  checkpoints: ReadonlyMap<string, AttemptCheckpoint>;
  blobs: VolumeBlobStore;
  pipeline_run_id: string;
  definition_bundle_hash: string;
  checkpoint_base_subject: string;
  current_subject: string;
}): {
  candidate: AttemptCheckpoint;
  candidate_artifact: ReturnType<typeof descriptor>;
  current_ancestry: PreparedIntegrationAncestryEntry[];
} {
  const checkpoints = [...input.checkpoints.values()];
  if (
    checkpoints.length < 1 ||
    checkpoints.length > KERNEL_INTEGRATION_ANCESTRY_MAX_ENTRIES + 1
  ) throw new Error("unit integration checkpoint context exceeds its exact bounded shape");
  const sealedCheckpoints = checkpoints.map((checkpoint) => {
    if (
      checkpoint.pipeline_run_id !== input.pipeline_run_id ||
      checkpoint.definition_bundle_hash !== input.definition_bundle_hash ||
      checkpoint.output_subject === null ||
      checkpoint.payload_schema !== GIT_BUNDLE_SCHEMA ||
      !("blob" in checkpoint.payload)
    ) throw new Error("unit integration contains a foreign or non-materializable checkpoint");
    return {
      checkpoint,
      outputSubject: checkpoint.output_subject,
      pointer: checkpoint.payload.blob,
    };
  });
  let aggregateBundleBytes = 0;
  for (const { pointer } of sealedCheckpoints) {
    if (pointer.bytes > KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES - aggregateBundleBytes) {
      throw new Error("unit integration exceeds the aggregate sealed bundle byte ceiling");
    }
    aggregateBundleBytes += pointer.bytes;
  }
  const candidates: { checkpoint: AttemptCheckpoint; bytes: Uint8Array }[] = [];
  const proofCheckpoints: { checkpoint: AttemptCheckpoint; bytes: Uint8Array }[] = [];
  for (const { checkpoint, outputSubject, pointer } of sealedCheckpoints) {
    const bytes = input.blobs.read(pointer);
    const advertised = inspectKernelCheckpointBundleAdvertisement({
      bytes,
      expected_commit: outputSubject,
    });
    if (advertised.ref.startsWith("refs/openthrottle/checkpoints/")) {
      candidates.push({ checkpoint, bytes });
    } else if (advertised.ref.startsWith("refs/openthrottle/integrations/")) {
      proofCheckpoints.push({ checkpoint, bytes });
    } else {
      throw new Error("unit integration checkpoint has an unsupported sealed ref");
    }
  }
  if (candidates.length !== 1) {
    throw new Error("unit integration requires one exact ordinary candidate checkpoint");
  }
  const candidate = candidates[0]!.checkpoint;
  const candidateArtifact = descriptor(
    input.blobs,
    candidate,
    input.checkpoint_base_subject,
    proofCheckpoints.length === 0 &&
      candidate.input_subject !== input.current_subject &&
      candidate.output_subject !== input.current_subject
      ? { ancestor: input.current_subject, descendant: candidate.input_subject }
      : undefined,
    candidates[0]!.bytes,
  );
  if (!candidateArtifact.ref.startsWith("refs/openthrottle/checkpoints/")) {
    throw new Error("unit integration candidate is not an ordinary checkpoint ref");
  }
  const proof = proofCheckpoints.map(({ checkpoint, bytes }) => {
    const checkpointArtifact = descriptor(
      input.blobs,
      checkpoint,
      checkpoint.input_subject,
      undefined,
      bytes,
    );
    if (!checkpointArtifact.ref.startsWith("refs/openthrottle/integrations/")) {
      throw new Error("unit integration ancestry is not an integration checkpoint ref");
    }
    if (checkpoint.output_subject === checkpoint.input_subject) {
      throw new Error("unit integration ancestry contains a non-advancing edge");
    }
    return {
      checkpoint_id: checkpoint.id,
      input_subject: checkpoint.input_subject,
      output_subject: checkpoint.output_subject!,
      checkpoint_blob: (checkpoint.payload as { blob: BlobPointer }).blob,
      checkpoint_artifact: checkpointArtifact,
    };
  });
  const byInput = new Map<string, PreparedIntegrationAncestryEntry[]>();
  for (const edge of proof) {
    const matches = byInput.get(edge.input_subject) ?? [];
    matches.push(edge);
    byInput.set(edge.input_subject, matches);
  }
  const ordered: PreparedIntegrationAncestryEntry[] = [];
  const consumed = new Set<string>();
  let cursor = candidate.input_subject;
  while (cursor !== input.current_subject && proof.length > 0) {
    const matches = (byInput.get(cursor) ?? []).filter((edge) => !consumed.has(edge.checkpoint_id));
    if (matches.length === 0) throw new Error("unit integration current ancestry contains a gap");
    if (matches.length > 1) throw new Error("unit integration current ancestry contains a fork");
    const edge = matches[0]!;
    if (consumed.has(edge.checkpoint_id) || ordered.some(({ output_subject }) =>
      output_subject === edge.output_subject)) {
      throw new Error("unit integration current ancestry contains a cycle or duplicate edge");
    }
    consumed.add(edge.checkpoint_id);
    ordered.push(edge);
    cursor = edge.output_subject;
  }
  if (proof.length > 0 && cursor !== input.current_subject) {
    throw new Error("unit integration current ancestry does not end at the current subject");
  }
  if (consumed.size !== proof.length) {
    throw new Error("unit integration current ancestry contains disconnected extra checkpoints");
  }
  return { candidate, candidate_artifact: candidateArtifact, current_ancestry: ordered };
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
    subject_policy: "advance",
    phases: publishShape.phases,
    async prepare({ run, attempt, context, bundle }) {
      const environment = input.environments.loadExactRunEnvironment(run.id);
      const candidate = exactGitCheckpoint({
        checkpoints: context.checkpoints,
        // The external Attempt's input is the immutable private candidate.
        // core/publish advances run.current_subject to the compacted public P
        // after phase zero, so recovery must not reinterpret P as the candidate.
        output_subject: attempt.input_subject,
      });
      const artifact = descriptor(input.blob_store, candidate, bundle.source_commit);
      const taskBranch = branch(run.id, environment.source_reference);
      const taskRef = `refs/heads/${taskBranch}`;
      const anchor = latestConfirmedTaskRefPush({
        records: context.records,
        pipeline_run_id: run.id,
        repository: environment.repository,
        ref: taskRef,
        source_commit: bundle.source_commit,
      });
      const identity = persistedRuntimeIdentity(context.records);
      return {
        verified_output_subject: null,
        checkpoint_payload: {
          candidate_checkpoint_id: candidate.id,
          checkpoint_base_subject: bundle.source_commit,
          publication_parent_subject: anchor.subject,
          publication_ref_mode: anchor.ref_mode,
          publication_parent_delivery_record_id: anchor.delivery_record_id,
          ref: taskRef,
        },
        phases: [
          { id: "integrate-checkpoint", effects: [{
            kind: "daytona/integrate-checkpoint@1",
            idempotency_key: `${run.id}:${attempt.id}:publish-integrate:${anchor.subject}:${candidate.id}`,
            target: `daytona:${identity}:publication:${candidate.id}:${anchor.subject}`,
            subject: null,
            payload: {
              schema: "openthrottle.daytona-integration/v1",
              identity,
              pipeline_run_id: run.id,
              attempt_id: attempt.id,
              definition_bundle_hash: run.definition_bundle_hash,
              checkpoint_base_subject: bundle.source_commit,
              current_subject: anchor.subject,
              candidate_checkpoint_id: candidate.id,
              candidate_input_subject: candidate.input_subject,
              candidate_output_subject: candidate.output_subject!,
              candidate_blob: (candidate.payload as { blob: BlobPointer }).blob as unknown as JsonValue,
              candidate_artifact: artifact,
              current_ancestry: [],
            },
          }] },
          { id: "push-checkpoint", effects: [{
            kind: "github/push-checkpoint@1",
            idempotency_key: `${run.id}:${attempt.id}:publish-push:pending`,
            target: `github:${environment.repository}:pending-publication`,
            subject: null,
            payload: { schema: "openthrottle.pending-publication-push/v1" },
          }] },
          { id: "pull-request", effects: [{
            kind: "github/upsert-pull-request@1",
            idempotency_key: `${run.id}:${attempt.id}:pull-request:pending`,
            target: `github:${environment.repository}:pending-pull-request`,
            subject: null,
            payload: { schema: "openthrottle.pending-pull-request/v1" },
          }] },
        ],
      };
    },
    async promote({ run, attempt, prepared, schedules }) {
      const delivery = schedules[0]?.effects[0]?.delivery;
      if (!delivery || delivery.status !== "confirmed") {
        throw new Error("publication promotion lacks confirmed compaction delivery");
      }
      const evidence = deliveryResult(delivery);
      const planning = prepared.checkpoint_payload as Record<string, unknown>;
      const publicationParent = planning.publication_parent_subject;
      const refMode = planning.publication_ref_mode;
      const taskRef = planning.ref;
      const checkpointBaseSubject = planning.checkpoint_base_subject;
      if (
        typeof publicationParent !== "string" || !/^[a-f0-9]{40,64}$/.test(publicationParent) ||
        (refMode !== "create" && refMode !== "update") ||
        typeof taskRef !== "string" || !/^refs\/heads\/ot\//.test(taskRef) ||
        typeof checkpointBaseSubject !== "string" || !/^[a-f0-9]{40,64}$/.test(checkpointBaseSubject) ||
        evidence.schema !== "openthrottle.daytona-integration-delivery/v1" ||
        evidence.state !== "integrated" || evidence.input_subject !== publicationParent ||
        typeof evidence.output_subject !== "string" || typeof evidence.checkpoint_id !== "string" ||
        evidence.checkpoint_payload_schema !== GIT_BUNDLE_SCHEMA ||
        !evidence.checkpoint_blob || typeof evidence.checkpoint_blob !== "object" ||
        Array.isArray(evidence.checkpoint_blob)
      ) throw new Error("publication compaction delivery is not promotable from its sealed parent");
      const output = evidence.output_subject;
      const checkpoint: AttemptCheckpoint = {
        schema: ATTEMPT_CHECKPOINT_SCHEMA,
        id: evidence.checkpoint_id,
        pipeline_run_id: run.id,
        attempt_id: attempt.id,
        request_hash: attempt.request_hash,
        definition_bundle_hash: attempt.definition_bundle_hash,
        input_subject: publicationParent,
        output_subject: output,
        native_session_id: null,
        payload_schema: GIT_BUNDLE_SCHEMA,
        payload: { blob: evidence.checkpoint_blob as BlobPointer },
        captured_at: delivery.created_at,
      };
      const environment = input.environments.loadExactRunEnvironment(run.id);
      const taskBranch = branch(run.id, environment.source_reference);
      if (taskRef !== `refs/heads/${taskBranch}`) {
        throw new Error("publication compaction changed its deterministic task ref");
      }
      const artifact = descriptor(input.blob_store, checkpoint, publicationParent);
      const promoted: KernelPreparedExternalPlan = {
        ...prepared,
        verified_output_subject: output,
        phases: [prepared.phases[0]!, {
          id: "push-checkpoint",
          effects: [{
            kind: "github/push-checkpoint@1",
            idempotency_key: `${run.id}:publish-push:${refMode}:${publicationParent}:${output}`,
            target: `github:${environment.repository}:${taskRef}`,
            subject: output,
            payload: {
              schema: "openthrottle.github-push-checkpoint/v1",
              ref_mode: refMode,
              repository: environment.repository,
              ref: taskRef,
              expected_old_subject: publicationParent,
              expected_new_subject: output,
              checkpoint_base_subject: publicationParent,
              checkpoint_blob: evidence.checkpoint_blob as JsonValue,
              checkpoint_tree: artifact.tree,
            },
          }],
        }, {
          id: "pull-request",
          effects: [{
            kind: "github/upsert-pull-request@1",
            idempotency_key: `${run.id}:pull-request:${output}`,
            target: `github:${environment.repository}:pull:${taskBranch}`,
            subject: output,
            payload: {
              schema: "openthrottle.github-pull-request/v1",
              repository: environment.repository,
              branch: taskBranch,
              base_branch: environment.base_branch,
              expected_head_subject: output,
              title: environment.title.slice(0, 256),
              body: `OpenThrottle execution ${run.id} for ${environment.source_reference}.`,
              ownership_marker: `openthrottle:run:${digestCanonicalJson({ run_id: run.id })}`,
            },
          }],
        }],
      };
      return { prepared: promoted, checkpoint, delivery_record_id: delivery.id };
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
    async prepare({ run, attempt, context, bundle }) {
      const environment = input.environments.loadExactRunEnvironment(run.id);
      const selected = exactIntegrationCheckpointContext({
        checkpoints: context.checkpoints,
        blobs: input.blob_store,
        pipeline_run_id: run.id,
        definition_bundle_hash: run.definition_bundle_hash,
        checkpoint_base_subject: bundle.source_commit,
        current_subject: attempt.input_subject,
      });
      const candidate = selected.candidate;
      const artifact = selected.candidate_artifact;
      const identity = persistedRuntimeIdentity(context.records);
      const taskBranch = branch(run.id, environment.source_reference);
      const taskRef = `refs/heads/${taskBranch}`;
      const anchor = latestConfirmedTaskRefPush({
        records: context.records,
        pipeline_run_id: run.id,
        repository: environment.repository,
        ref: taskRef,
        source_commit: bundle.source_commit,
      });
      if (anchor.subject !== attempt.input_subject) {
        throw new Error("unit integration task-ref evidence does not match its exact input subject");
      }
      return {
        verified_output_subject: null,
        checkpoint_payload: {
          candidate_checkpoint_id: candidate.id,
          checkpoint_base_subject: bundle.source_commit,
          publication_ref_mode: anchor.ref_mode,
          publication_parent_subject: anchor.subject,
        },
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
              checkpoint_base_subject: bundle.source_commit,
              current_subject: attempt.input_subject,
              candidate_checkpoint_id: candidate.id,
              candidate_input_subject: candidate.input_subject,
              candidate_output_subject: candidate.output_subject!,
              candidate_blob: (candidate.payload as { blob: BlobPointer }).blob as unknown as JsonValue,
              candidate_artifact: artifact,
              current_ancestry: selected.current_ancestry as unknown as JsonValue,
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
      const preparedCheckpoint = prepared.checkpoint_payload as Record<string, unknown>;
      const checkpointBaseSubject = preparedCheckpoint.checkpoint_base_subject;
      const refMode = preparedCheckpoint.publication_ref_mode;
      const publicationParent = preparedCheckpoint.publication_parent_subject;
      if (typeof checkpointBaseSubject !== "string" || !/^[a-f0-9]{40,64}$/.test(checkpointBaseSubject)) {
        throw new Error("integration promotion lost its sealed checkpoint base subject");
      }
      if (
        (refMode !== "create" && refMode !== "update") ||
        publicationParent !== attempt.input_subject
      ) throw new Error("integration promotion lost its sealed task-ref authority");
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
      const artifact = descriptor(input.blob_store, checkpoint, attempt.input_subject);
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
              ref_mode: refMode,
              repository: environment.repository,
              ref: `refs/heads/${taskBranch}`,
              expected_old_subject: attempt.input_subject,
              expected_new_subject: output,
              checkpoint_base_subject: attempt.input_subject,
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
    async prepare({ run, bundle }) {
      const environment = input.environments.loadExactRunEnvironment(run.id);
      const policy = githubProviderEvidencePolicy(bundle);
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
            policy: policy as unknown as JsonValue,
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
