import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ATTEMPT_CHECKPOINT_SCHEMA,
  COMPILED_PIPELINE_MANIFEST_SCHEMA,
  DEFINITION_BUNDLE_SCHEMA,
  EVAL_DEFINITION_SCHEMA,
  EXECUTION_RECORD_SCHEMA,
  RELEASE_COMPILER_ENVIRONMENT_DIGEST,
  RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
  SEMANTIC_RESULT_SCHEMA,
  compileDefinitionBundle,
  definitionEntryContentHash,
  digestCanonicalJson,
  runtimeStopStageId,
  verifyCompilerEnvironment,
  verifyPlatformDefinitionSource,
  type AttemptCheckpoint,
  type CompilerEnvironmentDescriptor,
  type CompiledPipelineManifest,
  type DecisionRecord,
  type DeliveryRecord,
  type DefinitionBundle,
  type DefinitionBundleEntry,
  type ExecutionRecord,
  type PlatformDefinitionCatalog,
  type ResultRecord,
  type VirtualDefinitionFile,
} from "@openthrottle/contracts";
import type { ReductionView } from "./ports.js";
import { selectKernelAction } from "./action-request.js";
import { compileKernelCursor, frontierMemberKey } from "./reducer.js";
import {
  KERNEL_ATTEMPT_SCHEMA,
  KERNEL_RUN_SCHEMA,
  type KernelAttempt,
} from "./types.js";
import {
  buildStructuredProvisionSettlement,
  compileReviewFanoutFrontier,
  compileStructuredLoopFrontier,
  createBlockingReviewRemediationAttempt,
  createStructuredIntegrationAttempt,
  parseStructuredExecutionPlan,
  selectedStructuredReviewPersonas,
  type StructuredAcceptedUnitEvidence,
  type StructuredIntegrationEvidence,
  type StructuredMemberCompletionEvidence,
} from "./structured-coordinator.js";

const NOW = "2026-08-20T12:00:00.000Z";
const SOURCE = "1".repeat(40);
const UNIT_OUTPUT = "2".repeat(40);
const CURRENT_SUBJECT = "3".repeat(40);
const CAPABILITY = "c".repeat(64);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function filesBelow(root: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const candidate of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const path = join(directory, candidate.name);
      if (candidate.isDirectory()) visit(path);
      else if (candidate.isFile()) paths.push(path);
      else throw new Error(`${path}: definitions must be regular files`);
    }
  };
  visit(root);
  return paths;
}

function actualStructuredDefinitions(): {
  bundle: DefinitionBundle;
  manifest: CompiledPipelineManifest;
} {
  const definitionRoot = join(REPOSITORY_ROOT, ".openthrottle");
  const files = new Map<string, VirtualDefinitionFile>(filesBelow(definitionRoot).map((path) => [
    `.openthrottle/${relative(definitionRoot, path)}`,
    { type: "file", content: readFileSync(path) },
  ]));
  const configPath = ".openthrottle/config.yml";
  const configFile = files.get(configPath);
  if (!configFile || configFile.type !== "file") throw new Error("root config is missing");
  const selectedConfig = Buffer.from(configFile.content).toString("utf8")
    .replace(/^pipeline: .*$/m, "pipeline: core/structured");
  files.delete(configPath);
  const generatedRoot = join(REPOSITORY_ROOT, "contracts/generated");
  const platformCatalog = JSON.parse(readFileSync(
    join(generatedRoot, "platform-definition-catalog.json"),
    "utf8",
  )) as PlatformDefinitionCatalog;
  const compilerEnvironment = JSON.parse(readFileSync(
    join(generatedRoot, "compiler-environment.json"),
    "utf8",
  )) as CompilerEnvironmentDescriptor;
  const compilation = compileDefinitionBundle({
    repository: {
      source_commit: SOURCE,
      files: new Map([[configPath, { type: "file", content: selectedConfig }]]),
    },
    platform: verifyPlatformDefinitionSource(
      platformCatalog,
      files,
      RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
    ),
    compiler_environment: verifyCompilerEnvironment(
      compilerEnvironment,
      RELEASE_COMPILER_ENVIRONMENT_DIGEST,
    ),
    selected_pipeline: "core/structured",
  });
  return { bundle: compilation.bundle.value, manifest: compilation.manifest.value };
}

function entry(
  definition_kind: DefinitionBundleEntry["definition_kind"],
  definition_id: string,
  normalized_payload: unknown,
): DefinitionBundleEntry {
  const path = definition_kind === "config"
    ? ".openthrottle/config.yml"
    : definition_kind === "agent"
      ? `.openthrottle/agents/${definition_id}/instructions.md`
      : definition_kind === "pipeline"
        ? `.openthrottle/pipelines/${definition_id}/pipeline.yml`
        : definition_kind === "skill"
          ? `.openthrottle/skills/${definition_id}/SKILL.md`
          : `.openthrottle/evals/${definition_id}/eval.yml`;
  return {
    definition_kind,
    definition_id,
    origin: { kind: "platform", source_commit: null },
    path,
    content_hash: definitionEntryContentHash(normalized_payload),
    normalized_payload,
  };
}

function evaluation(id: string, evaluator: string): unknown {
  const findings = evaluator === "core/review-outcome@1"
    ? { type: "review_finding_list_v1", max_items: 64 }
    : {
      type: "string_list",
      max_length: 2_000,
      max_items: 50,
    };
  return {
    schema: EVAL_DEFINITION_SCHEMA,
    id,
    evaluator,
    result: {
      schema: SEMANTIC_RESULT_SCHEMA,
      id,
      outcomes: ["success", "no_change", "semantic_repair_required", "needs_human", "failure"],
      payload: {
        summary: { type: "string", max_length: 1_000 },
        findings,
      },
    },
  };
}

