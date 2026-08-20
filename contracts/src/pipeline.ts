import {
  COMMAND_NAME_PATTERN,
  IDENTIFIER,
  SHA256,
  arrayAt,
  enumAt,
  fail,
  integerAt,
  normalizedContract,
  objectAt,
  recordAt,
  stringAt,
  unique,
  type ValidatedContract,
} from "./validation.js";

export const PIPELINE_DEFINITION_SCHEMA = "openthrottle.pipeline-definition/v1" as const;
export const COMPILED_PIPELINE_MANIFEST_SCHEMA = "openthrottle.compiled-pipeline-manifest/v1" as const;
export const ENGINES = ["claude", "codex", "opencode"] as const;
export const REPOSITORY_AUTHORITIES = ["inspect", "edit"] as const;
export const PIPELINE_STAGE_KINDS = ["agent", "command", "effect", "wait"] as const;
export const PIPELINE_TERMINAL_OUTCOMES = [
  "completed", "no_change", "needs_human", "failed", "canceled", "superseded",
] as const;

const OUTCOME = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const VERSION_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const LOOP_FILE = /^loops\/(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+\.ya?ml$/;

export type Engine = (typeof ENGINES)[number];
export type RepositoryAuthority = (typeof REPOSITORY_AUTHORITIES)[number];
export type PipelineStageKind = (typeof PIPELINE_STAGE_KINDS)[number];
export type PipelineTerminalOutcome = (typeof PIPELINE_TERMINAL_OUTCOMES)[number];

export interface PipelineTransition {
  to?: string;
  terminal?: PipelineTerminalOutcome;
  max_reentries?: number;
  on_exhausted?: "needs_human" | "failed";
}

export interface PipelineLoopBinding {
  over: string;
  max_parallel: number;
  max_rounds: number;
  body?: string[];
  file?: string;
}

interface PipelineStageBase {
  id: string;
  loop?: PipelineLoopBinding;
  on: Record<string, PipelineTransition>;
}

interface AgentPipelineStageBase extends PipelineStageBase {
  kind: "agent";
  agent_id: string;
  repository_authority: RepositoryAuthority;
  skills: string[];
  entry_skill?: string;
  eval: string;
}

export interface AuthoredAgentPipelineStage extends AgentPipelineStageBase {
  engine?: never;
}

export interface CompiledAgentPipelineStage extends AgentPipelineStageBase {
  engine: Engine;
}

export interface CommandPipelineStage extends PipelineStageBase {
  kind: "command";
  command: string;
}

export interface EffectPipelineStage extends PipelineStageBase {
  kind: "effect";
  effect: string;
}

export interface WaitPipelineStage extends PipelineStageBase {
  kind: "wait";
  wait: string;
}

export type AuthoredPipelineStage =
  | AuthoredAgentPipelineStage
  | CommandPipelineStage
  | EffectPipelineStage
  | WaitPipelineStage;

export type CompiledPipelineStage =
  | CompiledAgentPipelineStage
  | CommandPipelineStage
  | EffectPipelineStage
  | WaitPipelineStage;

type AnyPipelineStage = AuthoredPipelineStage | CompiledPipelineStage;

export interface PipelineDefinition {
  schema: typeof PIPELINE_DEFINITION_SCHEMA;
  id: string;
  version: number;
  entry: string;
  stages: AuthoredPipelineStage[];
}

export interface CompiledPipelineManifest {
  schema: typeof COMPILED_PIPELINE_MANIFEST_SCHEMA;
  pipeline_id: string;
  pipeline_version: number;
  entry_stage: string;
  definition_bundle_hash: string;
  compiler_version: string;
  runtime_capability_digest: string;
  stages: CompiledPipelineStage[];
}

function transition(value: unknown, path: string): PipelineTransition {
  const input = objectAt(value, path, ["to", "terminal", "max_reentries", "on_exhausted"]);
  const to = input.to === undefined
    ? undefined
    : stringAt(input.to, `${path}.to`, { pattern: IDENTIFIER });
  const terminal = input.terminal === undefined
    ? undefined
    : enumAt(input.terminal, `${path}.terminal`, PIPELINE_TERMINAL_OUTCOMES);
  if ((to === undefined) === (terminal === undefined)) fail(path, "must define exactly one of to or terminal");
  const maxReentries = input.max_reentries === undefined
    ? undefined
    : integerAt(input.max_reentries, `${path}.max_reentries`, 1, 100);
  const onExhausted = input.on_exhausted === undefined
    ? undefined
    : enumAt(input.on_exhausted, `${path}.on_exhausted`, ["needs_human", "failed"] as const);
  if ((maxReentries === undefined) !== (onExhausted === undefined)) {
    fail(path, "max_reentries and on_exhausted must be declared together");
  }
  if (terminal !== undefined && maxReentries !== undefined) {
    fail(path, "terminal transitions cannot re-enter");
  }
  return {
    ...(to === undefined ? {} : { to }),
    ...(terminal === undefined ? {} : { terminal }),
    ...(maxReentries === undefined ? {} : { max_reentries: maxReentries, on_exhausted: onExhausted }),
  };
}

function loopBinding(value: unknown, path: string): PipelineLoopBinding {
  const input = objectAt(value, path, ["over", "max_parallel", "max_rounds", "body", "file"]);
  const body = input.body === undefined
    ? undefined
    : unique(arrayAt(
      input.body,
      `${path}.body`,
      (entry, itemPath) => stringAt(entry, itemPath, { pattern: IDENTIFIER }),
      { min: 1, max: 64 },
    ), `${path}.body`);
  const file = input.file === undefined
    ? undefined
    : stringAt(input.file, `${path}.file`, { max: 300, pattern: LOOP_FILE });
  if (file !== undefined) {
    const segments = file.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      fail(`${path}.file`, "must not contain empty, current-directory, or parent-directory segments");
    }
  }
  if ((body === undefined) === (file === undefined)) fail(path, "must define exactly one of body or file");
  return {
    over: stringAt(input.over, `${path}.over`, { max: 300 }),
    max_parallel: integerAt(input.max_parallel, `${path}.max_parallel`, 1, 64),
    max_rounds: integerAt(input.max_rounds, `${path}.max_rounds`, 1, 100),
    ...(body === undefined ? {} : { body }),
    ...(file === undefined ? {} : { file }),
  };
}

