import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  canonicalJson as sharedCanonicalJson,
  digestNormalized as sharedDigestNormalized,
  validateRepositoryConfigContract,
  type ConfigGraphSource,
  type ConfigMcpServer,
  type ConfigRepositorySkill,
} from "@openthrottle/contracts";
import { parseDocument } from "yaml";

export const STAGE_OUTCOMES = [
  "success",
  "no_change",
  "semantic_repair_required",
  "retryable_infrastructure_failure",
  "needs_human",
  "canceled",
  "superseded",
  "failure",
] as const;
export type StageOutcome = (typeof STAGE_OUTCOMES)[number];

export const PIPELINE_OUTCOMES = [
  "shipped",
  "no_change",
  "needs_human",
  "canceled",
  "superseded",
  "failed",
] as const;
export type PipelineOutcome = (typeof PIPELINE_OUTCOMES)[number];

export const CONTEXT_POLICIES = [
  "none",
  "fresh",
  "resume_required",
  "prefer_resume",
] as const;
export type ContextPolicy = (typeof CONTEXT_POLICIES)[number];

export const ASSURANCE_CLASSES = [
  "semantic_attested",
  "semantic_corroborated",
  "executor_verified",
  "provider_verified",
  "human_approved",
] as const;
export type AssuranceClass = (typeof ASSURANCE_CLASSES)[number];

export const EXECUTOR_KINDS = ["agent", "command", "loop_action", "provider_wait"] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];
export const COMMAND_NAMES = ["test", "lint", "build", "format"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];
export const EVALUATOR_KINDS = [
  "semantic",
  "command",
  "provider",
  "human",
  "publish_subject",
] as const;
export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number];
export const ARTIFACT_KINDS = [
  "stage_result",
  "standard_receipt",
  "execution_graph_result",
  "review",
  "command_result",
  "candidate_evidence",
  "integration_evidence",
  "provider_check",
  "human_approval",
  "publish_subject",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface RuntimeCapabilityInventory {
  protocol: string;
  capabilities: readonly string[];
  executors: readonly ExecutorKind[];
  evaluators: readonly EvaluatorKind[];
  artifacts: readonly ArtifactKind[];
  contextPolicies: readonly ContextPolicy[];
  credentialScopes: readonly string[];
}

export interface PipelineTransition {
  to?: string;
  terminal?: PipelineOutcome;
  max_reentries?: number;
  on_exhausted?: PipelineOutcome;
}

export interface RepositorySkillPackageFile {
  path: string;
  blobSha: string;
  digest: string;
}

export interface RepositorySkillPackage {
  schema: "openthrottle.repository-skill-package/v1";
  reference: string;
  invocation: string;
  directory: string;
  commit: string;
  packageDigest: string;
  files: RepositorySkillPackageFile[];
}

export interface PipelineStage {
  id: string;
  executor: { kind: ExecutorKind; capability: string };
  commandName?: CommandName;
  repositorySkill?: RepositorySkillPackage;
  evaluator: { kind: EvaluatorKind; assurance: AssuranceClass; required_artifacts: ArtifactKind[] };
  context: ContextPolicy;
  live_steering: boolean;
  credentials: string[];
  produces: ArtifactKind[];
  transitions: Record<StageOutcome, PipelineTransition>;
}

export interface PipelineManifest {
  schema: "openthrottle.pipeline/v1";
  id: string;
  version: number;
  description: string;
  entry_stage: string;
  max_attempts: number;
  max_repair_rounds?: number;
  requires: {
    protocol: string;
    capabilities: string[];
  };
  stages: PipelineStage[];
}

interface RetryDeclaration {
  max_reentries: number;
  on_exhausted: PipelineOutcome;
}

interface ManifestDefaults {
  transitions: Partial<Record<StageOutcome, PipelineTransition>>;
  retry?: RetryDeclaration;
}

export interface ValidatedPipelineManifest {
  manifest: PipelineManifest;
  normalized: string;
  digest: string;
}

export interface PipelineCatalogAlias {
  id: string;
  version: number;
}

export interface ValidatedPipelineCatalog {
  aliases: Readonly<Record<string, PipelineCatalogAlias>>;
  manifests: ReadonlyMap<string, ValidatedPipelineManifest>;
  normalized: string;
  digest: string;
}

export interface RepositoryPipelineConfig {
  schema: "openthrottle.config/v1";
  default_graph: string;
  graphs: ConfigGraphSource[];
  skills?: ConfigRepositorySkill[];
  agent?: "claude" | "codex" | "opencode";
  model?: string;
  commands?: Record<string, string>;
  test?: string;
  lint?: string;
  build?: string;
  dev?: string;
  format?: string;
  post_bootstrap?: string[];
  limits?: { max_turns?: number; task_timeout?: number };
  mcp_servers?: Record<string, ConfigMcpServer>;
  pipelines?: Record<string, string>;
  intents?: Record<string, {
    default_graph: string;
    allowed_graphs: string[];
  }>;
}

export interface ValidatedRepositoryConfig {
  config: RepositoryPipelineConfig;
  normalized: string;
  digest: string;
}

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const CAPABILITY = /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*@\d+$/;
const SAFE_REPOSITORY_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/;
const REPOSITORY_SKILL_REFERENCE = /^repo:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}#(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/;
function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function objectAt(value: unknown, path: string, allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (allowed && !allowed.includes(key)) fail(`${path}.${key}`, "unknown field");
  }
  return record;
}

