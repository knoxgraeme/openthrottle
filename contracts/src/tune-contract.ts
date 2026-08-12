import {
  IDENTIFIER,
  SHA256,
  arrayAt,
  booleanAt,
  enumAt,
  fail,
  integerAt,
  normalizedContract,
  objectAt,
  optional,
  stringAt,
  unique,
  type ValidatedContract,
} from "./validation.js";

export const TUNE_TASK_SCHEMA = "openthrottle.tune-task/v1" as const;
export const TUNE_SEALED_INTENT_SCHEMA = "openthrottle.tune-sealed-intent/v1" as const;
export const TUNE_ANALYSIS_SCHEMA = "openthrottle.tune-analysis/v1" as const;
export const TUNE_PROPOSAL_SCHEMA = "openthrottle.tune-proposal/v1" as const;
export const TUNE_DECISION_SCHEMA = "openthrottle.tune-decision/v1" as const;
export const TUNE_EDIT_AUTHORIZATION_SCHEMA = "openthrottle.tune-edit-authorization/v1" as const;
export const TUNE_RELEASE_DESCRIPTOR_SCHEMA = "openthrottle.tune-release-descriptor/v1" as const;

export const TUNE_TARGET_KINDS = ["contract", "graph", "pipeline", "runtime", "skill"] as const;
export const TUNE_SCOPES = ["repository", "pipeline", "runtime"] as const;
export const TUNE_PROPOSAL_OUTCOMES = ["propose", "no_change", "needs_human"] as const;
export const TUNE_DECISION_OUTCOMES = ["accept", "reject", "needs_human"] as const;
export const TUNE_CORPUS_OUTCOMES = ["success", "failure", "needs_human", "canceled", "superseded"] as const;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/;
const TARGET_FIELDS = ["kind", "id", "path", "digest"] as const;
const QUERY_FIELDS = ["outcome", "reason", "graph", "skill", "limit"] as const;
const WINDOW_FIELDS = ["from", "to", "limit"] as const;
const POLICY_FIELDS = ["allow_edit_paths", "requires_citation_gate", "requires_ratchet", "max_changed_files"] as const;
const BASELINE_FIELDS = ["base_ref", "base_digest", "runtime_release", "capability_digest"] as const;
const TASK_FIELDS = ["schema", "id", "target", "query", "scope", "window", "baseline", "policy"] as const;
const SEALED_INTENT_FIELDS = ["schema", "id", "task", "task_digest", "sealed_at", "authority_digest"] as const;
const CORPUS_ROW_FIELDS = [
  "id", "pipeline_instance_id", "generation", "graph_id", "outcome", "reason",
  "created_at", "artifact_digests", "row_digest",
] as const;
const ANALYSIS_FIELDS = ["schema", "id", "intent_digest", "corpus_rows", "corpus_digest", "generated_at"] as const;
const CHANGE_FIELDS = ["path", "operation", "before_digest", "after_digest", "rationale"] as const;
const PROPOSAL_FIELDS = [
  "schema", "id", "intent", "corpus_rows", "corpus_digest", "target", "query",
  "scope", "window", "baseline", "policy", "outcome", "changes",
  "citation_contract_digest", "ratchet_contract_digest",
] as const;
const DECISION_FIELDS = [
  "schema", "id", "proposal_digest", "citation_decision_digest", "ratchet_decision_digest", "outcome", "rationale",
] as const;
const EDIT_AUTHORIZATION_FIELDS = [
  "schema", "id", "proposal_digest", "decision_digest", "authorized_paths", "authorized_at", "expires_at", "actor_id",
] as const;
const RELEASE_DESCRIPTOR_FIELDS = [
  "schema", "id", "runtime_release", "capability_digest", "contract_digests", "issued_at",
] as const;

export interface TuneTarget {
  kind: (typeof TUNE_TARGET_KINDS)[number];
  id: string;
  path?: string;
  digest: string;
}

export interface TuneQuery {
  outcome?: (typeof TUNE_CORPUS_OUTCOMES)[number];
  reason?: string;
  graph?: string;
  skill?: string;
  limit: number;
}

export interface TuneWindow {
  from: string;
  to: string;
  limit: number;
}

