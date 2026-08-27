import { describe, expect, it } from "vitest";
import {
  EXECUTION_RECORD_SCHEMA,
  definitionEntryContentHash,
  digestCanonicalJson,
  type AttemptCheckpoint,
  type CompiledPipelineManifest,
  type DefinitionBundle,
  type DefinitionBundleEntry,
  type DeliveryRecord,
} from "@openthrottle/contracts";
import {
  buildKernelResultCorrectionRequest,
  buildKernelWorkActionRequest,
  createPendingKernelAttempt,
  selectKernelAction,
} from "./action-request.js";
import type { KernelAttempt } from "./types.js";

const SOURCE = "a".repeat(40);
const OUTPUT = "b".repeat(40);

function entry(
  definition_kind: DefinitionBundleEntry["definition_kind"],
  definition_id: string,
  path: string,
  normalized_payload: unknown,
  origin: "platform" | "repository" = "platform",
): DefinitionBundleEntry {
  return {
    definition_kind,
    definition_id,
    origin: { kind: origin, source_commit: origin === "repository" ? SOURCE : null },
    path,
    content_hash: definitionEntryContentHash(normalized_payload),
    normalized_payload,
  };
}

function definitions(): { bundle: DefinitionBundle; manifest: CompiledPipelineManifest } {
  const evaluation = {
    schema: "openthrottle.eval-definition/v1",
    id: "core/action-result",
    evaluator: "core/action-outcome@1",
    result: {
      schema: "openthrottle.semantic-result-schema/v1",
      id: "core/action-result",
      outcomes: ["success"],
      payload: {
        summary: { type: "string", max_length: 1_000 },
      },
    },
  };
  const bundle: DefinitionBundle = {
    schema: "openthrottle.definition-bundle/v1",
    compiler_version: "definition-compiler/v1",
    runtime_capability_digest: "c".repeat(64),
    source_commit: SOURCE,
    pipeline_id: "core/test",
    pipeline_selection: "explicit",
    entries: [
      entry("config", "repository", ".openthrottle/config.yml", {
        schema: "openthrottle.config/v2",
        pipeline: "core/test",
        engine: "codex",
        commands: { test: "npm test" },
        post_bootstrap: ["npm ci", "npm run prepare"],
        limits: { task_timeout: 900 },
      }, "repository"),
      entry("agent", "core/worker", ".openthrottle/agents/core/worker/instructions.md", "Work."),
      entry("skill", "core/work", ".openthrottle/skills/core/work/SKILL.md", {
        frontmatter: { name: "work", description: "Work." }, instructions: "Work.", files: [],
      }),
      entry("eval", "core/action-result", ".openthrottle/evals/core/action-result/eval.yml", evaluation),
    ],
  };
  const manifest: CompiledPipelineManifest = {
    schema: "openthrottle.compiled-pipeline-manifest/v1",
    pipeline_id: "core/test",
    pipeline_version: 1,
    entry_stage: "implement",
    definition_bundle_hash: digestCanonicalJson(bundle),
    compiler_version: bundle.compiler_version,
    runtime_capability_digest: bundle.runtime_capability_digest,
    stages: [{
      id: "implement",
      kind: "agent",
      engine: "codex",
      agent_id: "core/worker",
      repository_authority: "edit",
      skills: ["core/work"],
      entry_skill: "core/work",
      eval: "core/action-result",
      on: { success: { terminal: "completed" } },
    }],
  };
  return { bundle, manifest };
}

function runtimeDelivery(slotIndex: number, kind: "create" | "start"): DeliveryRecord {
  const runtimeIdentity = String(slotIndex + 1).repeat(64);
  const sandboxId = `sandbox-${slotIndex + 1}`;
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `delivery-runtime-${kind}-${slotIndex}`,
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: `effect-runtime-${kind}-${slotIndex}`,
    idempotency_key: `run-1:runtime:${kind}:${runtimeIdentity}`,
    external_identity: `daytona:${runtimeIdentity}`,
    status: "confirmed",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: { inline: {
      effect_kind: `daytona/${kind}-sandbox@1`,
      provider: "daytona",
      result: {
        identity: runtimeIdentity,
        sandbox_id: sandboxId,
        resource_state: kind === "create" ? "created" : "started",
      },
    } },
    created_at: "2026-08-27T12:00:00.000Z",
  };
}

