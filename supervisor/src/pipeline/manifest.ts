import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  "fresh_review",
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

export const EXECUTOR_KINDS = ["agent", "command", "provider_wait"] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];
export const EVALUATOR_KINDS = [
  "result",
  "semantic",
  "command",
  "provider",
  "human",
  "publish_subject",
] as const;
export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number];
export const ARTIFACT_KINDS = [
  "stage_result",
  "review",
  "command_result",
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

export interface PipelineStage {
  id: string;
  executor: { kind: ExecutorKind; capability: string };
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
  agent?: "claude" | "codex" | "opencode";
  model?: string;
  test?: string;
  lint?: string;
  build?: string;
  dev?: string;
  format?: string;
  post_bootstrap?: string[];
  limits?: { max_turns?: number; task_timeout?: number };
  mcp_servers?: Record<string, unknown>;
  pipelines?: { implement?: string; investigate?: string };
}

export interface ValidatedRepositoryConfig {
  config: RepositoryPipelineConfig;
  normalized: string;
  digest: string;
}

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const CAPABILITY = /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*@\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;

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

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function digestNormalized(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
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

function parseStage(value: unknown, path: string, defaults: ManifestDefaults): PipelineStage {
  const input = objectAt(value, path, [
    "id", "executor", "evaluator", "context", "live_steering", "credentials", "produces", "transitions", "retry",
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
  for (const required of stage.evaluator.required_artifacts) {
    if (!stage.produces.includes(required)) fail(`${path}.evaluator.required_artifacts`, `${required} is not produced by the stage`);
  }
  if (!stage.produces.includes("stage_result")) {
    fail(`${path}.produces`, "must include the typed stage_result artifact");
  }
  return stage;
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
  const visited = new Set<string>();
  const detectCycle = (stageId: string) => {
    if (visited.has(stageId)) return;
    visiting.add(stageId);
    for (const [outcome, transition] of Object.entries(stageById.get(stageId)!.transitions)) {
      if (!transition.to) continue;
      if (visiting.has(transition.to) && !transition.max_reentries) {
        fail(`${source}.stages.${stageId}.transitions.${outcome}`, "creates an unbounded cycle");
      }
      if (!visiting.has(transition.to)) detectCycle(transition.to);
    }
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
    "schema", "id", "version", "description", "entry_stage", "max_attempts", "requires", "defaults", "stages",
  ]);
  if (input.schema !== "openthrottle.pipeline/v1") fail(`${source}.schema`, "must be openthrottle.pipeline/v1");
  const requiresInput = objectAt(input.requires, `${source}.requires`, ["protocol", "capabilities"]);
  const defaults = parseManifestDefaults(input.defaults, `${source}.defaults`);
  const manifest: PipelineManifest = {
    schema: "openthrottle.pipeline/v1",
    id: stringAt(input.id, `${source}.id`, { max: 120, pattern: IDENTIFIER }),
    version: integerAt(input.version, `${source}.version`, 1, 1_000_000),
    description: stringAt(input.description, `${source}.description`, { max: 500 }),
    entry_stage: stringAt(input.entry_stage, `${source}.entry_stage`, { pattern: IDENTIFIER }),
    max_attempts: integerAt(input.max_attempts, `${source}.max_attempts`, 1, 20),
    requires: {
      protocol: stringAt(requiresInput.protocol, `${source}.requires.protocol`, { max: 80, pattern: CAPABILITY }),
      capabilities: unique(arrayAt(
        requiresInput.capabilities,
        `${source}.requires.capabilities`,
        (entry, entryPath) => stringAt(entry, entryPath, { max: 120, pattern: CAPABILITY }),
        { min: 1, max: 32 }
      ), `${source}.requires.capabilities`),
    },
    stages: arrayAt(input.stages, `${source}.stages`, (stage, path) => parseStage(stage, path, defaults), { min: 1, max: 32 }),
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

function boundedCommand(value: unknown, path: string): string {
  return stringAt(value, path, { max: 2_000 });
}

function boundedStringMap(value: unknown, path: string): Record<string, string> {
  const input = objectAt(value, path);
  if (Object.keys(input).length > 32) fail(path, "must contain at most 32 entries");
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(key)) fail(`${path}.${key}`, "has an invalid name");
    output[key] = stringAt(entry, `${path}.${key}`, { max: 2_000 });
  }
  return output;
}

function mcpServersAt(value: unknown, path: string): Record<string, unknown> {
  const input = objectAt(value, path);
  if (Object.keys(input).length > 20) fail(path, "must contain at most 20 servers");
  const output: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(input)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name)) fail(`${path}.${name}`, "has an invalid server name");
    const server = objectAt(raw, `${path}.${name}`, ["command", "args", "env", "url", "headers", "enabled"]);
    const hasCommand = server.command !== undefined;
    const hasUrl = server.url !== undefined;
    if (hasCommand === hasUrl) fail(`${path}.${name}`, "must define exactly one of command or url");
    const normalized: Record<string, unknown> = {};
    if (hasCommand) {
      normalized.command = boundedCommand(server.command, `${path}.${name}.command`);
      normalized.args = server.args === undefined ? [] : arrayAt(
        server.args,
        `${path}.${name}.args`,
        boundedCommand,
        { max: 32 }
      );
      normalized.env = server.env === undefined ? {} : boundedStringMap(server.env, `${path}.${name}.env`);
      if (server.headers !== undefined) fail(`${path}.${name}.headers`, "is valid only for a remote server");
    } else {
      const url = stringAt(server.url, `${path}.${name}.url`, { max: 2_000 });
      try {
        if (!/^https?:$/.test(new URL(url).protocol)) throw new Error("unsupported protocol");
      } catch {
        fail(`${path}.${name}.url`, "must be an absolute HTTP(S) URL");
      }
      normalized.url = url;
      normalized.headers = server.headers === undefined
        ? {}
        : boundedStringMap(server.headers, `${path}.${name}.headers`);
      if (server.args !== undefined || server.env !== undefined) {
        fail(`${path}.${name}`, "args and env are valid only for a local server");
      }
    }
    normalized.enabled = server.enabled === undefined
      ? true
      : booleanAt(server.enabled, `${path}.${name}.enabled`);
    output[name] = normalized;
  }
  return output;
}

