import { describe, expect, it } from "vitest";
import {
  definitionEntryContentHash,
  digestCanonicalJson,
  type AttemptCheckpoint,
  type CompiledPipelineManifest,
  type DefinitionBundle,
  type DefinitionBundleEntry,
} from "@openthrottle/contracts";
import { buildKernelResultCorrectionRequest, selectKernelAction } from "./action-request.js";
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