function definitions(): { bundle: DefinitionBundle; manifest: CompiledPipelineManifest } {
  const stages: CompiledPipelineManifest["stages"] = [
    {
      id: "unit", kind: "agent", engine: "codex", agent_id: "core/unit-worker",
      repository_authority: "edit", skills: ["core/unit"], entry_skill: "core/unit",
      eval: "core/action-result",
      loop: { over: "execution_plan.units", max_parallel: 4, max_rounds: 8, body: ["unit"] },
      on: { success: { to: "integration" }, failure: { terminal: "failed" } },
    },
    {
      id: "integration", kind: "effect", effect: "core/integrate-unit@1",
      on: {
        next_integration: { to: "integration", max_reentries: 64, on_exhausted: "needs_human" },
        next_unit: { to: "unit", max_reentries: 64, on_exhausted: "needs_human" },
        all_integrated: { to: "review" },
        failure: { terminal: "needs_human" },
      },
    },
    {
      id: "review", kind: "agent", engine: "codex", agent_id: "core/reviewer",
      repository_authority: "inspect",
      skills: [
        "core/correctness", "core/performance", "core/reliability", "core/security", "core/tests",
      ],
      eval: "core/review-result",
      loop: { over: "selection.personas", max_parallel: 5, max_rounds: 1, body: ["review"] },
      on: {
        success: { terminal: "completed" },
        semantic_repair_required: { to: "remediation" },
        failure: { terminal: "failed" },
      },
    },
    {
      id: "remediation", kind: "agent", engine: "codex", agent_id: "core/unit-worker",
      repository_authority: "edit", skills: ["core/remediate"], entry_skill: "core/remediate",
      eval: "core/action-result",
      on: { success: { to: "review" }, failure: { terminal: "needs_human" } },
    },
    ...(["needs_human", "canceled", "superseded"] as const).map((outcome) => ({
      id: runtimeStopStageId(outcome),
      kind: "effect" as const,
      effect: "core/daytona-stop@1",
      on: { success: { terminal: outcome } },
    })),
  ];
  const entries = [
    entry("config", "repository", { schema: "openthrottle.config/v2", pipeline: "core/structured", engine: "codex" }),
    entry("pipeline", "core/structured", { id: "core/structured", stages: ["unit", "integration", "review", "remediation"] }),
    entry("agent", "core/unit-worker", "Perform only the sealed edit action."),
    entry("agent", "core/reviewer", "Inspect only the sealed subject."),
    entry("skill", "core/unit", { instructions: "Implement the unit." }),
    entry("skill", "core/correctness", { instructions: "Review correctness." }),
    entry("skill", "core/security", { instructions: "Review security." }),
    entry("skill", "core/performance", { instructions: "Review performance." }),
    entry("skill", "core/reliability", { instructions: "Review reliability." }),
    entry("skill", "core/tests", { instructions: "Review tests." }),
    entry("skill", "core/remediate", { instructions: "Repair only the blocking finding." }),
    entry("eval", "core/action-result", evaluation("core/action-result", "core/action-outcome@1")),
    entry("eval", "core/review-result", evaluation("core/review-result", "core/review-outcome@1")),
  ];
  const bundle: DefinitionBundle = {
    schema: DEFINITION_BUNDLE_SCHEMA,
    compiler_version: "definition-compiler/v1",
    runtime_capability_digest: CAPABILITY,
    source_commit: SOURCE,
    pipeline_id: "core/structured",
    pipeline_selection: "explicit",
    entries,
  };
  return {
    bundle,
    manifest: {
      schema: COMPILED_PIPELINE_MANIFEST_SCHEMA,
      pipeline_id: "core/structured",
      pipeline_version: 1,
      entry_stage: "unit",
      definition_bundle_hash: digestCanonicalJson(bundle),
      compiler_version: "definition-compiler/v1",
      runtime_capability_digest: CAPABILITY,
      stages,
    },
  };
}

function actionInputs(label: string) {
  return { task_prompt: `Execute ${label}.`, context: { records: [], checkpoints: [] } };
}

function reviewActionInputs(label: string) {
  const { manifest } = definitions();
  const checkpoint: AttemptCheckpoint = {
    schema: ATTEMPT_CHECKPOINT_SCHEMA,
    id: "checkpoint-integrated-change",
    pipeline_run_id: "run-1",
    attempt_id: "attempt-integration",
    request_hash: "8".repeat(64),
    definition_bundle_hash: manifest.definition_bundle_hash,
    input_subject: SOURCE,
    output_subject: CURRENT_SUBJECT,
    native_session_id: "session-integration",
    payload_schema: "openthrottle.executor-checkpoint/v1",
    payload: { inline: { verified: true } },
    captured_at: NOW,
  };
  return {
    task_prompt: `Execute ${label}.`,
    context: { records: [], checkpoints: [checkpoint] },
  };
}

function pendingAttempt(input: {
  id: string;
  stage_id?: string;
  kind?: "loop_item" | "fanout_member";
  index?: number;
  authority?: "inspect" | "edit";
  manifest?: CompiledPipelineManifest;
}): KernelAttempt {
  const stageId = input.stage_id ?? "unit";
  const scope = input.kind === "fanout_member"
    ? {
      kind: "fanout_member" as const, stage_id: stageId, parent_attempt_id: "parent",
      fanout_id: "reviews", member_id: input.id, member_index: input.index ?? 0,
    }
    : {
      kind: "loop_item" as const, stage_id: stageId, parent_attempt_id: "parent",
      loop_id: "units", item_id: input.id, item_index: input.index ?? 0,
    };
  return {
    schema: KERNEL_ATTEMPT_SCHEMA,
    id: `attempt-${input.id}`,
    pipeline_run_id: "run-1",
    scope,
    repository_authority: input.authority ?? "edit",
    request_hash: digestCanonicalJson({ id: input.id }),
    definition_bundle_hash: input.manifest?.definition_bundle_hash ?? definitions().manifest.definition_bundle_hash,
    input_subject: CURRENT_SUBJECT,
    context_record_ids: [],
    context_checkpoint_ids: [],
    output_subject: null,
    native_session_id: null,
    status: "pending",
    version: 0,
    work_retry_ordinal: 0,
    result_correction_count: 0,
    result_correction_deadline: null,
    lease: null,
    checkpoint_id: null,
    result_record_id: null,
    decision_record_id: null,
    pending_result: null,
  };
}