export interface TuneBaseline {
  base_ref: string;
  base_digest: string;
  runtime_release: string;
  capability_digest: string;
}

export interface TunePolicy {
  allow_edit_paths: string[];
  requires_citation_gate: boolean;
  requires_ratchet: boolean;
  max_changed_files: number;
}

export interface TuneTask {
  schema: typeof TUNE_TASK_SCHEMA;
  id: string;
  target: TuneTarget;
  query: TuneQuery;
  scope: (typeof TUNE_SCOPES)[number];
  window: TuneWindow;
  baseline: TuneBaseline;
  policy: TunePolicy;
}

export interface TuneSealedIntent {
  schema: typeof TUNE_SEALED_INTENT_SCHEMA;
  id: string;
  task: TuneTask;
  task_digest: string;
  sealed_at: string;
  authority_digest: string;
}

export interface TuneCorpusRow {
  id: string;
  pipeline_instance_id: string;
  generation: number;
  graph_id: string;
  outcome: (typeof TUNE_CORPUS_OUTCOMES)[number];
  reason: string;
  created_at: string;
  artifact_digests: string[];
  row_digest: string;
}

export interface TuneAnalysis {
  schema: typeof TUNE_ANALYSIS_SCHEMA;
  id: string;
  intent_digest: string;
  corpus_rows: TuneCorpusRow[];
  corpus_digest: string;
  generated_at: string;
}

export interface TuneProposalChange {
  path: string;
  operation: "add" | "modify" | "delete";
  before_digest: string | null;
  after_digest: string | null;
  rationale: string;
}

export interface TuneProposal {
  schema: typeof TUNE_PROPOSAL_SCHEMA;
  id: string;
  intent: TuneSealedIntent;
  corpus_rows: TuneCorpusRow[];
  corpus_digest: string;
  target: TuneTarget;
  query: TuneQuery;
  scope: (typeof TUNE_SCOPES)[number];
  window: TuneWindow;
  baseline: TuneBaseline;
  policy: TunePolicy;
  outcome: (typeof TUNE_PROPOSAL_OUTCOMES)[number];
  changes: TuneProposalChange[];
  citation_contract_digest: string;
  ratchet_contract_digest: string;
}

export interface TuneDecision {
  schema: typeof TUNE_DECISION_SCHEMA;
  id: string;
  proposal_digest: string;
  citation_decision_digest: string;
  ratchet_decision_digest: string;
  outcome: (typeof TUNE_DECISION_OUTCOMES)[number];
  rationale: string;
}

export interface TuneEditAuthorization {
  schema: typeof TUNE_EDIT_AUTHORIZATION_SCHEMA;
  id: string;
  proposal_digest: string;
  decision_digest: string;
  authorized_paths: string[];
  authorized_at: string;
  expires_at: string;
  actor_id: string;
}

export interface TuneReleaseDescriptor {
  schema: typeof TUNE_RELEASE_DESCRIPTOR_SCHEMA;
  id: string;
  runtime_release: string;
  capability_digest: string;
  contract_digests: string[];
  issued_at: string;
}

function timestamp(value: unknown, path: string): string {
  return stringAt(value, path, { max: 64, pattern: ISO_TIMESTAMP });
}

function parseDigestList(value: unknown, path: string, options: { min?: number; max: number }): string[] {
  return unique(arrayAt(value, path, (entry, entryPath) => {
    return stringAt(entry, entryPath, { pattern: SHA256 });
  }, options), path);
}

function parsePaths(value: unknown, path: string, options: { min?: number; max: number }): string[] {
  return unique(arrayAt(value, path, (entry, entryPath) => {
    return stringAt(entry, entryPath, { max: 240, pattern: PATH_PATTERN });
  }, options), path);
}

function parseTarget(value: unknown, path: string): TuneTarget {
  const input = objectAt(value, path, TARGET_FIELDS);
  return {
    kind: enumAt(input.kind, `${path}.kind`, TUNE_TARGET_KINDS),
    id: stringAt(input.id, `${path}.id`, { max: 160, pattern: IDENTIFIER }),
    ...optional(input.path, (entry) => ({ path: stringAt(entry, `${path}.path`, { max: 240, pattern: PATH_PATTERN }) })),
    digest: stringAt(input.digest, `${path}.digest`, { pattern: SHA256 }),
  };
}

