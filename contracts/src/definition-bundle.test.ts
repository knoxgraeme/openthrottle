import { describe, expect, it } from "vitest";
import {
  COMPILED_PIPELINE_MANIFEST_SCHEMA,
  DEFINITION_BUNDLE_SCHEMA,
  FILESYSTEM_CONFIG_SCHEMA,
  PIPELINE_DEFINITION_SCHEMA,
  definitionEntryContentHash,
  validateCompiledPipelineManifest,
  validateDefinitionBundle,
  validateFilesystemConfigContract,
  validatePipelineDefinition,
} from "./index.js";

const sha = (character: string): string => character.repeat(64);
const commit = (character: string): string => character.repeat(40);

function entry(
  definition_kind: "config" | "agent" | "pipeline" | "skill" | "eval",
  definition_id: string,
  path: string,
  normalized_payload: unknown,
) {
  return {
    definition_kind,
    definition_id,
    origin: { kind: "repository", source_commit: commit("a") },
    path,
    content_hash: definitionEntryContentHash(normalized_payload),
    normalized_payload,
  };
}

describe("definition bundle contract", () => {
  it("sorts entries and canonicalizes payload key order into one bundle digest", () => {
    const config = entry(
      "config",
      "repository",
      ".openthrottle/config.yml",
      { engine: "codex", pipeline: "review" },
    );
    const agent = entry(
      "agent",
      "reviewer",
      ".openthrottle/agents/reviewer/instructions.md",
      "Review the sealed subject.\n",
    );
    const pipeline = entry(
      "pipeline",
      "review",
      ".openthrottle/pipelines/review/pipeline.yml",
      { stages: [{ id: "review", kind: "agent" }], entry: "review" },
    );
    const base = {
      schema: DEFINITION_BUNDLE_SCHEMA,
      compiler_version: "definition-compiler/v1",
      runtime_capability_digest: sha("b"),
      source_commit: commit("a"),
      pipeline_id: "review",
      pipeline_selection: "config",
    };

    const left = validateDefinitionBundle({ ...base, entries: [pipeline, config, agent] });
    const right = validateDefinitionBundle({
      pipeline_id: "review",
      pipeline_selection: "config",
      source_commit: commit("a"),
      runtime_capability_digest: sha("b"),
      compiler_version: "definition-compiler/v1",
      entries: [
        { ...agent },
        { ...config, normalized_payload: { pipeline: "review", engine: "codex" } },
        {
          ...pipeline,
          normalized_payload: { entry: "review", stages: [{ kind: "agent", id: "review" }] },
        },
      ],
      schema: DEFINITION_BUNDLE_SCHEMA,
    });

    expect(left.normalized).toBe(right.normalized);
    expect(left.digest).toBe(right.digest);
    expect(left.value.entries.map((item) => item.definition_kind)).toEqual(["agent", "config", "pipeline"]);
  });

  it("rejects repository shadowing, duplicate identities, and non-normalized text", () => {
    const reviewer = entry(
      "agent",
      "reviewer",
      ".openthrottle/agents/reviewer/instructions.md",
      "review\n",
    );
    const config = entry(
      "config",
      "repository",
      ".openthrottle/config.yml",
      { engine: "codex", pipeline: "review" },
    );
    const bundle = {
      schema: DEFINITION_BUNDLE_SCHEMA,
      compiler_version: "definition-compiler/v1",
      runtime_capability_digest: sha("b"),
      source_commit: commit("a"),
      pipeline_id: "review",
      pipeline_selection: "config",
      entries: [config, reviewer],
    };
    expect(() => validateDefinitionBundle({
      ...bundle,
      entries: [config, { ...reviewer, definition_id: "core/reviewer" }],
    })).toThrow(/definition_id: repository definitions cannot use the reserved core namespace/);
    expect(() => validateDefinitionBundle({ ...bundle, entries: [config, reviewer, reviewer] }))
      .toThrow(/entries: must not contain duplicate definition identities/);
    expect(() => validateDefinitionBundle({
      ...bundle,
      entries: [config, {
        ...reviewer,
        normalized_payload: "review\r\n",
        content_hash: definitionEntryContentHash("review\r\n"),
      }],
    })).toThrow(/normalized_payload: must use LF line endings/);
  });

  it("does not trust a serialized claim of platform origin", () => {
    const config = entry(
      "config",
      "repository",
      ".openthrottle/config.yml",
      { engine: "codex", pipeline: "core/review" },
    );
    const pipelinePayload = { entry: "review" };
    const platformPipeline = {
      definition_kind: "pipeline",
      definition_id: "core/review",
      origin: { kind: "platform", source_commit: null },
      path: ".openthrottle/pipelines/core/review/pipeline.yml",
      content_hash: definitionEntryContentHash(pipelinePayload),
      normalized_payload: pipelinePayload,
    };
    const bundle = {
      schema: DEFINITION_BUNDLE_SCHEMA,
      compiler_version: "definition-compiler/v1",
      runtime_capability_digest: sha("b"),
      source_commit: commit("a"),
      pipeline_id: "core/review",
      pipeline_selection: "config",
      entries: [config, platformPipeline],
    };
    expect(() => validateDefinitionBundle(bundle)).toThrow(/is not present in the trusted platform catalog/);
    expect(() => validateDefinitionBundle(bundle, {
      trustedPlatformDefinitions: new Map([
        ["pipeline:core/review", platformPipeline.content_hash],
      ]),
    })).not.toThrow();
  });

  it("binds each definition kind and ID to a traversal-safe repository path", () => {
    const pipeline = entry(
      "pipeline",
      "review",
      ".openthrottle/pipelines/review/pipeline.yml",
      { entry: "review" },
    );
    const config = entry(
      "config",
      "repository",
      ".openthrottle/config.yml",
      { engine: "codex", pipeline: "review" },
    );
    const bundle = {
      schema: DEFINITION_BUNDLE_SCHEMA,
      compiler_version: "definition-compiler/v1",
      runtime_capability_digest: sha("b"),
      source_commit: commit("a"),
      pipeline_id: "review",
      pipeline_selection: "config",
      entries: [config, pipeline],
    };
    expect(() => validateDefinitionBundle({
      ...bundle,
      entries: [config, { ...pipeline, path: ".openthrottle/pipelines/other/pipeline.yml" }],
    })).toThrow(/path: must be exactly \.openthrottle\/pipelines\/review\/pipeline\.yml/);
    expect(() => validateDefinitionBundle({
      ...bundle,
      entries: [config, { ...pipeline, path: ".openthrottle/pipelines/review/../other/pipeline.yml" }],
    })).toThrow(/path:/);
  });
});

