import { describe, expect, it } from "vitest";
import {
  EXECUTION_RECORD_SCHEMA,
  digestCanonicalJson,
  expandCompiledRuntimeLifecycle,
  runtimeStopStageId,
  type CompiledPipelineManifest,
  type DecisionRecord,
  type DefinitionBundle,
  type DeliveryRecord,
  type ExecutionRecord,
  type ResultRecord,
} from "@openthrottle/contracts";
import { exactConfirmedGithubPushDelivery } from "./github-push-delivery.js";
import type { ReductionView } from "./ports.js";
import {
  deriveKernelSuccessorAttempt,
  kernelSuccessorStageId,
  mergeCausalGithubPushContext,
} from "./successor-attempt.js";
import type { KernelAttempt, KernelRun } from "./types.js";

const NOW = "2026-08-20T12:00:00.000Z";
const SUBJECT = "a".repeat(40);
const OUTPUT = "b".repeat(40);

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

function nonPushDelivery(id: string): DeliveryRecord {
  return {
    ...githubPushDelivery(id, "a".repeat(40), "create"),
    external_identity: `test:${id}`,
    payload: {
      inline: {
        effect_kind: "test/effect@1",
        provider: "test",
        result: {},
      },
    },
  };
}

function runtimeDelivery(
  kind: "create" | "start",
  sandboxId = "sandbox-1",
): DeliveryRecord {
  const suffix = sandboxId === "sandbox-1" ? "" : `-${sandboxId}`;
  const identity = sandboxId === "sandbox-1" ? "1".repeat(64) : "2".repeat(64);
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `delivery-runtime-${kind}${suffix}`,
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: `effect-runtime-${kind}${suffix}`,
    idempotency_key: `run-1:runtime:${kind}${suffix}`,
    external_identity: `daytona:${identity}`,
    status: "confirmed",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: { inline: {
      effect_kind: `daytona/${kind}-sandbox@1`,
      provider: "daytona",
      observed_via: "reconciliation",
      result: { identity, sandbox_id: sandboxId },
    } },
    created_at: NOW,
  };
}

function failureSuccessorFixture(): {
  bundle: DefinitionBundle;
  manifest: CompiledPipelineManifest;
  view: ReductionView;
  current: KernelAttempt;
  result: ResultRecord;
  decision: DecisionRecord;
} {
  const bundle: DefinitionBundle = {
    schema: "openthrottle.definition-bundle/v1",
    compiler_version: "definition-compiler/v1",
    runtime_capability_digest: "c".repeat(64),
    source_commit: SUBJECT,
    pipeline_id: "core/test",
    pipeline_selection: "config",
    entries: [],
  };
  const definitionBundleHash = digestCanonicalJson(bundle);
  const runtime = expandCompiledRuntimeLifecycle({
    entry_stage: "publish",
    stages: [{
      id: "publish",
      kind: "effect",
      effect: "core/publish@1",
      on: {
        success: { terminal: "completed" },
        failure: { terminal: "failed" },
      },
    }],
  });
  const manifest: CompiledPipelineManifest = {
    schema: "openthrottle.compiled-pipeline-manifest/v1",
    pipeline_id: bundle.pipeline_id,
    pipeline_version: 1,
    entry_stage: "publish",
    definition_bundle_hash: definitionBundleHash,
    compiler_version: bundle.compiler_version,
    runtime_capability_digest: bundle.runtime_capability_digest,
    stages: runtime.stages,
  };
  const current: KernelAttempt = {
    schema: "openthrottle.kernel-attempt/v1",
    id: "attempt-publish",
    pipeline_run_id: "run-1",
    scope: { kind: "stage", stage_id: "publish" },
    repository_authority: "inspect",
    request_hash: "d".repeat(64),
    definition_bundle_hash: definitionBundleHash,
    input_subject: SUBJECT,
    context_record_ids: ["delivery-runtime-create", "delivery-runtime-start"],
    context_checkpoint_ids: [],
    output_subject: OUTPUT,
    native_session_id: null,
    status: "recorded",
    version: 4,
    work_retry_ordinal: 0,
    result_correction_count: 0,
    result_correction_deadline: null,
    lease: null,
    checkpoint_id: "checkpoint-publication",
    result_record_id: "result-publish",
    decision_record_id: null,
    pending_result: null,
  };
  const run: KernelRun = {
    schema: "openthrottle.kernel-run/v1",
    id: "run-1",
    pipeline_id: bundle.pipeline_id,
    definition_bundle_hash: definitionBundleHash,
    current_subject: OUTPUT,
    status: "running",
    terminal_outcome: null,
    cursor: {
      stage_id: "publish",
      version: 4,
      reentries: {},
      frontier: [],
      completed_scope_keys: [],
      barrier: null,
    },
    version: 5,
    work_retry_limit: 2,
    result_correction_limit: 1,
    active_attempt_versions: { [current.id]: current.version },
    active_effect_versions: {},
    checkpoint_ids: {},
  };
  const result: ResultRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: "result-publish",
    kind: "result",
    pipeline_run_id: run.id,
    attempt_id: current.id,
    request_hash: current.request_hash,
    definition_bundle_hash: definitionBundleHash,
    input_subject: current.input_subject,
    output_subject: current.output_subject,
    original_candidate_hash: "e".repeat(64),
    normalized_candidate_hash: "e".repeat(64),
    payload_schema: "openthrottle.external-result-record/v1",
    payload: { inline: { outcome: "failure" } },
    created_at: NOW,
  };
  const decision: DecisionRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: "decision-publish-failure",
    kind: "decision",
    pipeline_run_id: run.id,
    reducer: "core/external-outcome@1",
    input_record_ids: [result.id],
    payload_schema: "openthrottle.pipeline-decision/v1",
    payload: { inline: { outcome: "failure" } },
    created_at: NOW,
  };
  return {
    bundle,
    manifest,
    view: {
      manifest,
      run,
      current_attempt: current,
      records: new Map([[result.id, result]]),
      checkpoints: new Map(),
    },
    current,
    result,
    decision,
  };
}