function stringAt(value: unknown, path: string, options?: { max?: number; pattern?: RegExp }): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
  if (value.length > (options?.max ?? 512)) fail(path, `must be at most ${options?.max ?? 512} characters`);
  if (options?.pattern && !options.pattern.test(value)) fail(path, "has an invalid format");
  return value;
}

function integerAt(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(path, `must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function enumAt<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(path, `must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function arrayAt<T>(
  value: unknown,
  path: string,
  parse: (entry: unknown, path: string) => T,
  options: { min?: number; max: number }
): T[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length < (options.min ?? 0) || value.length > options.max) {
    fail(path, `must contain between ${options.min ?? 0} and ${options.max} entries`);
  }
  return value.map((entry, index) => parse(entry, `${path}[${index}]`));
}

function unique<T extends string>(values: T[], path: string): T[] {
  if (new Set(values).size !== values.length) fail(path, "must not contain duplicates");
  return values;
}

function parseYaml(raw: string, source: string): unknown {
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) fail(source, "YAML exceeds 256 KiB");
  const document = parseDocument(raw, {
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) fail(source, document.errors[0]!.message);
  if (document.warnings.length > 0) fail(source, document.warnings[0]!.message);
  return document.toJS({ maxAliasCount: 0 });
}

export function canonicalJson(value: unknown): string {
  return sharedCanonicalJson(value);
}

export function digestNormalized(normalized: string): string {
  return sharedDigestNormalized(normalized);
}

export function isPipelineReentry(manifest: PipelineManifest, stageId: string, targetId: string): boolean {
  const stageIndex = manifest.stages.findIndex((stage) => stage.id === stageId);
  const targetIndex = manifest.stages.findIndex((stage) => stage.id === targetId);
  if (stageIndex < 0) throw new Error(`stage ${stageId} is absent from ${manifest.id}@${manifest.version}`);
  if (targetIndex < 0) throw new Error(`stage ${targetId} is absent from ${manifest.id}@${manifest.version}`);
  return targetId === stageId || targetIndex <= stageIndex;
}

function parseTransition(value: unknown, path: string): PipelineTransition {
  const input = objectAt(value, path, ["to", "terminal", "max_reentries", "on_exhausted"]);
  const to = input.to === undefined ? undefined : stringAt(input.to, `${path}.to`, { pattern: IDENTIFIER });
  const terminal = input.terminal === undefined
    ? undefined
    : enumAt(input.terminal, `${path}.terminal`, PIPELINE_OUTCOMES);
  if (Boolean(to) === Boolean(terminal)) fail(path, "must set exactly one of to or terminal");
  const maxReentries = input.max_reentries === undefined
    ? undefined
    : integerAt(input.max_reentries, `${path}.max_reentries`, 1, 20);
  const onExhausted = input.on_exhausted === undefined
    ? undefined
    : enumAt(input.on_exhausted, `${path}.on_exhausted`, PIPELINE_OUTCOMES);
  if (Boolean(maxReentries) !== Boolean(onExhausted)) {
    fail(path, "max_reentries and on_exhausted must be declared together");
  }
  if (terminal && maxReentries) fail(path, "a terminal transition cannot re-enter");
  return { ...(to ? { to } : {}), ...(terminal ? { terminal } : {}),
    ...(maxReentries ? { max_reentries: maxReentries, on_exhausted: onExhausted } : {}) };
}

function parseRetry(value: unknown, path: string): RetryDeclaration {
  const input = objectAt(value, path, ["max_reentries", "on_exhausted"]);
  return {
    max_reentries: integerAt(input.max_reentries, `${path}.max_reentries`, 1, 20),
    on_exhausted: enumAt(input.on_exhausted, `${path}.on_exhausted`, PIPELINE_OUTCOMES),
  };
}

function retryTransition(stageId: string, retry: RetryDeclaration): PipelineTransition {
  return {
    to: stageId,
    max_reentries: retry.max_reentries,
    on_exhausted: retry.on_exhausted,
  };
}

function parseTransitionMap(value: unknown, path: string): Partial<Record<StageOutcome, PipelineTransition>> {
  const input = objectAt(value, path);
  const transitions: Partial<Record<StageOutcome, PipelineTransition>> = {};
  for (const [outcome, transition] of Object.entries(input)) {
    if (outcome === "same_as") fail(`${path}.${outcome}`, "is reserved but not implemented");
    if (!STAGE_OUTCOMES.includes(outcome as StageOutcome)) fail(`${path}.${outcome}`, "unknown outcome");
    transitions[outcome as StageOutcome] = parseTransition(transition, `${path}.${outcome}`);
  }
  return transitions;
}

function parseManifestDefaults(value: unknown, path: string): ManifestDefaults {
  if (value === undefined) return { transitions: {} };
  const input = objectAt(value, path, ["transitions", "retry"]);
  return {
    transitions: input.transitions === undefined ? {} : parseTransitionMap(input.transitions, `${path}.transitions`),
    ...(input.retry === undefined ? {} : { retry: parseRetry(input.retry, `${path}.retry`) }),
  };
}

function parseStage(
  value: unknown,
  path: string,
  defaults: ManifestDefaults,
  options: { allowLegacyImplicitCommandName?: boolean } = {}
): PipelineStage {
  const input = objectAt(value, path, [
    "id", "executor", "commandName", "repositorySkill", "evaluator", "context", "live_steering", "credentials", "produces", "transitions", "retry",
  ]);
  const id = stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER });
  const executorInput = objectAt(input.executor, `${path}.executor`, ["kind", "capability"]);
  const executor = {
    kind: enumAt(executorInput.kind, `${path}.executor.kind`, EXECUTOR_KINDS),
    capability: stringAt(executorInput.capability, `${path}.executor.capability`, { pattern: CAPABILITY }),
  };
  const evaluatorInput = objectAt(input.evaluator, `${path}.evaluator`, ["kind", "assurance", "required_artifacts"]);
  const evaluator = {
    kind: enumAt(evaluatorInput.kind, `${path}.evaluator.kind`, EVALUATOR_KINDS),
    assurance: enumAt(evaluatorInput.assurance, `${path}.evaluator.assurance`, ASSURANCE_CLASSES),
    required_artifacts: unique(arrayAt(
      evaluatorInput.required_artifacts,
      `${path}.evaluator.required_artifacts`,
      (entry, entryPath) => enumAt(entry, entryPath, ARTIFACT_KINDS),
      { min: 1, max: 8 }
    ), `${path}.evaluator.required_artifacts`),
  };
  const declaredTransitions = input.transitions === undefined
    ? {}
    : parseTransitionMap(input.transitions, `${path}.transitions`);
  const mergedTransitions: Partial<Record<StageOutcome, PipelineTransition>> = { ...defaults.transitions };
  if (defaults.retry && declaredTransitions.retryable_infrastructure_failure === undefined) {
    mergedTransitions.retryable_infrastructure_failure = retryTransition(id, defaults.retry);
  }
  Object.assign(mergedTransitions, declaredTransitions);
  if (input.retry !== undefined) {
    mergedTransitions.retryable_infrastructure_failure = retryTransition(id, parseRetry(input.retry, `${path}.retry`));
  }
  const transitions = {} as Record<StageOutcome, PipelineTransition>;
  for (const outcome of STAGE_OUTCOMES) {
    if (mergedTransitions[outcome] === undefined) fail(`${path}.transitions.${outcome}`, "is required");
    transitions[outcome] = mergedTransitions[outcome];
  }
  const stage: PipelineStage = {
    id,
    executor,
    ...(input.commandName === undefined ? {} : {
      commandName: enumAt(input.commandName, `${path}.commandName`, COMMAND_NAMES),
    }),
    ...(input.repositorySkill === undefined ? {} : {
      repositorySkill: parseRepositorySkillPackage(input.repositorySkill, `${path}.repositorySkill`),
    }),
    evaluator,
    context: enumAt(input.context, `${path}.context`, CONTEXT_POLICIES),
    live_steering: booleanAt(input.live_steering, `${path}.live_steering`),
    credentials: unique(arrayAt(
      input.credentials,
      `${path}.credentials`,
      (entry, entryPath) => stringAt(entry, entryPath, { max: 80, pattern: IDENTIFIER }),
      { max: 16 }
    ), `${path}.credentials`),
    produces: unique(arrayAt(
      input.produces,
      `${path}.produces`,
      (entry, entryPath) => enumAt(entry, entryPath, ARTIFACT_KINDS),
      { min: 1, max: 8 }
    ), `${path}.produces`),
    transitions,
  };
  if (stage.live_steering && stage.executor.kind !== "agent") {
    fail(`${path}.live_steering`, "is allowed only for agent executors");
  }
  if (stage.executor.kind === "command") {
    if (!stage.commandName && !options.allowLegacyImplicitCommandName) {
      fail(`${path}.commandName`, "is required for command executors");
    }
  } else if (stage.commandName) {
    fail(`${path}.commandName`, "is allowed only for command executors");
  }
  if (stage.repositorySkill) {
    if (stage.executor.kind !== "agent" || stage.executor.capability !== "agent/repository-skill@1") {
      fail(`${path}.repositorySkill`, "is allowed only for agent/repository-skill@1 stages");
    }
  }
  for (const required of stage.evaluator.required_artifacts) {
    if (!stage.produces.includes(required)) fail(`${path}.evaluator.required_artifacts`, `${required} is not produced by the stage`);
  }
  if (!stage.produces.includes("stage_result")) {
    fail(`${path}.produces`, "must include the typed stage_result artifact");
  }
  return stage;
}