function memberCompletionEvidence(
  memberId = "unit-a",
  index = 0,
  manifest = definitions().manifest,
  stageId = "unit",
): StructuredMemberCompletionEvidence {
  const base = pendingAttempt({ id: memberId, index, stage_id: stageId, manifest });
  const checkpoint: AttemptCheckpoint = {
    schema: ATTEMPT_CHECKPOINT_SCHEMA,
    id: `checkpoint-${memberId}`,
    pipeline_run_id: base.pipeline_run_id,
    attempt_id: base.id,
    request_hash: base.request_hash,
    definition_bundle_hash: base.definition_bundle_hash,
    input_subject: base.input_subject,
    output_subject: UNIT_OUTPUT,
    native_session_id: `session-${memberId}`,
    payload_schema: "openthrottle.executor-checkpoint/v1",
    payload: { inline: { verified: true } },
    captured_at: NOW,
  };
  const result: ResultRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `result-${memberId}`,
    kind: "result",
    pipeline_run_id: base.pipeline_run_id,
    attempt_id: base.id,
    request_hash: base.request_hash,
    definition_bundle_hash: base.definition_bundle_hash,
    input_subject: base.input_subject,
    output_subject: UNIT_OUTPUT,
    original_candidate_hash: "4".repeat(64),
    normalized_candidate_hash: "5".repeat(64),
    payload_schema: "openthrottle.semantic-result-record/v1",
    payload: { inline: { outcome: "success" } },
    created_at: NOW,
  };
  const decision: DecisionRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `decision-${memberId}`,
    kind: "decision",
    pipeline_run_id: base.pipeline_run_id,
    reducer: "core/unit-outcome@1",
    input_record_ids: [result.id],
    payload_schema: "openthrottle.pipeline-decision-record/v1",
    payload: {
      inline: {
        schema: "openthrottle.pipeline-decision-record/v1",
        stage_id: stageId,
        evaluator: "core/unit-outcome@1",
        outcome: "success",
        reason: "validated_semantic_result",
      },
    },
    created_at: NOW,
  };
  return {
    member_id: memberId,
    attempt: {
      ...base,
      status: "settled",
      version: 4,
      output_subject: UNIT_OUTPUT,
      native_session_id: checkpoint.native_session_id,
      checkpoint_id: checkpoint.id,
      result_record_id: result.id,
    },
    checkpoint,
    result,
    decision,
  };
}

function acceptedUnitEvidence(
  memberId = "unit-a",
  index = 0,
  manifest = definitions().manifest,
  acceptanceStageId = "accept",
  candidateStageId = "unit",
): StructuredAcceptedUnitEvidence {
  const candidate = memberCompletionEvidence(memberId, index, manifest, candidateStageId);
  const action_inputs = {
    task_prompt: `Accept ${memberId}.`,
    context: {
      records: [candidate.decision, candidate.result]
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      checkpoints: [candidate.checkpoint],
    },
  };
  const base = pendingAttempt({
    id: `accept-${memberId}`,
    index,
    stage_id: acceptanceStageId,
    authority: "inspect",
    manifest,
  });
  const pending: KernelAttempt = {
    ...base,
    scope: {
      kind: "loop_item",
      stage_id: acceptanceStageId,
      parent_attempt_id: "parent",
      loop_id: "units",
      item_id: memberId,
      item_index: index,
    },
    input_subject: candidate.checkpoint.output_subject!,
    context_record_ids: action_inputs.context.records.map(({ id }) => id),
    context_checkpoint_ids: [candidate.checkpoint.id],
  };
  const checkpoint: AttemptCheckpoint = {
    schema: ATTEMPT_CHECKPOINT_SCHEMA,
    id: `checkpoint-accept-${memberId}`,
    pipeline_run_id: pending.pipeline_run_id,
    attempt_id: pending.id,
    request_hash: pending.request_hash,
    definition_bundle_hash: pending.definition_bundle_hash,
    input_subject: pending.input_subject,
    output_subject: null,
    native_session_id: `session-accept-${memberId}`,
    payload_schema: "openthrottle.executor-checkpoint/v1",
    payload: { inline: { verified: true } },
    captured_at: NOW,
  };
  const result: ResultRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `result-accept-${memberId}`,
    kind: "result",
    pipeline_run_id: pending.pipeline_run_id,
    attempt_id: pending.id,
    request_hash: pending.request_hash,
    definition_bundle_hash: pending.definition_bundle_hash,
    input_subject: pending.input_subject,
    output_subject: null,
    original_candidate_hash: "6".repeat(64),
    normalized_candidate_hash: "7".repeat(64),
    payload_schema: "openthrottle.semantic-result-record/v1",
    payload: { inline: { outcome: "success" } },
    created_at: NOW,
  };
  const decision: DecisionRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `decision-accept-${memberId}`,
    kind: "decision",
    pipeline_run_id: pending.pipeline_run_id,
    reducer: "core/action-outcome@1",
    input_record_ids: [result.id],
    payload_schema: "openthrottle.pipeline-decision-record/v1",
    payload: {
      inline: {
        schema: "openthrottle.pipeline-decision-record/v1",
        stage_id: acceptanceStageId,
        evaluator: "core/action-outcome@1",
        outcome: "success",
        reason: "validated_semantic_result",
      },
    },
    created_at: NOW,
  };
  return {
    member_id: memberId,
    acceptance: {
      attempt: {
        ...pending,
        status: "settled",
        version: 4,
        native_session_id: checkpoint.native_session_id,
        checkpoint_id: checkpoint.id,
        result_record_id: result.id,
      },
      result,
      decision,
      checkpoint,
      action_inputs,
    },
    candidate_checkpoint: candidate.checkpoint,
  };
}

function acceptedIntegrationEvidence(memberId = "unit-a", index = 0): StructuredIntegrationEvidence {
  const { bundle, manifest } = definitions();
  const source = acceptedUnitEvidence(memberId, index, manifest);
  const pending = createStructuredIntegrationAttempt({
    pipeline_run_id: "run-1",
    parent_attempt_id: "parent",
    member_id: memberId,
    round: 0,
    stage_id: "integration",
    input_subject: SOURCE,
    task_prompt: `Integrate ${memberId}.`,
    source,
    current_ancestry_checkpoints: [],
    bundle,
    manifest,
  });
  const checkpoint: AttemptCheckpoint = {
    schema: ATTEMPT_CHECKPOINT_SCHEMA,
    id: `checkpoint-integration-${memberId}`,
    pipeline_run_id: pending.pipeline_run_id,
    attempt_id: pending.id,
    request_hash: pending.request_hash,
    definition_bundle_hash: pending.definition_bundle_hash,
    input_subject: pending.input_subject,
    output_subject: CURRENT_SUBJECT,
    native_session_id: `session-integration-${memberId}`,
    payload_schema: "openthrottle.executor-checkpoint/v1",
    payload: { inline: { verified: true } },
    captured_at: NOW,
  };
  const result: ResultRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `result-integration-${memberId}`,
    kind: "result",
    pipeline_run_id: pending.pipeline_run_id,
    attempt_id: pending.id,
    request_hash: pending.request_hash,
    definition_bundle_hash: pending.definition_bundle_hash,
    input_subject: pending.input_subject,
    output_subject: CURRENT_SUBJECT,
    original_candidate_hash: "9".repeat(64),
    normalized_candidate_hash: "a".repeat(64),
    payload_schema: "openthrottle.semantic-result-record/v1",
    payload: { inline: { outcome: "success" } },
    created_at: NOW,
  };
  const decision: DecisionRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `decision-integration-${memberId}`,
    kind: "decision",
    pipeline_run_id: pending.pipeline_run_id,
    reducer: "core/action-outcome@1",
    input_record_ids: [result.id],
    payload_schema: "openthrottle.pipeline-decision-record/v1",
    payload: {
      inline: {
        schema: "openthrottle.pipeline-decision-record/v1",
        stage_id: "integration",
        evaluator: "core/action-outcome@1",
        outcome: "next_unit",
        reason: "validated_semantic_result",
      },
    },
    created_at: NOW,
  };
  return {
    member_id: memberId,
    attempt: {
      ...pending,
      status: "settled",
      version: 4,
      output_subject: CURRENT_SUBJECT,
      native_session_id: checkpoint.native_session_id,
      checkpoint_id: checkpoint.id,
      result_record_id: result.id,
    },
    checkpoint,
    result,
    decision,
  };
}