function parseQuery(value: unknown, path: string): TuneQuery {
  const input = objectAt(value, path, QUERY_FIELDS);
  const query = {
    ...optional(input.outcome, (entry) => ({ outcome: enumAt(entry, `${path}.outcome`, TUNE_CORPUS_OUTCOMES) })),
    ...optional(input.reason, (entry) => ({ reason: stringAt(entry, `${path}.reason`, { max: 120, pattern: IDENTIFIER }) })),
    ...optional(input.graph, (entry) => ({ graph: stringAt(entry, `${path}.graph`, { max: 120, pattern: IDENTIFIER }) })),
    ...optional(input.skill, (entry) => ({ skill: stringAt(entry, `${path}.skill`, { max: 160 }) })),
    limit: integerAt(input.limit, `${path}.limit`, 1, 200),
  };
  if (!query.outcome && !query.reason && !query.graph && !query.skill) {
    fail(path, "must include at least one deterministic filter");
  }
  return query;
}

function parseWindow(value: unknown, path: string): TuneWindow {
  const input = objectAt(value, path, WINDOW_FIELDS);
  const window = {
    from: timestamp(input.from, `${path}.from`),
    to: timestamp(input.to, `${path}.to`),
    limit: integerAt(input.limit, `${path}.limit`, 1, 1_000),
  };
  if (window.from > window.to) fail(path, "from must not be later than to");
  return window;
}

function parseBaseline(value: unknown, path: string): TuneBaseline {
  const input = objectAt(value, path, BASELINE_FIELDS);
  return {
    base_ref: stringAt(input.base_ref, `${path}.base_ref`, { max: 160 }),
    base_digest: stringAt(input.base_digest, `${path}.base_digest`, { pattern: SHA256 }),
    runtime_release: stringAt(input.runtime_release, `${path}.runtime_release`, { max: 120 }),
    capability_digest: stringAt(input.capability_digest, `${path}.capability_digest`, { pattern: SHA256 }),
  };
}

function parsePolicy(value: unknown, path: string): TunePolicy {
  const input = objectAt(value, path, POLICY_FIELDS);
  return {
    allow_edit_paths: parsePaths(input.allow_edit_paths, `${path}.allow_edit_paths`, { min: 1, max: 64 }),
    requires_citation_gate: booleanAt(input.requires_citation_gate, `${path}.requires_citation_gate`),
    requires_ratchet: booleanAt(input.requires_ratchet, `${path}.requires_ratchet`),
    max_changed_files: integerAt(input.max_changed_files, `${path}.max_changed_files`, 0, 64),
  };
}

function parseTaskValue(value: unknown, source: string): TuneTask {
  const input = objectAt(value, source, TASK_FIELDS);
  if (input.schema !== TUNE_TASK_SCHEMA) fail(`${source}.schema`, `must be ${TUNE_TASK_SCHEMA}`);
  return {
    schema: TUNE_TASK_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
    target: parseTarget(input.target, `${source}.target`),
    query: parseQuery(input.query, `${source}.query`),
    scope: enumAt(input.scope, `${source}.scope`, TUNE_SCOPES),
    window: parseWindow(input.window, `${source}.window`),
    baseline: parseBaseline(input.baseline, `${source}.baseline`),
    policy: parsePolicy(input.policy, `${source}.policy`),
  };
}

function parseSealedIntentValue(value: unknown, source: string): TuneSealedIntent {
  const input = objectAt(value, source, SEALED_INTENT_FIELDS);
  if (input.schema !== TUNE_SEALED_INTENT_SCHEMA) fail(`${source}.schema`, `must be ${TUNE_SEALED_INTENT_SCHEMA}`);
  const task = parseTaskValue(input.task, `${source}.task`);
  const intent: TuneSealedIntent = {
    schema: TUNE_SEALED_INTENT_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
    task,
    task_digest: stringAt(input.task_digest, `${source}.task_digest`, { pattern: SHA256 }),
    sealed_at: timestamp(input.sealed_at, `${source}.sealed_at`),
    authority_digest: stringAt(input.authority_digest, `${source}.authority_digest`, { pattern: SHA256 }),
  };
  if (validateTuneTaskContract(task, { source: `${source}.task` }).digest !== intent.task_digest) {
    fail(`${source}.task_digest`, "does not match canonical task digest");
  }
  return intent;
}