export function parseRepositoryConfig(raw: string, source = ".openthrottle.yml"): ValidatedRepositoryConfig {
  const input = objectAt(parseYaml(raw, source), source, [
    "agent", "model", "test", "lint", "build", "dev", "format",
    "post_bootstrap", "limits", "mcp_servers", "pipelines",
  ]);
  const config: RepositoryPipelineConfig = {};
  if (input.agent !== undefined) config.agent = enumAt(input.agent, `${source}.agent`, ["claude", "codex", "opencode"] as const);
  if (input.model !== undefined) {
    config.model = stringAt(input.model, `${source}.model`, {
      max: 160,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    });
  }
  for (const key of ["test", "lint", "build", "dev", "format"] as const) {
    if (input[key] !== undefined) config[key] = boundedCommand(input[key], `${source}.${key}`);
  }
  if (input.post_bootstrap !== undefined) {
    config.post_bootstrap = arrayAt(input.post_bootstrap, `${source}.post_bootstrap`, boundedCommand, { max: 20 });
  }
  if (input.limits !== undefined) {
    const limits = objectAt(input.limits, `${source}.limits`, ["max_turns", "task_timeout"]);
    config.limits = {};
    if (limits.max_turns !== undefined) config.limits.max_turns = integerAt(limits.max_turns, `${source}.limits.max_turns`, 1, 1_000);
    if (limits.task_timeout !== undefined) config.limits.task_timeout = integerAt(limits.task_timeout, `${source}.limits.task_timeout`, 1, 86_400);
  }
  if (input.mcp_servers !== undefined) {
    config.mcp_servers = mcpServersAt(input.mcp_servers, `${source}.mcp_servers`);
  }
  if (input.pipelines !== undefined) {
    const pipelines = objectAt(input.pipelines, `${source}.pipelines`, ["implement", "investigate"]);
    config.pipelines = {};
    for (const intent of ["implement", "investigate"] as const) {
      if (pipelines[intent] !== undefined) {
        config.pipelines[intent] = stringAt(pipelines[intent], `${source}.pipelines.${intent}`, { max: 120, pattern: /^[a-z][a-z0-9]*(?:[._/@-][a-z0-9]+)*$/ });
      }
    }
  }
  const normalized = canonicalJson(config);
  const digest = digestNormalized(normalized);
  if (!SHA256.test(digest)) throw new Error("repository config digest invariant failed");
  return { config, normalized, digest };
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