describe("filesystem config contract", () => {
  it("selects a pipeline and engine without graph aliases", () => {
    expect(validateFilesystemConfigContract({
      schema: FILESYSTEM_CONFIG_SCHEMA,
      pipeline: "structured",
      engine: "codex",
      model: "gpt-5.6-codex",
      reasoning_effort: "high",
      commands: { test: "npm test" },
    }).value).toEqual({
      schema: FILESYSTEM_CONFIG_SCHEMA,
      pipeline: "structured",
      engine: "codex",
      model: "gpt-5.6-codex",
      reasoning_effort: "high",
      commands: { test: "npm test" },
    });
  });

  it("rejects legacy graph selection and provider/agent vocabulary", () => {
    expect(() => validateFilesystemConfigContract({
      schema: FILESYSTEM_CONFIG_SCHEMA,
      pipeline: "structured",
      engine: "codex",
      default_graph: "structured",
    })).toThrow(/default_graph: unknown field/);
    expect(() => validateFilesystemConfigContract({
      schema: FILESYSTEM_CONFIG_SCHEMA,
      pipeline: "structured",
      engine: "codex",
      agent: "reviewer",
    })).toThrow(/agent: unknown field/);
    expect(() => validateFilesystemConfigContract({
      schema: FILESYSTEM_CONFIG_SCHEMA,
      pipeline: "structured",
      engine: "codex",
      engine_defaults: { codex: { model: "gpt-5.6-codex" } },
    })).toThrow(/engine_defaults: unknown field/);
    expect(() => validateFilesystemConfigContract({
      schema: FILESYSTEM_CONFIG_SCHEMA,
      pipeline: "structured",
      engine: "codex",
      mcp_servers: {},
    })).toThrow(/mcp_servers: unknown field/);
    expect(() => validateFilesystemConfigContract({
      schema: FILESYSTEM_CONFIG_SCHEMA,
      pipeline: "structured",
      engine: "opencode",
      reasoning_effort: "high",
    })).toThrow(/reasoning_effort: is not supported for OpenCode/);
    expect(() => validateFilesystemConfigContract({
      schema: FILESYSTEM_CONFIG_SCHEMA,
      pipeline: "structured",
      engine: "opencode",
    })).toThrow(/model: is required for OpenCode/);
  });

  it("normalizes a bounded exact GitHub provider-evidence policy", () => {
    expect(validateFilesystemConfigContract({
      schema: FILESYSTEM_CONFIG_SCHEMA,
      pipeline: "structured",
      engine: "codex",
      provider_evidence: {
        github: {
          required_observations: [
            { kind: "commit_status", context: "coverage", creator_login: "coverage-bot" },
            { kind: "check_run", name: "quality", app_slug: "github-actions" },
            { kind: "check_run", name: "quality", app_slug: "trusted-quality-app" },
          ],
        },
      },
    }).value.provider_evidence).toEqual({
      github: {
        required_observations: [
          { kind: "check_run", name: "quality", app_slug: "github-actions" },
          { kind: "check_run", name: "quality", app_slug: "trusted-quality-app" },
          { kind: "commit_status", context: "coverage", creator_login: "coverage-bot" },
        ],
      },
    });
  });

  it("rejects empty, duplicate, over-bound, control-containing, and inexact provider observations", () => {
    const config = (required_observations: unknown) => ({
      schema: FILESYSTEM_CONFIG_SCHEMA,
      pipeline: "structured",
      engine: "codex",
      provider_evidence: { github: { required_observations } },
    });
    const check = { kind: "check_run", name: "quality", app_slug: "github-actions" };

    expect(() => validateFilesystemConfigContract(config([])))
      .toThrow(/required_observations.*between 1 and 32/);
    expect(() => validateFilesystemConfigContract(config(Array.from({ length: 33 }, (_, index) => ({
      kind: "check_run", name: `quality-${index}`, app_slug: "github-actions",
    })))))
      .toThrow(/required_observations.*between 1 and 32/);
    expect(() => validateFilesystemConfigContract(config([check, check])))
      .toThrow(/required_observations.*duplicate exact observations/);
    expect(() => validateFilesystemConfigContract(config([
      { ...check, name: "quality\nforged" },
    ]))).toThrow(/name.*control characters/);
    expect(() => validateFilesystemConfigContract(config([
      { ...check, creator_login: "wrong-producer-field" },
    ]))).toThrow(/creator_login: unknown field/);
    expect(() => validateFilesystemConfigContract(config([{
      kind: "commit_status",
      context: "coverage",
      creator_login: "coverage-bot",
      app_slug: "wrong-producer-field",
    }]))).toThrow(/app_slug: unknown field/);
    expect(() => validateFilesystemConfigContract({
      ...config([check]),
      provider_evidence: { github: { required_observations: [check], unexpected: true } },
    })).toThrow(/unexpected: unknown field/);
  });
});