function parseCorpusRow(value: unknown, path: string): TuneCorpusRow {
  const input = objectAt(value, path, CORPUS_ROW_FIELDS);
  return {
    id: stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER }),
    pipeline_instance_id: stringAt(input.pipeline_instance_id, `${path}.pipeline_instance_id`, { max: 160 }),
    generation: integerAt(input.generation, `${path}.generation`, 1, 1_000_000),
    graph_id: stringAt(input.graph_id, `${path}.graph_id`, { pattern: IDENTIFIER }),
    outcome: enumAt(input.outcome, `${path}.outcome`, TUNE_CORPUS_OUTCOMES),
    reason: stringAt(input.reason, `${path}.reason`, { max: 120, pattern: IDENTIFIER }),
    created_at: timestamp(input.created_at, `${path}.created_at`),
    artifact_digests: parseDigestList(input.artifact_digests, `${path}.artifact_digests`, { min: 1, max: 32 }),
    row_digest: stringAt(input.row_digest, `${path}.row_digest`, { pattern: SHA256 }),
  };
}

function parseChange(value: unknown, path: string): TuneProposalChange {
  const input = objectAt(value, path, CHANGE_FIELDS);
  return {
    path: stringAt(input.path, `${path}.path`, { max: 240, pattern: PATH_PATTERN }),
    operation: enumAt(input.operation, `${path}.operation`, ["add", "modify", "delete"] as const),
    before_digest: input.before_digest === null ? null : stringAt(input.before_digest, `${path}.before_digest`, { pattern: SHA256 }),
    after_digest: input.after_digest === null ? null : stringAt(input.after_digest, `${path}.after_digest`, { pattern: SHA256 }),
    rationale: stringAt(input.rationale, `${path}.rationale`, { max: 1_000 }),
  };
}

function assertProposalMatchesIntent(proposal: TuneProposal, source: string): void {
  const task = proposal.intent.task;
  if (JSON.stringify(proposal.target) !== JSON.stringify(task.target)) fail(`${source}.target`, "must match sealed intent target");
  if (JSON.stringify(proposal.query) !== JSON.stringify(task.query)) fail(`${source}.query`, "must match sealed intent query");
  if (proposal.scope !== task.scope) fail(`${source}.scope`, "must match sealed intent scope");
  if (JSON.stringify(proposal.window) !== JSON.stringify(task.window)) fail(`${source}.window`, "must match sealed intent window");
  if (JSON.stringify(proposal.baseline) !== JSON.stringify(task.baseline)) fail(`${source}.baseline`, "must match sealed intent baseline");
  if (JSON.stringify(proposal.policy) !== JSON.stringify(task.policy)) fail(`${source}.policy`, "must match sealed intent policy");
  if (proposal.changes.length > proposal.policy.max_changed_files) fail(`${source}.changes`, "exceeds policy max_changed_files");
  const allowed = proposal.policy.allow_edit_paths;
  for (const change of proposal.changes) {
    if (!allowed.some((prefix) => change.path === prefix || change.path.startsWith(`${prefix}/`))) {
      fail(`${source}.changes.${change.path}`, "is outside policy allow_edit_paths");
    }
  }
}

export function validateTuneTaskContract(value: unknown, options: { source?: string } = {}): ValidatedContract<TuneTask> {
  return normalizedContract(parseTaskValue(value, options.source ?? "tune_task"));
}

function parseBoundedJsonContract<T>(
  raw: string,
  options: { source?: string },
  defaultSource: string,
  maxKiB: number,
  validate: (value: unknown, options: { source?: string }) => ValidatedContract<T>
): ValidatedContract<T> {
  if (Buffer.byteLength(raw, "utf8") > maxKiB * 1024) fail(options.source ?? defaultSource, `JSON exceeds ${maxKiB} KiB`);
  return validate(JSON.parse(raw) as unknown, options);
}