function reviewEvidence(blocking = true): {
  attempt: KernelAttempt;
  result: ResultRecord;
  decision: DecisionRecord;
  checkpoints: readonly AttemptCheckpoint[];
} {
  const base = pendingAttempt({ id: "security", stage_id: "review", kind: "fanout_member", authority: "inspect" });
  const runtimeRecords = [runtimeCreateDelivery(), runtimeStartDelivery()];
  const boundary: AttemptCheckpoint = {
    schema: ATTEMPT_CHECKPOINT_SCHEMA,
    id: "checkpoint-reviewed-change",
    pipeline_run_id: base.pipeline_run_id,
    attempt_id: "attempt-reviewed-edit",
    request_hash: "b".repeat(64),
    definition_bundle_hash: base.definition_bundle_hash,
    input_subject: SOURCE,
    output_subject: base.input_subject,
    native_session_id: "session-reviewed-edit",
    payload_schema: "openthrottle.executor-checkpoint/v1",
    payload: { inline: { verified: true } },
    captured_at: NOW,
  };
  const result: ResultRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: "result-review",
    kind: "result",
    pipeline_run_id: base.pipeline_run_id,
    attempt_id: base.id,
    request_hash: base.request_hash,
    definition_bundle_hash: base.definition_bundle_hash,
    input_subject: base.input_subject,
    output_subject: null,
    original_candidate_hash: "6".repeat(64),
    normalized_candidate_hash: "7".repeat(64),
    payload_schema: "openthrottle.semantic-result-record/v1",
    payload: {
      inline: {
        outcome: "success",
        findings: blocking ? [{
          severity: "P1",
          path: "src/security.ts",
          anchor: "authorizeRequest",
          title: "Authorization can be bypassed",
          evidence: "The sealed review subject reaches the mutation without an authorization check.",
        }] : [],
      },
    },
    created_at: NOW,
  };
  const decision: DecisionRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: "decision-review",
    kind: "decision",
    pipeline_run_id: base.pipeline_run_id,
    reducer: "core/review-outcome@1",
    input_record_ids: [result.id],
    payload_schema: "openthrottle.pipeline-decision-record/v1",
    payload: {
      inline: {
        schema: "openthrottle.pipeline-decision-record/v1",
        stage_id: "review",
        evaluator: "core/review-outcome@1",
        outcome: blocking ? "semantic_repair_required" : "success",
        reason: blocking ? "blocking_review_finding" : "validated_semantic_result",
      },
    },
    created_at: NOW,
  };
  return {
    attempt: {
      ...base,
      status: "settled",
      version: 4,
      result_record_id: result.id,
      context_record_ids: runtimeRecords.map(({ id }) => id).sort(),
      context_checkpoint_ids: [boundary.id],
    },
    result,
    decision,
    checkpoints: [boundary],
  };
}

function runtimeCreateDelivery(): DeliveryRecord {
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: "delivery-runtime-create",
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: "effect-runtime-create",
    idempotency_key: "run-1:runtime:create",
    external_identity: "daytona:sandbox-1",
    status: "confirmed",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: {
      inline: {
        effect_kind: "daytona/create-sandbox@1",
        provider: "daytona",
        result: { sandbox_id: "sandbox-1", resource_state: "created" },
      },
    },
    created_at: NOW,
  };
}

function runtimeStartDelivery(): DeliveryRecord {
  return {
    ...runtimeCreateDelivery(),
    id: "delivery-runtime-start",
    effect_id: "effect-runtime-start",
    idempotency_key: "run-1:runtime:start",
    payload: {
      inline: {
        effect_kind: "daytona/start-sandbox@1",
        provider: "daytona",
        result: { sandbox_id: "sandbox-1", resource_state: "started" },
      },
    },
  };
}

function githubPushDelivery(id: string, sha: string, refMode: "create" | "update"): DeliveryRecord {
  const repository = "owner/repo";
  const ref = "refs/heads/ot/run-1";
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id,
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: `effect-${id}`,
    idempotency_key: `run-1:${id}`,
    external_identity: `github:${repository}:${ref}`,
    status: "confirmed",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: {
      inline: {
        effect_kind: "github/push-checkpoint@1",
        provider: "github",
        result: {
          schema: "openthrottle.github-push-delivery/v1",
          repository,
          ref,
          sha,
          ref_mode: refMode,
        },
      },
    },
    created_at: NOW,
  };
}