function parseStage(value: unknown, path: string, compiled: false): AuthoredPipelineStage;
function parseStage(value: unknown, path: string, compiled: true): CompiledPipelineStage;
function parseStage(value: unknown, path: string, compiled: boolean): AnyPipelineStage {
  const input = objectAt(value, path, [
    "id", "kind", "engine", "agent_id", "repository_authority", "skills", "entry_skill", "eval",
    "command", "effect", "wait", "loop", "on",
  ]);
  const kind = enumAt(input.kind, `${path}.kind`, PIPELINE_STAGE_KINDS);
  const base: PipelineStageBase = {
    id: stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER }),
    ...(input.loop === undefined ? {} : { loop: loopBinding(input.loop, `${path}.loop`) }),
    on: recordAt(input.on, `${path}.on`, transition, {
      max: 32,
      keyMax: 80,
      keyPattern: OUTCOME,
    }),
  };
  if (Object.keys(base.on).length === 0) fail(`${path}.on`, "must contain at least one transition");
  const rejectFields = (fields: readonly string[], message: string): void => {
    for (const field of fields) if (input[field] !== undefined) fail(`${path}.${field}`, message);
  };
  if (kind === "agent") {
    rejectFields(["command", "effect", "wait"], "is not valid for an agent stage");
    if (!compiled && input.engine !== undefined) {
      fail(`${path}.engine`, "is selected by config and valid only in a compiled manifest");
    }
    const skills = unique(arrayAt(
      input.skills,
      `${path}.skills`,
      (entry, itemPath) => stringAt(entry, itemPath, { pattern: IDENTIFIER }),
      { max: 32 },
    ), `${path}.skills`);
    const entrySkill = input.entry_skill === undefined
      ? undefined
      : stringAt(input.entry_skill, `${path}.entry_skill`, { pattern: IDENTIFIER });
    if (entrySkill && !skills.includes(entrySkill)) {
      fail(`${path}.entry_skill`, "must be included in skills");
    }
    const agent = {
      ...base,
      kind,
      agent_id: stringAt(input.agent_id, `${path}.agent_id`, { pattern: IDENTIFIER }),
      repository_authority: enumAt(
        input.repository_authority,
        `${path}.repository_authority`,
        REPOSITORY_AUTHORITIES,
      ),
      skills,
      ...(entrySkill === undefined ? {} : { entry_skill: entrySkill }),
      eval: stringAt(input.eval, `${path}.eval`, { pattern: IDENTIFIER }),
    };
    if (!compiled) return agent;
    return { ...agent, engine: enumAt(input.engine, `${path}.engine`, ENGINES) };
  }
  rejectFields(
    ["engine", "agent_id", "repository_authority", "skills", "entry_skill", "eval"],
    "is valid only for an agent stage",
  );
  if (kind === "command") {
    rejectFields(["effect", "wait"], "is not valid for a command stage");
    return {
      ...base,
      kind,
      command: stringAt(input.command, `${path}.command`, { max: 80, pattern: COMMAND_NAME_PATTERN }),
    };
  }
  if (kind === "effect") {
    rejectFields(["command", "wait"], "is not valid for an effect stage");
    return {
      ...base,
      kind,
      effect: stringAt(input.effect, `${path}.effect`, { max: 200, pattern: VERSION_REFERENCE }),
    };
  }
  rejectFields(["command", "effect"], "is not valid for a wait stage");
  return {
    ...base,
    kind,
    wait: stringAt(input.wait, `${path}.wait`, { max: 200, pattern: VERSION_REFERENCE }),
  };
}