export function parseTuneTaskContract(raw: string, options: { source?: string } = {}): ValidatedContract<TuneTask> {
  return parseBoundedJsonContract(raw, options, "tune_task", 64, validateTuneTaskContract);
}

export function validateTuneSealedIntentContract(value: unknown, options: { source?: string } = {}): ValidatedContract<TuneSealedIntent> {
  return normalizedContract(parseSealedIntentValue(value, options.source ?? "tune_intent"));
}

export function parseTuneSealedIntentContract(raw: string, options: { source?: string } = {}): ValidatedContract<TuneSealedIntent> {
  return parseBoundedJsonContract(raw, options, "tune_intent", 96, validateTuneSealedIntentContract);
}

export function validateTuneAnalysisContract(value: unknown, options: { source?: string } = {}): ValidatedContract<TuneAnalysis> {
  const source = options.source ?? "tune_analysis";
  const input = objectAt(value, source, ANALYSIS_FIELDS);
  if (input.schema !== TUNE_ANALYSIS_SCHEMA) fail(`${source}.schema`, `must be ${TUNE_ANALYSIS_SCHEMA}`);
  return normalizedContract({
    schema: TUNE_ANALYSIS_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
    intent_digest: stringAt(input.intent_digest, `${source}.intent_digest`, { pattern: SHA256 }),
    corpus_rows: arrayAt(input.corpus_rows, `${source}.corpus_rows`, parseCorpusRow, { max: 200 }),
    corpus_digest: stringAt(input.corpus_digest, `${source}.corpus_digest`, { pattern: SHA256 }),
    generated_at: timestamp(input.generated_at, `${source}.generated_at`),
  });
}

export function parseTuneAnalysisContract(raw: string, options: { source?: string } = {}): ValidatedContract<TuneAnalysis> {
  return parseBoundedJsonContract(raw, options, "tune_analysis", 128, validateTuneAnalysisContract);
}

export function validateTuneProposalContract(value: unknown, options: { source?: string } = {}): ValidatedContract<TuneProposal> {
  const source = options.source ?? "tune_proposal";
  const input = objectAt(value, source, PROPOSAL_FIELDS);
  if (input.schema !== TUNE_PROPOSAL_SCHEMA) fail(`${source}.schema`, `must be ${TUNE_PROPOSAL_SCHEMA}`);
  const proposal: TuneProposal = {
    schema: TUNE_PROPOSAL_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
    intent: parseSealedIntentValue(input.intent, `${source}.intent`),
    corpus_rows: arrayAt(input.corpus_rows, `${source}.corpus_rows`, parseCorpusRow, { max: 200 }),
    corpus_digest: stringAt(input.corpus_digest, `${source}.corpus_digest`, { pattern: SHA256 }),
    target: parseTarget(input.target, `${source}.target`),
    query: parseQuery(input.query, `${source}.query`),
    scope: enumAt(input.scope, `${source}.scope`, TUNE_SCOPES),
    window: parseWindow(input.window, `${source}.window`),
    baseline: parseBaseline(input.baseline, `${source}.baseline`),
    policy: parsePolicy(input.policy, `${source}.policy`),
    outcome: enumAt(input.outcome, `${source}.outcome`, TUNE_PROPOSAL_OUTCOMES),
    changes: arrayAt(input.changes, `${source}.changes`, parseChange, { max: 64 }),
    citation_contract_digest: stringAt(input.citation_contract_digest, `${source}.citation_contract_digest`, { pattern: SHA256 }),
    ratchet_contract_digest: stringAt(input.ratchet_contract_digest, `${source}.ratchet_contract_digest`, { pattern: SHA256 }),
  };
  assertProposalMatchesIntent(proposal, source);
  return normalizedContract(proposal);
}

export function parseTuneProposalContract(raw: string, options: { source?: string } = {}): ValidatedContract<TuneProposal> {
  return parseBoundedJsonContract(raw, options, "tune_proposal", 256, validateTuneProposalContract);
}

