import {
  canonicalJson,
  digestCanonicalJson,
  type EffectIntent,
  type TrustedCompilerEnvironment,
  type TrustedPlatformDefinitionSource,
} from "@openthrottle/contracts";
import type { KernelEffectAdapterBinding } from "../../app/kernel-effect-ports.js";
import {
  admissionPlannerEvidence,
  approvedAdmissionReviewEvidence,
  createAdmissionPromotionRecord,
} from "../../app/kernel-admission-promotion.js";
import { promoteKernelPipeline } from "../../app/kernel-admission.js";
import type { VolumeBlobStore } from "../../persistence/blob-store.js";
import type { SqliteKernelStore } from "../../persistence/kernel-store.js";
import type { ExactDefinitionSourceReader } from "../../pipeline/definition-compilation.js";
import type { KernelRuntimeCompatibilityPort } from "../../runtime/kernel-contracts.js";

const INTENT_SCHEMA = "openthrottle.kernel-admission-promotion-intent/v1" as const;
const DELIVERY_SCHEMA = "openthrottle.kernel-admission-promotion-delivery/v1" as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SUBJECT = /^[a-f0-9]{40,64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface PromotionIntentPayload {
  schema: typeof INTENT_SCHEMA;
  source_pipeline_run_id: string;
  source_attempt_id: string;
  work_item_id: string;
  repository: string;
  source_commit: string;
  selected_pipeline: "core/implement" | "core/structured";
  target_run_id: string;
  target_initial_attempt_id: string;
  planner_result_id: string;
  planner_result_hash: string;
  reviewer_result_id: string;
  reviewer_result_hash: string;
}

function exactObject(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: must be an object`);
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => !keys.includes(key));
  if (unknown) throw new Error(`${path}.${unknown}: unknown field`);
  return input;
}

function exactString(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${path}: is invalid`);
  return value;
}

function promotionPayload(intent: Readonly<EffectIntent>): PromotionIntentPayload {
  if (intent.kind !== "kernel/promote-admission@1") {
    throw new Error("kernel admission adapter received another effect kind");
  }
  const input = exactObject(intent.payload, "promotion_intent", [
    "schema", "source_pipeline_run_id", "source_attempt_id", "work_item_id", "repository",
    "source_commit", "selected_pipeline", "target_run_id", "target_initial_attempt_id",
    "planner_result_id", "planner_result_hash", "reviewer_result_id", "reviewer_result_hash",
  ]);
  if (input.schema !== INTENT_SCHEMA) throw new Error(`promotion_intent.schema: must be ${INTENT_SCHEMA}`);
  if (input.selected_pipeline !== "core/implement" && input.selected_pipeline !== "core/structured") {
    throw new Error("promotion_intent.selected_pipeline: is unsupported");
  }
  const payload: PromotionIntentPayload = {
    schema: INTENT_SCHEMA,
    source_pipeline_run_id: exactString(input.source_pipeline_run_id, "promotion_intent.source_pipeline_run_id", ID),
    source_attempt_id: exactString(input.source_attempt_id, "promotion_intent.source_attempt_id", ID),
    work_item_id: exactString(input.work_item_id, "promotion_intent.work_item_id", ID),
    repository: exactString(input.repository, "promotion_intent.repository", REPOSITORY),
    source_commit: exactString(input.source_commit, "promotion_intent.source_commit", SUBJECT),
    selected_pipeline: input.selected_pipeline,
    target_run_id: exactString(input.target_run_id, "promotion_intent.target_run_id", ID),
    target_initial_attempt_id: exactString(
      input.target_initial_attempt_id,
      "promotion_intent.target_initial_attempt_id",
      ID,
    ),
    planner_result_id: exactString(input.planner_result_id, "promotion_intent.planner_result_id", ID),
    planner_result_hash: exactString(input.planner_result_hash, "promotion_intent.planner_result_hash", SHA256),
    reviewer_result_id: exactString(input.reviewer_result_id, "promotion_intent.reviewer_result_id", ID),
    reviewer_result_hash: exactString(input.reviewer_result_hash, "promotion_intent.reviewer_result_hash", SHA256),
  };
  if (
    intent.target !== `kernel:run:${payload.target_run_id}` || intent.subject !== payload.source_commit
  ) throw new Error("promotion effect identity does not match its target run and exact subject");
  return payload;
}

export class KernelAdmissionPromotionAdapter {
  readonly #sourceReader: ExactDefinitionSourceReader;
  readonly #platform: TrustedPlatformDefinitionSource;
  readonly #compilerEnvironment: TrustedCompilerEnvironment;
  readonly #runtime: KernelRuntimeCompatibilityPort;
  readonly #blobs: VolumeBlobStore;
  readonly #store: SqliteKernelStore;
  readonly #workRetryLimit: number;
  readonly #resultCorrectionLimit: number;

  constructor(input: {
    source_reader: ExactDefinitionSourceReader;
    platform: TrustedPlatformDefinitionSource;
    compiler_environment: TrustedCompilerEnvironment;
    runtime: KernelRuntimeCompatibilityPort;
    blob_store: VolumeBlobStore;
    store: SqliteKernelStore;
    work_retry_limit: number;
    result_correction_limit: number;
  }) {
    this.#sourceReader = input.source_reader;
    this.#platform = input.platform;
    this.#compilerEnvironment = input.compiler_environment;
    this.#runtime = input.runtime;
    this.#blobs = input.blob_store;
    this.#store = input.store;
    this.#workRetryLimit = input.work_retry_limit;
    this.#resultCorrectionLimit = input.result_correction_limit;
  }