function parseRepositorySkillPackage(value: unknown, path: string): RepositorySkillPackage {
  const input = objectAt(value, path, ["schema", "reference", "invocation", "directory", "commit", "packageDigest", "files"]);
  if (input.schema !== "openthrottle.repository-skill-package/v1") {
    fail(`${path}.schema`, "must be openthrottle.repository-skill-package/v1");
  }
  const reference = stringAt(input.reference, `${path}.reference`, { max: 320, pattern: REPOSITORY_SKILL_REFERENCE });
  const directory = stringAt(input.directory, `${path}.directory`, { max: 240, pattern: SAFE_REPOSITORY_PATH });
  if (directory.endsWith("/")) fail(`${path}.directory`, "must not end with a slash");
  if (!reference.endsWith(`#${directory}`)) {
    fail(`${path}.reference`, "must name the same repository skill directory");
  }
  const files = arrayAt(input.files, `${path}.files`, (file, filePath) => {
    const fileInput = objectAt(file, filePath, ["path", "blobSha", "digest"]);
    const fileEntry = {
      path: stringAt(fileInput.path, `${filePath}.path`, { max: 512, pattern: SAFE_REPOSITORY_PATH }),
      blobSha: stringAt(fileInput.blobSha, `${filePath}.blobSha`, { pattern: /^[a-f0-9]{40}$/ }),
      digest: stringAt(fileInput.digest, `${filePath}.digest`, { pattern: /^[a-f0-9]{64}$/ }),
    };
    if (!fileEntry.path.startsWith(`${directory}/`)) {
      fail(`${filePath}.path`, "must stay inside the repository skill directory");
    }
    return fileEntry;
  }, { min: 1, max: 64 });
  unique(files.map((file) => file.path), `${path}.files.path`);
  if (!files.some((file) => file.path === `${directory}/SKILL.md`)) {
    fail(`${path}.files`, "must include SKILL.md at the repository skill directory root");
  }
  return {
    schema: "openthrottle.repository-skill-package/v1",
    reference,
    invocation: stringAt(input.invocation, `${path}.invocation`, { pattern: IDENTIFIER }),
    directory,
    commit: stringAt(input.commit, `${path}.commit`, { pattern: /^[a-f0-9]{40}$/ }),
    packageDigest: stringAt(input.packageDigest, `${path}.packageDigest`, { pattern: /^[a-f0-9]{64}$/ }),
    files,
  };
}