function personaSelectionFixture(personas: unknown): {
  result: ResultRecord;
  bundle: DefinitionBundle;
  manifest: CompiledPipelineManifest;
} {
  const base = definitions();
  const roster = [
    "core/correctness", "core/tests", "core/reliability",
    "core/security", "core/performance", "core/standards",
  ];
  const manifest: CompiledPipelineManifest = {
    ...base.manifest,
    stages: [
      ...base.manifest.stages,
      {
        id: "selector", kind: "agent", engine: "codex", agent_id: "core/reviewer",
        repository_authority: "inspect", skills: ["core/review"], entry_skill: "core/review",
        eval: "core/persona-selection", on: { success: { to: "persona" } },
      },
      {
        id: "persona", kind: "agent", engine: "codex", agent_id: "core/reviewer",
        repository_authority: "inspect", skills: roster, eval: "core/review-result",
        loop: { over: "selection.personas", max_parallel: 1, max_rounds: 1, body: ["persona"] },
        on: { success: { terminal: "completed" } },
      },
    ],
  };
  const bundle: DefinitionBundle = {
    ...base.bundle,
    entries: [
      ...base.bundle.entries,
      entry("eval", "core/persona-selection", {
        schema: EVAL_DEFINITION_SCHEMA,
        id: "core/persona-selection",
        evaluator: "core/action-outcome@1",
        result: {
          schema: SEMANTIC_RESULT_SCHEMA,
          id: "core/persona-selection",
          outcomes: ["success", "failure"],
          payload: {
            summary: { type: "string", max_length: 1_000 },
            personas: { type: "string_list", max_length: 200, max_items: 5 },
          },
        },
      }),
    ],
  };
  const result: ResultRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: "result-persona-selection",
    kind: "result",
    pipeline_run_id: "run-1",
    attempt_id: "attempt-selector",
    request_hash: "e".repeat(64),
    definition_bundle_hash: manifest.definition_bundle_hash,
    input_subject: CURRENT_SUBJECT,
    output_subject: null,
    original_candidate_hash: "f".repeat(64),
    normalized_candidate_hash: "0".repeat(64),
    payload_schema: "openthrottle.semantic-result-record/v1",
    payload: {
      inline: {
        schema: "openthrottle.semantic-result-record/v1",
        semantic_schema_id: "core/persona-selection",
        outcome: "success",
        payload: { summary: "selected", personas },
        transformations: [],
      } as never,
    },
    created_at: NOW,
  };
  return { result, bundle, manifest };
}

function frontierInput() {
  const { bundle, manifest } = definitions();
  return {
    pipeline_run_id: "run-1",
    parent_attempt_id: "parent",
    stage_id: "unit",
    loop_id: "units",
    integration_stage_id: "integration",
    round: 0,
    input_subject: CURRENT_SUBJECT,
    cursor_version: 1,
    completed_scope_keys: [] as string[],
    max_parallel: 2,
    bundle,
    manifest,
  };
}