describe("buildKernelResultCorrectionRequest", () => {
  it("retains the exact work Attempt, subject, checkpoint, and session under result-only inspect authority", () => {
    const { bundle, manifest } = definitions();
    const attempt: KernelAttempt = {
      schema: "openthrottle.kernel-attempt/v1",
      id: "attempt-1",
      pipeline_run_id: "run-1",
      scope: { kind: "stage", stage_id: "implement" },
      repository_authority: "edit",
      request_hash: "d".repeat(64),
      definition_bundle_hash: manifest.definition_bundle_hash,
      input_subject: SOURCE,
      context_record_ids: [],
      context_checkpoint_ids: [],
      output_subject: OUTPUT,
      native_session_id: "session-1",
      status: "result_pending",
      version: 4,
      work_retry_ordinal: 0,
      result_correction_count: 1,
      result_correction_deadline: "2026-08-20T13:00:00.000Z",
      lease: {
        id: "lease-correction",
        generation: 0,
        worker_id: "worker-1",
        purpose: "result_correction",
        expires_at: "2026-08-20T12:05:00.000Z",
        started: true,
      },
      checkpoint_id: "checkpoint-1",
      result_record_id: null,
      decision_record_id: null,
      pending_result: {
        candidate_hash: "e".repeat(64),
        diagnostics: [{ path: "/payload/summary", detail: "must be a string" }],
        invalid_result_evidence: null,
      },
    };
    const checkpoint: AttemptCheckpoint = {
      schema: "openthrottle.attempt-checkpoint/v1",
      id: "checkpoint-1",
      pipeline_run_id: attempt.pipeline_run_id,
      attempt_id: attempt.id,
      request_hash: attempt.request_hash,
      definition_bundle_hash: attempt.definition_bundle_hash,
      input_subject: attempt.input_subject,
      output_subject: OUTPUT,
      native_session_id: "session-1",
      payload_schema: "openthrottle.executor-checkpoint/v1",
      payload: { inline: { exact: true } },
      captured_at: "2026-08-20T12:00:00.000Z",
    };

    expect(buildKernelResultCorrectionRequest({ attempt, checkpoint, bundle, manifest }))
      .toMatchObject({
        phase: "result_correction",
        pipeline_run_id: attempt.pipeline_run_id,
        attempt_id: attempt.id,
        request_hash: attempt.request_hash,
        definition_bundle_hash: attempt.definition_bundle_hash,
        input_subject: SOURCE,
        locked_subject: OUTPUT,
        completed_work_authority: "edit",
        checkpoint_id: checkpoint.id,
        native_session_id: "session-1",
        repository_authority: "inspect",
        tools: ["ot-result"],
        mcp: false,
        provider_access: false,
        execution_limits: { max_turns: null, task_timeout_seconds: 900 },
      });
  });
});

describe("selectKernelAction", () => {
  it("seals normalized post_bootstrap and repository limits into command actions", () => {
    const { bundle, manifest } = definitions();
    const commandManifest: CompiledPipelineManifest = {
      ...manifest,
      entry_stage: "test",
      stages: [{
        id: "test",
        kind: "command",
        command: "test",
        on: { success: { terminal: "completed" } },
      }],
    };

    expect(selectKernelAction({
      bundle,
      manifest: commandManifest,
      attempt: {
        definition_bundle_hash: commandManifest.definition_bundle_hash,
        scope: { kind: "stage", stage_id: "test" },
      },
    }).action).toEqual({
      kind: "command",
      command_id: "test",
      command_line: "npm test",
      post_bootstrap: ["npm ci", "npm run prepare"],
      execution_limits: { max_turns: null, task_timeout_seconds: 900 },
    });
  });
});

describe("buildKernelWorkActionRequest", () => {
  it("seals each loop member to the Daytona pool slot selected by its durable scope", () => {
    const { bundle, manifest: baseManifest } = definitions();
    const manifest: CompiledPipelineManifest = {
      ...baseManifest,
      stages: [{
        ...baseManifest.stages[0]!,
        loop: {
          over: "execution_plan.units",
          max_parallel: 2,
          max_rounds: 8,
          body: ["implement"],
        },
      }],
    };
    const records = [
      runtimeDelivery(0, "create"),
      runtimeDelivery(0, "start"),
      runtimeDelivery(1, "create"),
      runtimeDelivery(1, "start"),
    ];
    const actionInputs = {
      task_prompt: "Execute one isolated structured unit.",
      context: { records, checkpoints: [] },
    };

    const requests = [0, 1].map((itemIndex) => {
      const pending = createPendingKernelAttempt({
        id: `attempt-${itemIndex}`,
        pipeline_run_id: "run-1",
        scope: {
          kind: "loop_item",
          stage_id: "implement",
          parent_attempt_id: "attempt-provision",
          loop_id: "execution_plan.units",
          item_id: `unit-${itemIndex}`,
          item_index: itemIndex,
        },
        input_subject: SOURCE,
        bundle,
        manifest,
        action_inputs: actionInputs,
      });
      return buildKernelWorkActionRequest({
        attempt: {
          ...pending,
          status: "running",
          lease: {
            id: `lease-${itemIndex}`,
            generation: 0,
            worker_id: "worker-1",
            purpose: "work",
            expires_at: "2026-08-27T12:05:00.000Z",
            started: true,
          },
        },
        bundle,
        manifest,
        action_inputs: actionInputs,
      });
    });

    expect(requests.map(({ runtime_resource }) => runtime_resource)).toEqual([
      {
        provider: "daytona",
        provider_resource_id: "sandbox-1",
        delivery_record_ids: ["delivery-runtime-create-0", "delivery-runtime-start-0"],
      },
      {
        provider: "daytona",
        provider_resource_id: "sandbox-2",
        delivery_record_ids: ["delivery-runtime-create-1", "delivery-runtime-start-1"],
      },
    ]);
    expect(Object.keys(requests[0]!.runtime_resource!).sort()).toEqual([
      "delivery_record_ids", "provider", "provider_resource_id",
    ]);
    expect(requests[0]!.request_hash).not.toBe(requests[1]!.request_hash);
  });
});