function allowsLegacyImplicitCommandName(id: string, version: number): boolean {
  return (
    (id === "core/implement" && version === 1) ||
    (id === "ce/implement" && (version === 2 || version === 3))
  );
}

function validateGraph(manifest: PipelineManifest, source: string): void {
  const stageById = new Map(manifest.stages.map((stage) => [stage.id, stage]));
  if (stageById.size !== manifest.stages.length) fail(`${source}.stages`, "contains duplicate stage IDs");
  if (!stageById.has(manifest.entry_stage)) fail(`${source}.entry_stage`, "does not reference a stage");
  for (const stage of manifest.stages) {
    for (const [outcome, transition] of Object.entries(stage.transitions)) {
      if (transition.to && !stageById.has(transition.to)) {
        fail(`${source}.stages.${stage.id}.transitions.${outcome}.to`, "references an unknown stage");
      }
      if (transition.to) {
        if (isPipelineReentry(manifest, stage.id, transition.to) && transition.max_reentries === undefined) {
          fail(`${source}.stages.${stage.id}.transitions.${outcome}`, "re-entering transitions must declare max_reentries");
        }
      }
    }
  }

  const reachable = new Set<string>();
  const visit = (stageId: string) => {
    if (reachable.has(stageId)) return;
    reachable.add(stageId);
    for (const transition of Object.values(stageById.get(stageId)!.transitions)) {
      if (transition.to) visit(transition.to);
    }
  };
  visit(manifest.entry_stage);
  const unreachable = manifest.stages.find((stage) => !reachable.has(stage.id));
  if (unreachable) fail(`${source}.stages.${unreachable.id}`, "is unreachable from entry_stage");

  const visiting = new Set<string>();
  const stack: Array<{ stageId: string; incomingBounded: boolean }> = [];
  const visited = new Set<string>();
  const detectCycle = (stageId: string, incomingBounded = false) => {
    if (visited.has(stageId)) return;
    visiting.add(stageId);
    stack.push({ stageId, incomingBounded });
    for (const [outcome, transition] of Object.entries(stageById.get(stageId)!.transitions)) {
      if (!transition.to) continue;
      if (visiting.has(transition.to)) {
        const targetIndex = stack.findIndex((entry) => entry.stageId === transition.to);
        let cycleHasBound = transition.max_reentries !== undefined;
        for (let index = targetIndex + 1; !cycleHasBound && index < stack.length; index += 1) {
          cycleHasBound = stack[index]!.incomingBounded;
        }
        if (!cycleHasBound) fail(`${source}.stages.${stageId}.transitions.${outcome}`, "creates an unbounded cycle");
      }
      if (!visiting.has(transition.to)) detectCycle(transition.to, transition.max_reentries !== undefined);
    }
    stack.pop();
    visiting.delete(stageId);
    visited.add(stageId);
  };
  detectCycle(manifest.entry_stage);
}