  effectBinding(): KernelEffectAdapterBinding {
    return {
      effect_kind: "kernel/promote-admission@1",
      provider: "kernel",
      operation: "mutation",
      idempotency_strategy: "deterministic_target",
      adapter: {
        reconcile: async ({ intent, external_identity }) => {
          if (external_identity !== intent.target) throw new Error("promotion reconciliation target changed");
          const payload = promotionPayload(intent);
          const evidence = await this.#loadEvidence(payload);
          const attached = this.#store.findAttachedPipelineRun(payload.target_run_id);
          if (!attached) return { kind: "not_found" } as const;
          if (
            attached.work_item_id !== payload.work_item_id ||
            attached.pipeline_id !== payload.selected_pipeline ||
            attached.current_subject !== payload.source_commit
          ) throw new Error("deterministic promotion target conflicts with an existing pipeline run");
          const target = await this.#store.loadAttemptRequestInputs({
            pipeline_run_id: payload.target_run_id,
            attempt_id: payload.target_initial_attempt_id,
          });
          const targetRecords = [...target.context.records.values()];
          if (
            target.task_prompt !== evidence.task_prompt || targetRecords.length !== 1 ||
            canonicalJson(targetRecords[0]) !== canonicalJson(evidence.promotion_record)
          ) throw new Error("attached promotion target does not preserve its exact executor decision");
          return {
            kind: "found",
            status: "confirmed",
            payload: {
              schema: DELIVERY_SCHEMA,
              state: "attached",
              target_run_id: attached.id,
              selected_pipeline: attached.pipeline_id,
              definition_bundle_hash: attached.definition_bundle_hash,
              source_commit: attached.current_subject,
            },
          } as const;
        },
        dispatch: async ({ intent, external_identity, deduplication }) => {
          if (
            external_identity !== intent.target || deduplication.strategy !== "deterministic_target" ||
            deduplication.target !== intent.target || deduplication.key !== intent.idempotency_key
          ) throw new Error("promotion dispatch lost its deterministic idempotency fence");
          const payload = promotionPayload(intent);
          const evidence = await this.#loadEvidence(payload);
          await promoteKernelPipeline({
            repository: payload.repository,
            source_commit: payload.source_commit,
            selected_pipeline: payload.selected_pipeline,
            source_reader: this.#sourceReader,
            platform: this.#platform,
            compiler_environment: this.#compilerEnvironment,
            runtime_compatibility: this.#runtime,
            blob_store: this.#blobs,
            store: this.#store,
            work_item_id: payload.work_item_id,
            source_pipeline_run_id: payload.source_pipeline_run_id,
            task_prompt: evidence.task_prompt,
            promotion_record: evidence.promotion_record,
            identity: {
              pipeline_run_id: payload.target_run_id,
              initial_attempt_id: payload.target_initial_attempt_id,
            },
            work_retry_limit: this.#workRetryLimit,
            result_correction_limit: this.#resultCorrectionLimit,
          });
        },
      },
    };
  }

  async #loadEvidence(payload: PromotionIntentPayload) {
    const view = await this.#store.loadExactReductionView({
      pipeline_run_id: payload.source_pipeline_run_id,
      attempt_id: payload.source_attempt_id,
      record_ids: [payload.planner_result_id, payload.reviewer_result_id].sort(),
      checkpoint_ids: [],
    });
    if (
      view.run.pipeline_id !== "core/admission" ||
      view.run.current_subject !== payload.source_commit ||
      view.current_attempt?.id !== payload.source_attempt_id
    ) throw new Error("promotion evidence does not belong to the active admission boundary");
    const attempt = view.current_attempt;
    if (
      !attempt.context_record_ids.includes(payload.planner_result_id) ||
      !attempt.context_record_ids.includes(payload.reviewer_result_id)
    ) throw new Error("promotion evidence is outside the sealed effect Attempt context");
    const plannerRecord = view.records.get(payload.planner_result_id);
    const reviewerRecord = view.records.get(payload.reviewer_result_id);
    if (
      !plannerRecord || digestCanonicalJson(plannerRecord) !== payload.planner_result_hash ||
      !reviewerRecord || digestCanonicalJson(reviewerRecord) !== payload.reviewer_result_hash
    ) throw new Error("promotion evidence hashes do not match their exact ResultRecords");
    const planner = admissionPlannerEvidence(plannerRecord);
    const reviewer = approvedAdmissionReviewEvidence(reviewerRecord);
    if (!planner || !reviewer) throw new Error("promotion evidence is not an executable reviewed admission");
    const selected = planner.route === "structured" ? "core/structured" : "core/implement";
    if (selected !== payload.selected_pipeline) {
      throw new Error("promotion selection does not match the executor-validated planner route");
    }
    const request = await this.#store.loadAttemptRequestInputs({
      pipeline_run_id: payload.source_pipeline_run_id,
      attempt_id: payload.source_attempt_id,
    });
    return {
      task_prompt: request.task_prompt,
      promotion_record: createAdmissionPromotionRecord({
        target_run_id: payload.target_run_id,
        source_run_id: payload.source_pipeline_run_id,
        source_attempt_id: payload.source_attempt_id,
        source_commit: payload.source_commit,
        planner,
        reviewer,
        created_at: reviewer.created_at,
      }),
    };
  }
}