describe("authored pipeline contract", () => {
  it("keeps authored agent identity and repository authority separate from config engine", () => {
    const pipeline = validatePipelineDefinition({
      schema: PIPELINE_DEFINITION_SCHEMA,
      id: "review",
      version: 1,
      entry: "review",
      stages: [{
        id: "review",
        kind: "agent",
        agent_id: "reviewer",
        repository_authority: "inspect",
        skills: ["review-change"],
        entry_skill: "review-change",
        eval: "review-result",
        on: { success: { terminal: "completed" }, needs_human: { terminal: "needs_human" } },
      }],
    }).value;

    expect(pipeline.stages[0]).toMatchObject({
      agent_id: "reviewer",
      repository_authority: "inspect",
    });
    expect(pipeline.stages[0]).not.toHaveProperty("engine");
  });

  it("rejects graph vocabulary and an entry skill outside the allowlist", () => {
    const stage = {
      id: "review",
      kind: "agent",
      agent_id: "reviewer",
      repository_authority: "inspect",
      skills: ["testing"],
      entry_skill: "review-change",
      eval: "review-result",
      on: { success: { terminal: "completed" } },
    };
    expect(() => validatePipelineDefinition({
      schema: PIPELINE_DEFINITION_SCHEMA,
      id: "review",
      version: 1,
      entry: "review",
      graph: "structured",
      stages: [stage],
    })).toThrow(/graph: unknown field/);
    expect(() => validatePipelineDefinition({
      schema: PIPELINE_DEFINITION_SCHEMA,
      id: "review",
      version: 1,
      entry: "review",
      stages: [stage],
    })).toThrow(/entry_skill: must be included in skills/);
  });

  it("validates the private compiled manifest without exposing graph identity", () => {
    const stage = {
      id: "review",
      kind: "agent",
      engine: "codex",
      agent_id: "reviewer",
      repository_authority: "inspect",
      skills: ["review-change"],
      entry_skill: "review-change",
      eval: "review-result",
      on: { success: { terminal: "completed" } },
    };
    expect(validateCompiledPipelineManifest({
      schema: COMPILED_PIPELINE_MANIFEST_SCHEMA,
      pipeline_id: "review",
      pipeline_version: 1,
      entry_stage: "review",
      definition_bundle_hash: sha("a"),
      compiler_version: "definition-compiler/v1",
      runtime_capability_digest: sha("b"),
      stages: [stage],
    }).value.entry_stage).toBe("review");
    expect(() => validatePipelineDefinition({
      schema: PIPELINE_DEFINITION_SCHEMA,
      id: "review",
      version: 1,
      entry: "review",
      stages: [stage],
    })).toThrow(/engine: is selected by config and valid only in a compiled manifest/);
    const { engine: _engine, ...authoredStage } = stage;
    expect(() => validateCompiledPipelineManifest({
      schema: COMPILED_PIPELINE_MANIFEST_SCHEMA,
      pipeline_id: "review",
      pipeline_version: 1,
      entry_stage: "review",
      definition_bundle_hash: sha("a"),
      compiler_version: "definition-compiler/v1",
      runtime_capability_digest: sha("b"),
      stages: [authoredStage],
    })).toThrow(/engine: must be one of/);
  });

  it("rejects pipeline-local loop traversal", () => {
    expect(() => validatePipelineDefinition({
      schema: PIPELINE_DEFINITION_SCHEMA,
      id: "structured",
      version: 1,
      entry: "implement",
      stages: [{
        id: "implement",
        kind: "agent",
        agent_id: "implementer",
        repository_authority: "edit",
        skills: ["implement-unit"],
        eval: "unit-result",
        loop: { over: "plan.units", max_parallel: 1, max_rounds: 2, file: "loops/a/../escape.yml" },
        on: { success: { terminal: "completed" } },
      }],
    })).toThrow(/loop\.file:/);
  });

  it("rejects unreachable stages and unbounded transition cycles", () => {
    const baseStage = {
      kind: "command",
      command: "test",
      on: { success: { terminal: "completed" } },
    };
    expect(() => validatePipelineDefinition({
      schema: PIPELINE_DEFINITION_SCHEMA,
      id: "invalid",
      version: 1,
      entry: "first",
      stages: [{ id: "first", ...baseStage }, { id: "orphan", ...baseStage }],
    })).toThrow(/contains unreachable stage orphan/);
    expect(() => validatePipelineDefinition({
      schema: PIPELINE_DEFINITION_SCHEMA,
      id: "invalid",
      version: 1,
      entry: "first",
      stages: [
        { id: "first", kind: "command", command: "test", on: { success: { to: "second" } } },
        { id: "second", kind: "command", command: "test", on: { success: { to: "first" } } },
      ],
    })).toThrow(/contains an unbounded transition cycle/);
    expect(() => validatePipelineDefinition({
      schema: PIPELINE_DEFINITION_SCHEMA,
      id: "bounded",
      version: 1,
      entry: "first",
      stages: [
        { id: "first", kind: "command", command: "test", on: { success: { to: "second" } } },
        {
          id: "second",
          kind: "command",
          command: "test",
          on: { success: { to: "first", max_reentries: 2, on_exhausted: "needs_human" } },
        },
      ],
    })).not.toThrow();
  });
});