export function validatePipelineManifest(
  value: unknown,
  options: { source?: string; runtime?: RuntimeCapabilityInventory } = {}
): ValidatedPipelineManifest {
  const source = options.source ?? "pipeline";
  const input = objectAt(value, source, [
    "schema", "id", "version", "description", "entry_stage", "max_attempts", "max_repair_rounds",
    "requires", "defaults", "stages",
  ]);
  if (input.schema !== "openthrottle.pipeline/v1") fail(`${source}.schema`, "must be openthrottle.pipeline/v1");
  const requiresInput = objectAt(input.requires, `${source}.requires`, ["protocol", "capabilities"]);
  const defaults = parseManifestDefaults(input.defaults, `${source}.defaults`);
  const id = stringAt(input.id, `${source}.id`, { max: 120, pattern: IDENTIFIER });
  const version = integerAt(input.version, `${source}.version`, 1, 1_000_000);
  const allowLegacyImplicitCommandName = allowsLegacyImplicitCommandName(id, version);
  const manifest: PipelineManifest = {
    schema: "openthrottle.pipeline/v1",
    id,
    version,
    description: stringAt(input.description, `${source}.description`, { max: 500 }),
    entry_stage: stringAt(input.entry_stage, `${source}.entry_stage`, { pattern: IDENTIFIER }),
    max_attempts: integerAt(input.max_attempts, `${source}.max_attempts`, 1, 200),
    ...(input.max_repair_rounds === undefined ? {} : {
      max_repair_rounds: integerAt(input.max_repair_rounds, `${source}.max_repair_rounds`, 1, 20),
    }),
    requires: {
      protocol: stringAt(requiresInput.protocol, `${source}.requires.protocol`, { max: 80, pattern: CAPABILITY }),
      capabilities: unique(arrayAt(
        requiresInput.capabilities,
        `${source}.requires.capabilities`,
        (entry, entryPath) => stringAt(entry, entryPath, { max: 120, pattern: CAPABILITY }),
        { min: 1, max: 32 }
      ), `${source}.requires.capabilities`),
    },
    stages: arrayAt(
      input.stages,
      `${source}.stages`,
      (stage, path) => parseStage(stage, path, defaults, {
        allowLegacyImplicitCommandName,
      }),
      { min: 1, max: 32 }
    ),
  };
  validateGraph(manifest, source);
  for (const stage of manifest.stages) {
    if (!manifest.requires.capabilities.includes(stage.executor.capability)) {
      fail(
        `${source}.stages.${stage.id}.executor.capability`,
        `${stage.executor.capability} is not declared in requires.capabilities`
      );
    }
  }

  if (options.runtime) {
    const runtime = options.runtime;
    const missing: string[] = [];
    if (runtime.protocol !== manifest.requires.protocol) missing.push(`protocol:${manifest.requires.protocol}`);
    for (const capability of manifest.requires.capabilities) {
      if (!runtime.capabilities.includes(capability)) missing.push(`capability:${capability}`);
    }
    for (const stage of manifest.stages) {
      if (!runtime.executors.includes(stage.executor.kind)) missing.push(`executor:${stage.executor.kind}`);
      if (!runtime.capabilities.includes(stage.executor.capability)) missing.push(`capability:${stage.executor.capability}`);
      if (!runtime.evaluators.includes(stage.evaluator.kind)) missing.push(`evaluator:${stage.evaluator.kind}`);
      if (!runtime.contextPolicies.includes(stage.context)) missing.push(`context:${stage.context}`);
      for (const artifact of stage.produces) if (!runtime.artifacts.includes(artifact)) missing.push(`artifact:${artifact}`);
      for (const scope of stage.credentials) if (!runtime.credentialScopes.includes(scope)) missing.push(`credential:${scope}`);
    }
    const uniqueMissing = [...new Set(missing)].sort();
    if (uniqueMissing.length > 0) fail(source, `runtime capability mismatch: ${uniqueMissing.join(", ")}`);
  }
  const normalized = canonicalJson(manifest);
  return { manifest, normalized, digest: digestNormalized(normalized) };
}