function validateStages(stages: AnyPipelineStage[], entry: string, source: string): void {
  const ids = stages.map((stage) => stage.id);
  if (new Set(ids).size !== ids.length) fail(`${source}.stages`, "must not contain duplicate IDs");
  const known = new Set(ids);
  if (!known.has(entry)) fail(`${source}.entry`, "references an unknown stage");
  for (const [index, stage] of stages.entries()) {
    for (const [outcome, next] of Object.entries(stage.on)) {
      if (next.to !== undefined && !known.has(next.to)) {
        fail(`${source}.stages[${index}].on.${outcome}.to`, "references an unknown stage");
      }
    }
    for (const [bodyIndex, bodyStage] of (stage.loop?.body ?? []).entries()) {
      if (!known.has(bodyStage)) {
        fail(`${source}.stages[${index}].loop.body[${bodyIndex}]`, "references an unknown stage");
      }
    }
  }

  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const reachable = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const stage = byId.get(id)!;
    pending.push(
      ...Object.values(stage.on).flatMap((next) => next.to === undefined ? [] : [next.to]),
      ...(stage.loop?.body ?? []),
    );
  }
  const unreachable = stages.find((stage) => !reachable.has(stage.id));
  if (unreachable) fail(`${source}.stages`, `contains unreachable stage ${unreachable.id}`);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) fail(`${source}.stages`, `contains an unbounded transition cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const stage = byId.get(id)!;
    for (const next of Object.values(stage.on)) {
      if (next.to !== undefined && next.max_reentries === undefined) visit(next.to);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const stage of stages) visit(stage.id);
}

export function validatePipelineDefinition(
  value: unknown,
  options: { source?: string } = {},
): ValidatedContract<PipelineDefinition> {
  const source = options.source ?? "pipeline";
  const input = objectAt(value, source, ["schema", "id", "version", "entry", "stages"]);
  if (input.schema !== PIPELINE_DEFINITION_SCHEMA) {
    fail(`${source}.schema`, `must be ${PIPELINE_DEFINITION_SCHEMA}`);
  }
  const entry = stringAt(input.entry, `${source}.entry`, { pattern: IDENTIFIER });
  const stages = arrayAt(
    input.stages,
    `${source}.stages`,
    (stage, path) => parseStage(stage, path, false),
    { min: 1, max: 256 },
  );
  validateStages(stages, entry, source);
  return normalizedContract({
    schema: PIPELINE_DEFINITION_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
    version: integerAt(input.version, `${source}.version`, 1, 1_000_000),
    entry,
    stages,
  });
}

export function validateCompiledPipelineManifest(
  value: unknown,
  options: { source?: string } = {},
): ValidatedContract<CompiledPipelineManifest> {
  const source = options.source ?? "compiled_pipeline_manifest";
  const input = objectAt(value, source, [
    "schema", "pipeline_id", "pipeline_version", "entry_stage", "definition_bundle_hash",
    "compiler_version", "runtime_capability_digest", "stages",
  ]);
  if (input.schema !== COMPILED_PIPELINE_MANIFEST_SCHEMA) {
    fail(`${source}.schema`, `must be ${COMPILED_PIPELINE_MANIFEST_SCHEMA}`);
  }
  const entryStage = stringAt(input.entry_stage, `${source}.entry_stage`, { pattern: IDENTIFIER });
  const stages = arrayAt(
    input.stages,
    `${source}.stages`,
    (stage, path) => parseStage(stage, path, true),
    { min: 1, max: 256 },
  );
  validateStages(stages, entryStage, source);
  return normalizedContract({
    schema: COMPILED_PIPELINE_MANIFEST_SCHEMA,
    pipeline_id: stringAt(input.pipeline_id, `${source}.pipeline_id`, { pattern: IDENTIFIER }),
    pipeline_version: integerAt(input.pipeline_version, `${source}.pipeline_version`, 1, 1_000_000),
    entry_stage: entryStage,
    definition_bundle_hash: stringAt(input.definition_bundle_hash, `${source}.definition_bundle_hash`, { pattern: SHA256 }),
    compiler_version: stringAt(input.compiler_version, `${source}.compiler_version`, { max: 200, pattern: VERSION_REFERENCE }),
    runtime_capability_digest: stringAt(
      input.runtime_capability_digest,
      `${source}.runtime_capability_digest`,
      { pattern: SHA256 },
    ),
    stages,
  });
}