describe("structured kernel coordinator", () => {
  it("schedules a dependent unit only after exact integration evidence exists", () => {
    const input = frontierInput();
    const members = [
      { id: "unit-a", depends_on: [], action_inputs: actionInputs("unit A") },
      { id: "unit-b", depends_on: ["unit-a"], action_inputs: actionInputs("unit B") },
    ];
    const first = compileStructuredLoopFrontier({ ...input, members, completed_integrations: new Map() });
    expect(first?.attempts.map((attempt) => attempt.scope)).toMatchObject([
      { kind: "loop_item", item_id: "unit-a", item_index: 0 },
    ]);

    expect(() => compileStructuredLoopFrontier({
      ...input,
      members,
      completed_integrations: new Map([["unit-a", memberCompletionEvidence()]]),
    })).toThrow(/settled integration effect attempt/);

    const incomplete = acceptedIntegrationEvidence();
    const missingDecision = { ...incomplete, decision: { ...incomplete.decision, input_record_ids: [] } };
    expect(() => compileStructuredLoopFrontier({
      ...input,
      members,
      completed_integrations: new Map([["unit-a", missingDecision]]),
    })).toThrow(/DecisionRecord.*ResultRecord/);

    const externalDecision = {
      ...incomplete,
      decision: {
        ...incomplete.decision,
        input_record_ids: [
          "delivery-integrate-checkpoint",
          "delivery-push-checkpoint",
          incomplete.result.id,
        ].sort(),
      },
    };
    const second = compileStructuredLoopFrontier({
      ...input,
      round: 1,
      members,
      completed_integrations: new Map([["unit-a", externalDecision]]),
    });
    expect(second?.attempts).toHaveLength(1);
    expect(second?.attempts[0]).toMatchObject({
      scope: { kind: "loop_item", item_id: "unit-b", item_index: 1 },
      context_record_ids: ["decision-integration-unit-a", "result-integration-unit-a"],
      context_checkpoint_ids: ["checkpoint-integration-unit-a"],
    });
  });

  it("keeps independent siblings deterministic and bounds their eligible lanes", () => {
    const input = frontierInput();
    const members = ["unit-c", "unit-a", "unit-b"].map((id) => ({
      id, depends_on: [], action_inputs: actionInputs(id),
    }));
    const first = compileStructuredLoopFrontier({ ...input, members, completed_integrations: new Map() })!;
    const replay = compileStructuredLoopFrontier({
      ...input,
      members: [...members].reverse(),
      completed_integrations: new Map(),
    })!;
    expect(replay).toEqual(first);
    expect(first.attempts.map((attempt) =>
      attempt.scope.kind === "loop_item" ? attempt.scope.item_id : "unexpected"))
      .toEqual(["unit-a", "unit-b", "unit-c"]);
    const thirdKey = frontierMemberKey(first.attempts[2]!);
    expect(first.dependencies[thirdKey]).toEqual([frontierMemberKey(first.attempts[0]!)]);
  });

  it("compiles review personas as bounded inspect-only fanout attempts", () => {
    const { bundle, manifest } = definitions();
    const fanout = compileReviewFanoutFrontier({
      pipeline_run_id: "run-1",
      parent_attempt_id: "selector",
      stage_id: "review",
      fanout_id: "selected-reviews",
      round: 0,
      input_subject: CURRENT_SUBJECT,
      cursor_version: 3,
      completed_scope_keys: [],
      max_parallel: 2,
      members: ["core/security", "core/correctness", "core/performance"].map((id) => ({
        id,
        action_inputs: reviewActionInputs(id),
      })),
      bundle,
      manifest,
    });
    expect(fanout.attempts).toHaveLength(3);
    expect(fanout.attempts.every((attempt) => attempt.repository_authority === "inspect")).toBe(true);
    expect(fanout.attempts.every((attempt) => attempt.scope.kind === "fanout_member")).toBe(true);
    expect(fanout.attempts.map((attempt) => {
      const selected = selectKernelAction({ bundle, manifest, attempt }).action;
      return selected.kind === "agent"
        ? { skill_ids: selected.skill_ids, entry_skill: selected.entry_skill }
        : null;
    })).toEqual([
      { skill_ids: ["core/correctness"], entry_skill: "core/correctness" },
      { skill_ids: ["core/performance"], entry_skill: "core/performance" },
      { skill_ids: ["core/security"], entry_skill: "core/security" },
    ]);
    expect(fanout.dependencies[frontierMemberKey(fanout.attempts[2]!)]).toEqual([
      frontierMemberKey(fanout.attempts[0]!),
    ]);
  });

  it("keeps five review personas visible in one stable serial dependency chain", () => {
    const { bundle, manifest } = definitions();
    const members = [
      "core/tests", "core/security", "core/reliability", "core/performance", "core/correctness",
    ].map((id) => ({ id, action_inputs: reviewActionInputs(id) }));
    const input = {
      pipeline_run_id: "run-1",
      parent_attempt_id: "selector",
      stage_id: "review",
      fanout_id: "selected-reviews",
      round: 0,
      input_subject: CURRENT_SUBJECT,
      cursor_version: 3,
      completed_scope_keys: [],
      max_parallel: 1,
      bundle,
      manifest,
    };
    const fanout = compileReviewFanoutFrontier({ ...input, members });
    const replay = compileReviewFanoutFrontier({ ...input, members: [...members].reverse() });

    expect(replay).toEqual(fanout);
    expect(fanout.attempts).toHaveLength(5);
    expect(fanout.attempts.map((attempt) =>
      attempt.scope.kind === "fanout_member" ? attempt.scope.member_id : "unexpected"))
      .toEqual([
        "core/correctness", "core/performance", "core/reliability", "core/security", "core/tests",
      ]);
    const keys = fanout.attempts.map(frontierMemberKey);
    expect(fanout.dependencies[keys[0]!]).toEqual([]);
    for (let index = 1; index < keys.length; index += 1) {
      expect(fanout.dependencies[keys[index]!]).toEqual([keys[index - 1]!]);
    }
  });

  it("creates integration only from an exact checkpoint/output/result/decision chain", () => {
    const { bundle, manifest } = definitions();
    const source = acceptedUnitEvidence();
    const attempt = createStructuredIntegrationAttempt({
      pipeline_run_id: "run-1",
      parent_attempt_id: "parent",
      member_id: "unit-a",
      round: 0,
      stage_id: "integration",
      input_subject: CURRENT_SUBJECT,
      task_prompt: "Integrate unit A.",
      source,
      current_ancestry_checkpoints: [],
      bundle,
      manifest,
    });
    expect(attempt).toMatchObject({
      scope: {
        kind: "loop_item",
        stage_id: "integration",
        parent_attempt_id: "parent",
        loop_id: "units",
        item_id: "unit-a",
        item_index: 0,
      },
      repository_authority: "inspect",
      input_subject: CURRENT_SUBJECT,
      context_record_ids: ["decision-accept-unit-a", "result-accept-unit-a"],
      context_checkpoint_ids: ["checkpoint-unit-a"],
    });
    expect(() => createStructuredIntegrationAttempt({
      pipeline_run_id: "run-1", parent_attempt_id: "parent", member_id: "unit-a", round: 0,
      stage_id: "integration", input_subject: CURRENT_SUBJECT, task_prompt: "Integrate unit A.",
      source: {
        ...source,
        candidate_checkpoint: { ...source.candidate_checkpoint, output_subject: CURRENT_SUBJECT },
      },
      current_ancestry_checkpoints: [],
      bundle, manifest,
    })).toThrow(/exact edited candidate checkpoint/i);
  });

  it("carries one exact gap-free current ancestry chain beside the candidate checkpoint", () => {
    const { bundle, manifest } = definitions();
    const accepted = acceptedUnitEvidence();
    const candidate = { ...accepted.candidate_checkpoint, input_subject: SOURCE };
    const source: StructuredAcceptedUnitEvidence = {
      ...accepted,
      candidate_checkpoint: candidate,
      acceptance: {
        ...accepted.acceptance,
        action_inputs: {
          ...accepted.acceptance.action_inputs,
          context: {
            ...accepted.acceptance.action_inputs.context,
            checkpoints: [candidate],
          },
        },
      },
    };
    const first = acceptedIntegrationEvidence("unit-b", 1).checkpoint;
    const finalSubject = "4".repeat(40);
    const second: AttemptCheckpoint = {
      ...first,
      id: "checkpoint-integration-unit-c",
      attempt_id: "attempt-integration-unit-c",
      request_hash: "e".repeat(64),
      input_subject: CURRENT_SUBJECT,
      output_subject: finalSubject,
    };
    const create = (currentAncestryCheckpoints: readonly AttemptCheckpoint[]) =>
      createStructuredIntegrationAttempt({
        pipeline_run_id: "run-1",
        parent_attempt_id: "parent",
        member_id: "unit-a",
        round: 2,
        stage_id: "integration",
        input_subject: finalSubject,
        task_prompt: "Integrate stale unit A.",
        source,
        current_ancestry_checkpoints: currentAncestryCheckpoints,
        bundle,
        manifest,
      });

    expect(create([first, second]).context_checkpoint_ids).toEqual([
      candidate.id,
      first.id,
      second.id,
    ].sort());
    expect(() => create([second])).toThrow(/ancestry.*gap|gap.*ancestry/i);
    expect(() => create([first, { ...second, id: "checkpoint-extra", input_subject: SOURCE }]))
      .toThrow(/ancestry.*gap|gap.*ancestry|fork/i);
  });

  it("preserves or replaces exactly one causal task-ref push when creating integration", () => {
    const { bundle, manifest } = definitions();
    const inherited = githubPushDelivery("delivery-push-d1", "1".repeat(40), "create");
    const additional = githubPushDelivery("delivery-push-d2", "2".repeat(40), "update");
    const source = acceptedUnitEvidence();
    const records = [...source.acceptance.action_inputs.context.records, inherited]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const sourceWithPush: StructuredAcceptedUnitEvidence = {
      ...source,
      acceptance: {
        ...source.acceptance,
        attempt: {
          ...source.acceptance.attempt,
          context_record_ids: records.map(({ id }) => id),
        },
        action_inputs: {
          ...source.acceptance.action_inputs,
          context: {
            ...source.acceptance.action_inputs.context,
            records,
          },
        },
      },
    };
    const create = (planningContextRecords?: readonly ExecutionRecord[]) =>
      createStructuredIntegrationAttempt({
        pipeline_run_id: "run-1",
        parent_attempt_id: "parent",
        member_id: "unit-a",
        round: 0,
        stage_id: "integration",
        input_subject: CURRENT_SUBJECT,
        task_prompt: "Integrate unit A.",
        source: sourceWithPush,
        current_ancestry_checkpoints: [],
        planning_context_records: planningContextRecords,
        bundle,
        manifest,
      });

    expect(create().context_record_ids).toContain(inherited.id);
    expect(create([additional]).context_record_ids).toEqual(expect.arrayContaining([additional.id]));
    expect(create([additional]).context_record_ids).not.toContain(inherited.id);
  });

  it("creates a durable loop-scoped integration effect from the shipped structured bundle", () => {
    const { bundle, manifest } = actualStructuredDefinitions();
    const integrationStage = manifest.stages.find((stage) => stage.id === "integrate_unit");
    expect(integrationStage).toMatchObject({
      kind: "effect",
      effect: "core/integrate-unit@1",
    });
    const source = acceptedUnitEvidence("unit-a", 0, manifest, "accept_unit", "implement_unit");
    const integration = createStructuredIntegrationAttempt({
      pipeline_run_id: "run-1",
      parent_attempt_id: "parent",
      member_id: "unit-a",
      round: 0,
      stage_id: "integrate_unit",
      input_subject: CURRENT_SUBJECT,
      task_prompt: "Integrate unit A through the executor-owned effect adapter.",
      source,
      current_ancestry_checkpoints: [],
      bundle,
      manifest,
    });
    expect(integration).toMatchObject({
      repository_authority: "inspect",
      scope: {
        kind: "loop_item",
        stage_id: "integrate_unit",
        parent_attempt_id: "parent",
        loop_id: "units",
        item_id: "unit-a",
        item_index: 0,
      },
      context_record_ids: ["decision-accept-unit-a", "result-accept-unit-a"],
      context_checkpoint_ids: ["checkpoint-unit-a"],
    });
    expect(integration.request_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("turns a blocking inspect decision into a distinct edit remediation attempt", () => {
    const { bundle, manifest } = definitions();
    const review = reviewEvidence();
    const runtimeDeliveryRecords = [runtimeCreateDelivery(), runtimeStartDelivery()];
    const correctionEvidence: DecisionRecord = {
      ...review.decision,
      id: "decision-invalid-result-evidence",
      reducer: "core/invalid-result-evidence@1",
      input_record_ids: [],
    };
    const decision: DecisionRecord = {
      ...review.decision,
      input_record_ids: [...review.decision.input_record_ids, correctionEvidence.id].sort(),
    };
    const remediation = createBlockingReviewRemediationAttempt({
      pipeline_run_id: "run-1",
      stage_id: "remediation",
      round: 0,
      input_subject: CURRENT_SUBJECT,
      task_prompt: "Resolve the blocking security finding.",
      ...review,
      decision,
      runtime_delivery_records: runtimeDeliveryRecords,
      additional_context_records: [correctionEvidence],
      bundle,
      manifest,
    });
    expect(remediation.id).not.toBe(review.attempt.id);
    expect(remediation).toMatchObject({
      repository_authority: "edit",
      context_record_ids: [
        correctionEvidence.id,
        "decision-review",
        "delivery-runtime-create",
        "delivery-runtime-start",
        "result-review",
      ],
      context_checkpoint_ids: ["checkpoint-reviewed-change"],
    });
    expect(() => createBlockingReviewRemediationAttempt({
      pipeline_run_id: "run-1", stage_id: "remediation", round: 0,
      input_subject: CURRENT_SUBJECT, task_prompt: "Missing boundary.",
      ...review, checkpoints: [], runtime_delivery_records: runtimeDeliveryRecords, bundle, manifest,
    })).toThrow(/exact review checkpoint IDs/);
    expect(() => createBlockingReviewRemediationAttempt({
      pipeline_run_id: "run-1", stage_id: "remediation", round: 0,
      input_subject: CURRENT_SUBJECT, task_prompt: "Widened boundary.",
      ...review,
      checkpoints: [
        ...review.checkpoints,
        { ...review.checkpoints[0]!, id: "checkpoint-unrelated" },
      ],
      runtime_delivery_records: runtimeDeliveryRecords,
      bundle,
      manifest,
    })).toThrow(/exact review checkpoint IDs/);
    expect(() => createBlockingReviewRemediationAttempt({
      pipeline_run_id: "run-1", stage_id: "remediation", round: 0,
      input_subject: CURRENT_SUBJECT, task_prompt: "Mismatched boundary.",
      ...review,
      checkpoints: [{ ...review.checkpoints[0]!, output_subject: UNIT_OUTPUT }],
      runtime_delivery_records: runtimeDeliveryRecords,
      bundle,
      manifest,
    })).toThrow(/reviewed input subject/);
    expect(() => createBlockingReviewRemediationAttempt({
      pipeline_run_id: "run-1", stage_id: "remediation", round: 0,
      input_subject: CURRENT_SUBJECT, task_prompt: "Cross-bundle boundary.",
      ...review,
      checkpoints: [{ ...review.checkpoints[0]!, definition_bundle_hash: "d".repeat(64) }],
      runtime_delivery_records: runtimeDeliveryRecords,
      bundle,
      manifest,
    })).toThrow(/run and definition bundle/);
    expect(() => createBlockingReviewRemediationAttempt({
      pipeline_run_id: "run-1", stage_id: "remediation", round: 0,
      input_subject: CURRENT_SUBJECT, task_prompt: "No repair.", ...reviewEvidence(false),
      runtime_delivery_records: runtimeDeliveryRecords, bundle, manifest,
    })).toThrow(/blocking review DecisionRecord/);
  });

  it("preserves the causal task-ref push in blocking review remediation", () => {
    const { bundle, manifest } = definitions();
    const push = githubPushDelivery("delivery-push-d1", "1".repeat(40), "create");
    const review = reviewEvidence();
    const runtimeDeliveryRecords = [runtimeCreateDelivery(), runtimeStartDelivery(), push];
    const remediation = createBlockingReviewRemediationAttempt({
      pipeline_run_id: "run-1",
      stage_id: "remediation",
      round: 0,
      input_subject: CURRENT_SUBJECT,
      task_prompt: "Resolve the blocking finding without losing publication ancestry.",
      ...review,
      attempt: {
        ...review.attempt,
        context_record_ids: runtimeDeliveryRecords.map(({ id }) => id).sort(),
      },
      runtime_delivery_records: runtimeDeliveryRecords,
      bundle,
      manifest,
    });

    expect(remediation.context_record_ids).toContain(push.id);
  });

  it("reconstructs exactly one sealed v2 plan without process-local state", () => {
    const plan = {
      schema: "openthrottle.execution-plan/v2",
      pipeline_id: "core/structured",
      plan_id: "plan-1",
      units: [{
        id: "unit-a", title: "A", depends_on: [], objective: "Implement A",
        requirements: ["R"], files: ["a.ts"], approach: ["Do A"], tests: ["Test A"],
        acceptance: ["A works"], verification: ["npm test"],
      }],
      commands: [],
    };
    const prompt = `Task\n\n\`\`\`json openthrottle.execution-plan/v2\n${JSON.stringify(plan)}\n\`\`\``;
    expect(parseStructuredExecutionPlan(prompt, "core/structured")).toEqual(plan);
    expect(() => parseStructuredExecutionPlan(`${prompt}\n${prompt}`, "core/structured"))
      .toThrow(/exactly one/);
    expect(() => parseStructuredExecutionPlan(prompt, "core/ordinary"))
      .toThrow(/another compiled pipeline/);
  });

  it("compiles the first dependency-ready unit wave from exact provision deliveries", () => {
    const base = definitions();
    const provision = {
      id: "ot_runtime_provision", kind: "effect" as const,
      effect: "core/daytona-provision@1", on: { success: { to: "unit" } },
    };
    const manifest: CompiledPipelineManifest = {
      ...base.manifest,
      entry_stage: provision.id,
      stages: [provision, ...base.manifest.stages],
    };
    const attempt: KernelAttempt = {
      ...pendingAttempt({ id: "provision", authority: "inspect", manifest }),
      id: "attempt-provision",
      scope: { kind: "stage", stage_id: provision.id },
      status: "recorded",
      result_record_id: "result-provision",
    };
    const result: ResultRecord = {
      schema: EXECUTION_RECORD_SCHEMA,
      id: "result-provision",
      kind: "result",
      pipeline_run_id: "run-1",
      attempt_id: attempt.id,
      request_hash: attempt.request_hash,
      definition_bundle_hash: attempt.definition_bundle_hash,
      input_subject: attempt.input_subject,
      output_subject: null,
      original_candidate_hash: "1".repeat(64),
      normalized_candidate_hash: "1".repeat(64),
      payload_schema: "openthrottle.external-result-record/v1",
      payload: { inline: { outcome: "success" } },
      created_at: NOW,
    };
    const units = [
      { id: "unit-a", depends_on: [] },
      { id: "unit-b", depends_on: ["unit-a"] },
      { id: "unit-c", depends_on: [] },
    ].map((unit) => ({
      ...unit,
      title: unit.id,
      objective: `Implement ${unit.id}`,
      requirements: ["required"], files: [`${unit.id}.ts`], approach: ["implement"],
      tests: ["test"], acceptance: ["accepted"], verification: ["npm test"],
    }));
    const taskPrompt = `\`\`\`json openthrottle.execution-plan/v2\n${JSON.stringify({
      schema: "openthrottle.execution-plan/v2",
      pipeline_id: "core/structured",
      plan_id: "plan-1",
      units,
      commands: [],
    })}\n\`\`\``;
    const create = runtimeCreateDelivery();
    const start = runtimeStartDelivery();
    const view: ReductionView = {
      manifest,
      run: {
        schema: KERNEL_RUN_SCHEMA,
        id: "run-1",
        pipeline_id: manifest.pipeline_id,
        definition_bundle_hash: manifest.definition_bundle_hash,
        current_subject: CURRENT_SUBJECT,
        status: "running",
        terminal_outcome: null,
        cursor: compileKernelCursor({ stage_id: provision.id, version: 2, attempts: [attempt] }),
        version: 3,
        work_retry_limit: 2,
        result_correction_limit: 2,
        active_attempt_versions: { [attempt.id]: attempt.version },
        active_effect_versions: {},
        checkpoint_ids: {},
      },
      current_attempt: attempt,
      records: new Map([[result.id, result]]),
      checkpoints: new Map(),
    };
    const settlement = buildStructuredProvisionSettlement({
      view,
      stage: provision,
      attempt,
      result,
      bundle: base.bundle,
      schedules: [create, start].map((delivery, index) => ({
        semantic_key: `provision-${index}`,
        decision: { id: `schedule-${index}` } as never,
        effects: [{ intent: {} as never, delivery }],
      })),
      evaluated: { evaluator: "external/core/daytona-provision@1", outcome: "success", reason: "started" },
      task_prompt: taskPrompt,
      created_at: NOW,
    });
    expect(settlement.next_attempts.map((candidate) =>
      candidate.scope.kind === "loop_item" ? candidate.scope.item_id : "unexpected"))
      .toEqual(["unit-a", "unit-c"]);
    expect(settlement.decision.input_record_ids).toEqual([
      create.id, start.id, result.id,
    ].sort());
    expect(() => buildStructuredProvisionSettlement({
      view, stage: provision, attempt, result, bundle: base.bundle,
      schedules: [{ semantic_key: "create", decision: {} as never, effects: [{ intent: {} as never, delivery: create }] }],
      evaluated: { evaluator: "external/core/daytona-provision@1", outcome: "success", reason: "partial" },
      task_prompt: taskPrompt, created_at: NOW,
    })).toThrow(/Daytona create/);
  });

  it("accepts only known, unique, bounded personas and returns sealed roster order", () => {
    const valid = personaSelectionFixture([
      "core/standards", "core/security", "core/reliability", "core/tests", "core/correctness",
    ]);
    expect(selectedStructuredReviewPersonas({
      ...valid,
      selector_stage_id: "selector",
      fanout_stage_id: "persona",
    })).toEqual([
      "core/correctness", "core/tests", "core/reliability", "core/security", "core/standards",
    ]);

    for (const [personas, message] of [
      ["core/security", /must contain reviewer IDs/],
      [["core/security", "core/security"], /duplicate/],
      [["core/unknown"], /unknown reviewer/],
      [[
        "core/correctness", "core/tests", "core/reliability",
        "core/security", "core/performance", "core/standards",
      ], /sealed bound/],
    ] as const) {
      const fixture = personaSelectionFixture(personas);
      expect(() => selectedStructuredReviewPersonas({
        ...fixture,
        selector_stage_id: "selector",
        fanout_stage_id: "persona",
      })).toThrow(message);
    }
  });

});