export function parsePipelineManifest(
  raw: string,
  options: { source?: string; runtime?: RuntimeCapabilityInventory } = {}
): ValidatedPipelineManifest {
  const source = options.source ?? "pipeline";
  return validatePipelineManifest(parseYaml(raw, source), { ...options, source });
}

function manifestKey(id: string, version: number): string {
  return `${id}@${version}`;
}

export function loadPipelineCatalog(
  catalogPath: string,
  runtime?: RuntimeCapabilityInventory
): ValidatedPipelineCatalog {
  const catalogInput = objectAt(parseYaml(readFileSync(catalogPath, "utf8"), catalogPath), catalogPath, [
    "schema", "manifests", "aliases",
  ]);
  if (catalogInput.schema !== "openthrottle.catalog/v1") fail(`${catalogPath}.schema`, "must be openthrottle.catalog/v1");
  const files = unique(arrayAt(
    catalogInput.manifests,
    `${catalogPath}.manifests`,
    (entry, path) => stringAt(entry, path, { max: 160, pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ya?ml$/ }),
    { min: 1, max: 64 }
  ), `${catalogPath}.manifests`);
  const manifests = new Map<string, ValidatedPipelineManifest>();
  for (const file of files) {
    const path = resolve(dirname(catalogPath), file);
    const validated = parsePipelineManifest(readFileSync(path, "utf8"), { source: path, runtime });
    const key = manifestKey(validated.manifest.id, validated.manifest.version);
    if (manifests.has(key)) fail(catalogPath, `duplicate pipeline identity ${key}`);
    manifests.set(key, validated);
  }
  const aliasesInput = objectAt(catalogInput.aliases, `${catalogPath}.aliases`);
  const aliases: Record<string, PipelineCatalogAlias> = {};
  for (const [alias, value] of Object.entries(aliasesInput)) {
    if (!IDENTIFIER.test(alias)) fail(`${catalogPath}.aliases.${alias}`, "has an invalid alias");
    const reference = objectAt(value, `${catalogPath}.aliases.${alias}`, ["id", "version"]);
    const resolved = {
      id: stringAt(reference.id, `${catalogPath}.aliases.${alias}.id`, { pattern: IDENTIFIER }),
      version: integerAt(reference.version, `${catalogPath}.aliases.${alias}.version`, 1, 1_000_000),
    };
    if (!manifests.has(manifestKey(resolved.id, resolved.version))) {
      fail(`${catalogPath}.aliases.${alias}`, "references an unknown pipeline");
    }
    aliases[alias] = resolved;
  }
  const normalized = canonicalJson({
    aliases,
    manifests: [...manifests.values()].map((entry) => ({
      id: entry.manifest.id,
      version: entry.manifest.version,
      digest: entry.digest,
    })).sort((left, right) => manifestKey(left.id, left.version).localeCompare(manifestKey(right.id, right.version))),
  });
  return { aliases, manifests, normalized, digest: digestNormalized(normalized) };
}