describe("mergeCausalGithubPushContext", () => {
  it("preserves the inherited task-ref push when no newer push is supplied", () => {
    const inherited = githubPushDelivery("delivery-push-d1", "1".repeat(40), "create");
    const base = nonPushDelivery("delivery-runtime");

    expect(mergeCausalGithubPushContext({
      pipeline_run_id: "run-1",
      base_records: [base],
      inherited_records: [inherited],
    }).map(({ id }) => id)).toEqual([base.id, inherited.id].sort());
  });

  it("replaces the inherited task-ref push with the additional push and never retains both", () => {
    const inherited = githubPushDelivery("delivery-push-d1", "1".repeat(40), "create");
    const additional = githubPushDelivery("delivery-push-d2", "2".repeat(40), "update");
    const phase = nonPushDelivery("delivery-integrate-d2");

    const merged = mergeCausalGithubPushContext({
      pipeline_run_id: "run-1",
      base_records: [],
      inherited_records: [inherited],
      additional_records: [phase, additional],
    });

    expect(merged.map(({ id }) => id)).toEqual([phase.id, additional.id].sort());
    expect(merged).not.toContainEqual(inherited);
  });

  it("deduplicates the same immutable push record ID within one tier", () => {
    const inherited = githubPushDelivery("delivery-push-d1", "1".repeat(40), "create");
    expect(mergeCausalGithubPushContext({
      pipeline_run_id: "run-1",
      base_records: [],
      inherited_records: [inherited, inherited],
    })).toEqual([inherited]);
  });

  it("drops a rejected additional push and retains the last confirmed inherited anchor", () => {
    const inherited = githubPushDelivery("delivery-push-d1", "1".repeat(40), "create");
    const rejected = {
      ...githubPushDelivery("delivery-push-d2", "2".repeat(40), "update"),
      status: "rejected" as const,
    };

    expect(mergeCausalGithubPushContext({
      pipeline_run_id: "run-1",
      base_records: [],
      inherited_records: [inherited],
      additional_records: [rejected],
    })).toEqual([inherited]);
  });

  it("does not reinterpret rejected push evidence as an absent publication anchor", () => {
    const rejected = {
      ...githubPushDelivery("delivery-push-d1", "1".repeat(40), "create"),
      status: "rejected" as const,
    };

    expect(() => exactConfirmedGithubPushDelivery({
      records: [rejected],
      label: "publication anchor",
      pipeline_run_id: "run-1",
    })).toThrow(/invalid task-ref push evidence/);
  });

  it("derives the compiled failure runtime-stop successor without retaining a rejected push", () => {
    const fixture = failureSuccessorFixture();
    const rejected = {
      ...githubPushDelivery("delivery-push-rejected", OUTPUT, "create"),
      status: "rejected" as const,
    };
    const runtimeRecords = [runtimeDelivery("create"), runtimeDelivery("start")];
    const publish = fixture.manifest.stages.find(({ id }) => id === "publish")!;
    const targetStageId = kernelSuccessorStageId({
      manifest: fixture.manifest,
      run: fixture.view.run,
      stage: publish,
      outcome: "failure",
    });

    expect(targetStageId).toBe(runtimeStopStageId("failed"));
    const successor = deriveKernelSuccessorAttempt({
      view: fixture.view,
      current: fixture.current,
      result: fixture.result,
      decision: fixture.decision,
      bundle: fixture.bundle,
      target_scope: { kind: "stage", stage_id: targetStageId! },
      request_inputs: {
        task_prompt: "Stop and clean the runtime after rejected publication.",
        context: {
          records: new Map(runtimeRecords.map((record) => [record.id, record])),
          checkpoints: new Map(),
        },
      },
      additional_context_records: [rejected],
    });

    expect(successor.scope.stage_id).toBe(runtimeStopStageId("failed"));
    expect(successor.input_subject).toBe(OUTPUT);
    expect(successor.context_record_ids).toEqual([
      fixture.decision.id,
      ...runtimeRecords.map(({ id }) => id),
      fixture.result.id,
    ].sort());
    expect(successor.context_record_ids).not.toContain(rejected.id);
  });

  it("preserves every sealed runtime-pool delivery in a serial successor context", () => {
    const fixture = failureSuccessorFixture();
    const runtimeRecords = [
      runtimeDelivery("create"),
      runtimeDelivery("start"),
      runtimeDelivery("create", "sandbox-2"),
      runtimeDelivery("start", "sandbox-2"),
    ];
    const current: KernelAttempt = {
      ...fixture.current,
      context_record_ids: runtimeRecords.map(({ id }) => id).sort(),
    };

    const successor = deriveKernelSuccessorAttempt({
      view: { ...fixture.view, current_attempt: current },
      current,
      result: fixture.result,
      decision: fixture.decision,
      bundle: fixture.bundle,
      target_scope: { kind: "stage", stage_id: runtimeStopStageId("failed") },
      request_inputs: {
        task_prompt: "Keep the complete run-scoped runtime pool sealed through the successor.",
        context: {
          records: new Map(runtimeRecords.map((record) => [record.id, record])),
          checkpoints: new Map(),
        },
      },
    });

    expect(successor.context_record_ids).toEqual([
      fixture.decision.id,
      fixture.result.id,
      ...runtimeRecords.map(({ id }) => id),
    ].sort());
  });

  it.each([
    ["another run", (record: DeliveryRecord) => ({ ...record, pipeline_run_id: "run-2" })],
    ["mismatched external identity", (record: DeliveryRecord) => ({
      ...record,
      external_identity: "github:owner/repo:refs/heads/ot/other",
    })],
    ["mismatched result ref", (record: DeliveryRecord) => ({
      ...record,
      payload: { inline: {
        ...(record.payload as { inline: Record<string, unknown> }).inline,
        result: {
          schema: "openthrottle.github-push-delivery/v1",
          repository: "owner/repo",
          ref: "refs/heads/ot/other",
          sha: "1".repeat(40),
          ref_mode: "create",
        },
      } },
    })],
  ] as const)("rejects a push delivery from %s", (_label, mutate) => {
    const record = mutate(githubPushDelivery("delivery-push-d1", "1".repeat(40), "create"));
    expect(() => mergeCausalGithubPushContext({
      pipeline_run_id: "run-1",
      base_records: [],
      inherited_records: [record],
    })).toThrow(/invalid task-ref push evidence/);
  });

  it.each([
    ["inherited", { inherited_records: [
      githubPushDelivery("delivery-push-d1", "1".repeat(40), "create"),
      githubPushDelivery("delivery-push-d2", "2".repeat(40), "update"),
    ] }],
    ["additional", { inherited_records: [], additional_records: [
      githubPushDelivery("delivery-push-d1", "1".repeat(40), "create"),
      githubPushDelivery("delivery-push-d2", "2".repeat(40), "update"),
    ] }],
  ] as const)("rejects ambiguous %s task-ref push context", (_label, context) => {
    expect(() => mergeCausalGithubPushContext({
      pipeline_run_id: "run-1",
      base_records: [] as ExecutionRecord[],
      ...context,
    })).toThrow(/multiple task-ref push deliveries/);
  });
});