export function validateTuneDecisionContract(value: unknown, options: { source?: string } = {}): ValidatedContract<TuneDecision> {
  const source = options.source ?? "tune_decision";
  const input = objectAt(value, source, DECISION_FIELDS);
  if (input.schema !== TUNE_DECISION_SCHEMA) fail(`${source}.schema`, `must be ${TUNE_DECISION_SCHEMA}`);
  return normalizedContract({
    schema: TUNE_DECISION_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
    proposal_digest: stringAt(input.proposal_digest, `${source}.proposal_digest`, { pattern: SHA256 }),
    citation_decision_digest: stringAt(input.citation_decision_digest, `${source}.citation_decision_digest`, { pattern: SHA256 }),
    ratchet_decision_digest: stringAt(input.ratchet_decision_digest, `${source}.ratchet_decision_digest`, { pattern: SHA256 }),
    outcome: enumAt(input.outcome, `${source}.outcome`, TUNE_DECISION_OUTCOMES),
    rationale: stringAt(input.rationale, `${source}.rationale`, { max: 2_000 }),
  });
}

export function parseTuneDecisionContract(raw: string, options: { source?: string } = {}): ValidatedContract<TuneDecision> {
  return parseBoundedJsonContract(raw, options, "tune_decision", 32, validateTuneDecisionContract);
}

export function validateTuneEditAuthorizationContract(value: unknown, options: { source?: string } = {}): ValidatedContract<TuneEditAuthorization> {
  const source = options.source ?? "tune_edit_authorization";
  const input = objectAt(value, source, EDIT_AUTHORIZATION_FIELDS);
  if (input.schema !== TUNE_EDIT_AUTHORIZATION_SCHEMA) fail(`${source}.schema`, `must be ${TUNE_EDIT_AUTHORIZATION_SCHEMA}`);
  const authorization = {
    schema: TUNE_EDIT_AUTHORIZATION_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
    proposal_digest: stringAt(input.proposal_digest, `${source}.proposal_digest`, { pattern: SHA256 }),
    decision_digest: stringAt(input.decision_digest, `${source}.decision_digest`, { pattern: SHA256 }),
    authorized_paths: parsePaths(input.authorized_paths, `${source}.authorized_paths`, { min: 1, max: 64 }),
    authorized_at: timestamp(input.authorized_at, `${source}.authorized_at`),
    expires_at: timestamp(input.expires_at, `${source}.expires_at`),
    actor_id: stringAt(input.actor_id, `${source}.actor_id`, { max: 160, pattern: IDENTIFIER }),
  };
  if (authorization.authorized_at > authorization.expires_at) fail(source, "authorized_at must not be later than expires_at");
  return normalizedContract(authorization);
}

export function parseTuneEditAuthorizationContract(raw: string, options: { source?: string } = {}): ValidatedContract<TuneEditAuthorization> {
  return parseBoundedJsonContract(raw, options, "tune_edit_authorization", 32, validateTuneEditAuthorizationContract);
}

export function validateTuneReleaseDescriptorContract(value: unknown, options: { source?: string } = {}): ValidatedContract<TuneReleaseDescriptor> {
  const source = options.source ?? "tune_release_descriptor";
  const input = objectAt(value, source, RELEASE_DESCRIPTOR_FIELDS);
  if (input.schema !== TUNE_RELEASE_DESCRIPTOR_SCHEMA) fail(`${source}.schema`, `must be ${TUNE_RELEASE_DESCRIPTOR_SCHEMA}`);
  return normalizedContract({
    schema: TUNE_RELEASE_DESCRIPTOR_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
    runtime_release: stringAt(input.runtime_release, `${source}.runtime_release`, { max: 120 }),
    capability_digest: stringAt(input.capability_digest, `${source}.capability_digest`, { pattern: SHA256 }),
    contract_digests: parseDigestList(input.contract_digests, `${source}.contract_digests`, { min: 1, max: 32 }),
    issued_at: timestamp(input.issued_at, `${source}.issued_at`),
  });
}

export function parseTuneReleaseDescriptorContract(raw: string, options: { source?: string } = {}): ValidatedContract<TuneReleaseDescriptor> {
  return parseBoundedJsonContract(raw, options, "tune_release_descriptor", 32, validateTuneReleaseDescriptorContract);
}