export function parseRepositoryConfig(raw: string, source = ".openthrottle.yml"): ValidatedRepositoryConfig {
  const validated = validateRepositoryConfigContract(parseYaml(raw, source), { source });
  const value = validated.value;
  const config: RepositoryPipelineConfig = {
    schema: value.schema,
    default_graph: value.default_graph,
    graphs: value.graphs,
    ...(value.skills === undefined ? {} : { skills: value.skills }),
    ...(value.agent === undefined ? {} : { agent: enumAt(value.agent, `${source}.agent`, ["claude", "codex", "opencode"] as const) }),
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.commands === undefined ? {} : { commands: value.commands }),
    ...(value.test === undefined ? {} : { test: value.test }),
    ...(value.lint === undefined ? {} : { lint: value.lint }),
    ...(value.build === undefined ? {} : { build: value.build }),
    ...(value.dev === undefined ? {} : { dev: value.dev }),
    ...(value.format === undefined ? {} : { format: value.format }),
    ...(value.post_bootstrap === undefined ? {} : { post_bootstrap: value.post_bootstrap }),
    ...(value.limits === undefined ? {} : { limits: value.limits }),
    ...(value.mcp_servers === undefined ? {} : { mcp_servers: value.mcp_servers }),
    ...(value.pipelines === undefined ? {} : { pipelines: value.pipelines }),
    ...(value.intents === undefined ? {} : { intents: value.intents }),
  };
  return { config, normalized: validated.normalized, digest: validated.digest };
}

export function resolvePipelineReference(
  catalog: ValidatedPipelineCatalog,
  reference: string
): ValidatedPipelineManifest {
  const alias = catalog.aliases[reference];
  const key = alias ? manifestKey(alias.id, alias.version) : reference;
  const manifest = catalog.manifests.get(key);
  if (!manifest) throw new Error(`unknown pipeline selection: ${reference}`);
  return manifest;
}
