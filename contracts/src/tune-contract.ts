import { canonicalJson, digestCanonicalJson, digestNormalized } from "./canonical.js";
import {
  ANALYSIS_QUERY_ATTRIBUTIONS,
  ANALYSIS_QUERY_OUTCOMES,
  ANALYSIS_QUERY_REASONS,
  validateCitationContractProposal,
  type AnalysisRunResult,
  type CitationContractProposal,
} from "./citation-contract.js";
import {
  validateRatchetDecision,
  validateRatchetDifferentialInput,
  type RatchetDifferentialInput,
} from "./ratchet-contract.js";
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
export const TUNE_ANALYSIS_INPUT_SCHEMA = "openthrottle.tune-analysis-input/v1" as const;
export const TUNE_ANALYSIS_SCHEMA = "openthrottle.tune-analysis/v1" as const;
export const TUNE_PROPOSAL_SCHEMA = "openthrottle.tune-proposal/v1" as const;
export const TUNE_DECISION_SCHEMA = "openthrottle.tune-decision/v1" as const;
export const TUNE_EDIT_AUTHORIZATION_SCHEMA = "openthrottle.tune-edit-authorization/v1" as const;
export const TUNE_RELEASE_DESCRIPTOR_SCHEMA = "openthrottle.tune-release-descriptor/v1" as const;

export const TUNE_TARGET_KINDS = ["contract", "graph", "pipeline", "runtime", "skill"] as const;
export const TUNE_SCOPES = ["repository", "pipeline", "runtime"] as const;
export const TUNE_PROPOSAL_OUTCOMES = ["propose", "no_change", "needs_human"] as const;
export const TUNE_DECISION_OUTCOMES = ["accept", "reject", "needs_human"] as const;
export const TUNE_CORPUS_OUTCOMES = ANALYSIS_QUERY_OUTCOMES;

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
  "id", "pipeline_instance_id", "generation", "execution_graph_id", "outcome", "closed_reason",
  "fault_attribution", "created_at", "source_digests", "row_digest",
] as const;
const ANALYSIS_INPUT_FIELDS = ["schema", "id", "intent", "intent_digest", "corpus_rows", "corpus_digest"] as const;
const ANALYSIS_FIELDS = ["schema", "id", "intent", "intent_digest", "corpus_rows", "corpus_digest", "generated_at"] as const;
const CHANGE_FIELDS = ["path", "operation", "before_digest", "after_digest", "after_content", "rationale"] as const;
const TUNE_CHANGE_CONTENT_MAX_BYTES = 128 * 1024;
const TUNE_CHANGE_SET_CONTENT_MAX_BYTES = 192 * 1024;
const TUNE_CHANGE_SET_SERIALIZED_MAX_BYTES = 160 * 1024;
const PROPOSAL_FIELDS = [
  "schema", "id", "analysis", "analysis_digest", "target", "query",
  "scope", "window", "baseline", "policy", "outcome", "changes",
  "citation_contract", "ratchet_input",
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
  reason?: (typeof ANALYSIS_QUERY_REASONS)[number];
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

export interface TuneCorpusRowContent {
  id: string;
  pipeline_instance_id: string;
  generation: number;
  execution_graph_id: string | null;
  outcome: (typeof TUNE_CORPUS_OUTCOMES)[number];
  closed_reason: (typeof ANALYSIS_QUERY_REASONS)[number];
  fault_attribution: (typeof ANALYSIS_QUERY_ATTRIBUTIONS)[number] | null;
  created_at: string;
  source_digests: string[];
}

export interface TuneCorpusRow extends TuneCorpusRowContent {
  row_digest: string;
}

export interface TuneAnalysisInput {
  schema: typeof TUNE_ANALYSIS_INPUT_SCHEMA;
  id: string;
  intent: TuneSealedIntent;
  intent_digest: string;
  corpus_rows: TuneCorpusRow[];
  corpus_digest: string;
}

type TuneAnalysisMaterial = Omit<TuneAnalysisInput, "schema">;

export interface TuneAnalysis {
  schema: typeof TUNE_ANALYSIS_SCHEMA;
  id: string;
  intent: TuneSealedIntent;
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
  after_content: string | null;
  rationale: string;
}

export interface TuneProposal {
  schema: typeof TUNE_PROPOSAL_SCHEMA;
  id: string;
  analysis: TuneAnalysis;
  analysis_digest: string;
  target: TuneTarget;
  query: TuneQuery;
  scope: (typeof TUNE_SCOPES)[number];
  window: TuneWindow;
  baseline: TuneBaseline;
  policy: TunePolicy;
  outcome: (typeof TUNE_PROPOSAL_OUTCOMES)[number];
  changes: TuneProposalChange[];
  citation_contract: CitationContractProposal;
  ratchet_input: RatchetDifferentialInput;
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

export interface TuneDecisionValidationOptions {
  source?: string;
  proposal?: unknown;
  citationDecisionDigest?: string;
  ratchetDecision?: unknown;
}

export interface TuneEditAuthorizationValidationOptions {
  source?: string;
  proposal?: unknown;
  decision?: unknown;
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
    ...optional(input.reason, (entry) => ({ reason: enumAt(entry, `${path}.reason`, ANALYSIS_QUERY_REASONS) })),
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
  const policy = {
    allow_edit_paths: parsePaths(input.allow_edit_paths, `${path}.allow_edit_paths`, { min: 1, max: 64 }),
    requires_citation_gate: booleanAt(input.requires_citation_gate, `${path}.requires_citation_gate`),
    requires_ratchet: booleanAt(input.requires_ratchet, `${path}.requires_ratchet`),
    max_changed_files: integerAt(input.max_changed_files, `${path}.max_changed_files`, 0, 64),
  };
  if (!policy.requires_citation_gate) fail(`${path}.requires_citation_gate`, "must be true");
  if (!policy.requires_ratchet) fail(`${path}.requires_ratchet`, "must be true");
  return policy;
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

export function deriveTuneCorpusRowDigest(row: TuneCorpusRowContent): string {
  return digestCanonicalJson(row);
}

export function deriveTuneCorpusDigest(rows: readonly TuneCorpusRow[]): string {
  return digestCanonicalJson(rows);
}

function parseCorpusRow(value: unknown, path: string): TuneCorpusRow {
  const input = objectAt(value, path, CORPUS_ROW_FIELDS);
  const rowWithoutDigest = {
    id: stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER }),
    pipeline_instance_id: stringAt(input.pipeline_instance_id, `${path}.pipeline_instance_id`, { max: 160 }),
    generation: integerAt(input.generation, `${path}.generation`, 1, 1_000_000),
    execution_graph_id: input.execution_graph_id === null
      ? null
      : stringAt(input.execution_graph_id, `${path}.execution_graph_id`, { pattern: IDENTIFIER }),
    outcome: enumAt(input.outcome, `${path}.outcome`, TUNE_CORPUS_OUTCOMES),
    closed_reason: enumAt(input.closed_reason, `${path}.closed_reason`, ANALYSIS_QUERY_REASONS),
    fault_attribution: input.fault_attribution === null
      ? null
      : enumAt(input.fault_attribution, `${path}.fault_attribution`, ANALYSIS_QUERY_ATTRIBUTIONS),
    created_at: timestamp(input.created_at, `${path}.created_at`),
    source_digests: parseDigestList(input.source_digests, `${path}.source_digests`, { min: 1, max: 32 }),
  };
  const row: TuneCorpusRow = {
    ...rowWithoutDigest,
    row_digest: stringAt(input.row_digest, `${path}.row_digest`, { pattern: SHA256 }),
  };
  if (deriveTuneCorpusRowDigest(rowWithoutDigest) !== row.row_digest) {
    fail(`${path}.row_digest`, "does not match canonical row digest");
  }
  return row;
}

function analysisRunResult(row: TuneCorpusRow): AnalysisRunResult {
  return {
    pipeline_instance_id: row.pipeline_instance_id,
    generation: row.generation,
    execution_graph_id: row.execution_graph_id,
    outcome: row.outcome,
    closed_reason: row.closed_reason,
    fault_attribution: row.fault_attribution,
    created_at: row.created_at,
  };
}

function assertAnalysisMaterial(input: TuneAnalysisMaterial, source: string): void {
  if (digestCanonicalJson(input.intent) !== input.intent_digest) {
    fail(`${source}.intent_digest`, "does not match canonical sealed intent digest");
  }
  if (deriveTuneCorpusDigest(input.corpus_rows) !== input.corpus_digest) {
    fail(`${source}.corpus_digest`, "does not match canonical corpus digest");
  }
  const maximumRows = Math.min(input.intent.task.query.limit, input.intent.task.window.limit);
  if (input.corpus_rows.length > maximumRows) {
    fail(`${source}.corpus_rows`, "exceeds sealed intent query/window limit");
  }
  if (new Set(input.corpus_rows.map((row) => row.id)).size !== input.corpus_rows.length) {
    fail(`${source}.corpus_rows`, "must not contain duplicate ids");
  }
  const runKeys = input.corpus_rows.map((row) => `${row.pipeline_instance_id}:${row.generation}`);
  if (new Set(runKeys).size !== runKeys.length) {
    fail(`${source}.corpus_rows`, "must not contain duplicate pipeline generation rows");
  }
  for (let index = 0; index < input.corpus_rows.length; index += 1) {
    const row = input.corpus_rows[index]!;
    if (row.created_at < input.intent.task.window.from || row.created_at > input.intent.task.window.to) {
      fail(`${source}.corpus_rows[${index}].created_at`, "is outside the sealed intent window");
    }
    const query = input.intent.task.query;
    if (query.outcome !== undefined && row.outcome !== query.outcome) {
      fail(`${source}.corpus_rows[${index}].outcome`, "does not match sealed intent query");
    }
    if (query.reason !== undefined && row.closed_reason !== query.reason) {
      fail(`${source}.corpus_rows[${index}].closed_reason`, "does not match sealed intent query");
    }
    if (query.graph !== undefined && row.execution_graph_id !== query.graph) {
      fail(`${source}.corpus_rows[${index}].execution_graph_id`, "does not match sealed intent query");
    }
  }
}

function parseAnalysisInputValue(value: unknown, source: string): TuneAnalysisInput {
  const input = objectAt(value, source, ANALYSIS_INPUT_FIELDS);
  if (input.schema !== TUNE_ANALYSIS_INPUT_SCHEMA) fail(`${source}.schema`, `must be ${TUNE_ANALYSIS_INPUT_SCHEMA}`);
  const intent = parseSealedIntentValue(input.intent, `${source}.intent`);
  const analysisInput: TuneAnalysisInput = {
    schema: TUNE_ANALYSIS_INPUT_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
    intent,
    intent_digest: stringAt(input.intent_digest, `${source}.intent_digest`, { pattern: SHA256 }),
    corpus_rows: arrayAt(input.corpus_rows, `${source}.corpus_rows`, parseCorpusRow, { max: 200 }),
    corpus_digest: stringAt(input.corpus_digest, `${source}.corpus_digest`, { pattern: SHA256 }),
  };
  assertAnalysisMaterial(analysisInput, source);
  return analysisInput;
}

function parseChange(value: unknown, path: string): TuneProposalChange {
  const input = objectAt(value, path, CHANGE_FIELDS);
  const change: TuneProposalChange = {
    path: stringAt(input.path, `${path}.path`, { max: 240, pattern: PATH_PATTERN }),
    operation: enumAt(input.operation, `${path}.operation`, ["add", "modify", "delete"] as const),
    before_digest: input.before_digest === null ? null : stringAt(input.before_digest, `${path}.before_digest`, { pattern: SHA256 }),
    after_digest: input.after_digest === null ? null : stringAt(input.after_digest, `${path}.after_digest`, { pattern: SHA256 }),
    after_content: input.after_content === null
      ? null
      : stringAt(input.after_content, `${path}.after_content`, { max: TUNE_CHANGE_CONTENT_MAX_BYTES }),
    rationale: stringAt(input.rationale, `${path}.rationale`, { max: 1_000 }),
  };
  if (change.after_content !== null && Buffer.byteLength(change.after_content, "utf8") > TUNE_CHANGE_CONTENT_MAX_BYTES) {
    fail(`${path}.after_content`, `must contain at most ${TUNE_CHANGE_CONTENT_MAX_BYTES} UTF-8 bytes`);
  }
  if (change.operation === "add" && (change.before_digest !== null || change.after_digest === null || change.after_content === null)) {
    fail(path, "add requires null before_digest and non-null after_digest and after_content");
  }
  if (change.operation === "modify" && (change.before_digest === null || change.after_digest === null || change.after_content === null)) {
    fail(path, "modify requires non-null before_digest, after_digest, and after_content");
  }
  if (change.operation === "delete" && (change.before_digest === null || change.after_digest !== null || change.after_content !== null)) {
    fail(path, "delete requires a non-null before_digest and null after_digest and after_content");
  }
  if (change.before_digest !== null && change.before_digest === change.after_digest) {
    fail(path, "before_digest and after_digest must differ");
  }
  if (change.after_content !== null && digestNormalized(change.after_content) !== change.after_digest) {
    fail(`${path}.after_content`, "does not match after_digest");
  }
  return change;
}

function assertProposalMatchesIntent(proposal: TuneProposal, source: string): void {
  const task = proposal.analysis.intent.task;
  if (canonicalJson(proposal.target) !== canonicalJson(task.target)) fail(`${source}.target`, "must match sealed intent target");
  if (canonicalJson(proposal.query) !== canonicalJson(task.query)) fail(`${source}.query`, "must match sealed intent query");
  if (proposal.scope !== task.scope) fail(`${source}.scope`, "must match sealed intent scope");
  if (canonicalJson(proposal.window) !== canonicalJson(task.window)) fail(`${source}.window`, "must match sealed intent window");
  if (canonicalJson(proposal.baseline) !== canonicalJson(task.baseline)) fail(`${source}.baseline`, "must match sealed intent baseline");
  if (canonicalJson(proposal.policy) !== canonicalJson(task.policy)) fail(`${source}.policy`, "must match sealed intent policy");
  if (proposal.changes.length > proposal.policy.max_changed_files) fail(`${source}.changes`, "exceeds policy max_changed_files");
  const contentBytes = proposal.changes.reduce(
    (sum, change) => sum + (change.after_content === null ? 0 : Buffer.byteLength(change.after_content, "utf8")),
    0
  );
  if (contentBytes > TUNE_CHANGE_SET_CONTENT_MAX_BYTES) {
    fail(`${source}.changes`, `after_content must contain at most ${TUNE_CHANGE_SET_CONTENT_MAX_BYTES} UTF-8 bytes in total`);
  }
  if (Buffer.byteLength(canonicalJson(proposal.changes), "utf8") > TUNE_CHANGE_SET_SERIALIZED_MAX_BYTES) {
    fail(`${source}.changes`, `canonical JSON must contain at most ${TUNE_CHANGE_SET_SERIALIZED_MAX_BYTES} UTF-8 bytes`);
  }
  const allowed = proposal.policy.allow_edit_paths;
  for (const change of proposal.changes) {
    if (!allowed.some((prefix) => change.path === prefix || change.path.startsWith(`${prefix}/`))) {
      fail(`${source}.changes.${change.path}`, "is outside policy allow_edit_paths");
    }
  }
}

function assertProposalEvidenceBindings(proposal: TuneProposal, source: string, citationDigest: string): void {
  if (proposal.citation_contract.id !== proposal.id) {
    fail(`${source}.citation_contract.id`, "must match tune proposal id");
  }
  if (proposal.ratchet_input.id !== proposal.id) {
    fail(`${source}.ratchet_input.id`, "must match tune proposal id");
  }

  if (proposal.ratchet_input.tuner_authority?.proposal_digest !== citationDigest) {
    fail(
      `${source}.ratchet_input.tuner_authority.proposal_digest`,
      "must match the canonical citation contract digest"
    );
  }

  const sealedRowsByResult = new Map<string, Set<string>>();
  for (const row of proposal.analysis.corpus_rows) {
    const key = canonicalJson(analysisRunResult(row));
    const sources = sealedRowsByResult.get(key) ?? new Set<string>();
    for (const digest of row.source_digests) sources.add(digest);
    sealedRowsByResult.set(key, sources);
  }
  for (let citationIndex = 0; citationIndex < proposal.citation_contract.citations.length; citationIndex += 1) {
    const citation = proposal.citation_contract.citations[citationIndex]!;
    const citationSources = new Set<string>();
    for (let resultIndex = 0; resultIndex < citation.expected_result.length; resultIndex += 1) {
      const sealedSources = sealedRowsByResult.get(canonicalJson(citation.expected_result[resultIndex]));
      if (sealedSources === undefined) {
        fail(
          `${source}.citation_contract.citations[${citationIndex}].expected_result[${resultIndex}]`,
          "is not present in the sealed analysis corpus"
        );
      }
      for (const digest of sealedSources) citationSources.add(digest);
    }
    for (let digestIndex = 0; digestIndex < citation.source_digests.length; digestIndex += 1) {
      if (!citationSources.has(citation.source_digests[digestIndex]!)) {
        fail(
          `${source}.citation_contract.citations[${citationIndex}].source_digests`,
          "is not present in the sealed analysis corpus"
        );
      }
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

export function validateTuneAnalysisInputContract(value: unknown, options: { source?: string } = {}): ValidatedContract<TuneAnalysisInput> {
  return normalizedContract(parseAnalysisInputValue(value, options.source ?? "tune_analysis_input"));
}

export function parseTuneAnalysisInputContract(raw: string, options: { source?: string } = {}): ValidatedContract<TuneAnalysisInput> {
  return parseBoundedJsonContract(raw, options, "tune_analysis_input", 256, validateTuneAnalysisInputContract);
}

export function validateTuneAnalysisContract(value: unknown, options: { source?: string } = {}): ValidatedContract<TuneAnalysis> {
  const source = options.source ?? "tune_analysis";
  const input = objectAt(value, source, ANALYSIS_FIELDS);
  if (input.schema !== TUNE_ANALYSIS_SCHEMA) fail(`${source}.schema`, `must be ${TUNE_ANALYSIS_SCHEMA}`);
  const intent = parseSealedIntentValue(input.intent, `${source}.intent`);
  const analysis: TuneAnalysis = {
    schema: TUNE_ANALYSIS_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
    intent,
    intent_digest: stringAt(input.intent_digest, `${source}.intent_digest`, { pattern: SHA256 }),
    corpus_rows: arrayAt(input.corpus_rows, `${source}.corpus_rows`, parseCorpusRow, { max: 200 }),
    corpus_digest: stringAt(input.corpus_digest, `${source}.corpus_digest`, { pattern: SHA256 }),
    generated_at: timestamp(input.generated_at, `${source}.generated_at`),
  };
  assertAnalysisMaterial({
    id: analysis.id,
    intent: analysis.intent,
    intent_digest: analysis.intent_digest,
    corpus_rows: analysis.corpus_rows,
    corpus_digest: analysis.corpus_digest,
  }, source);
  return normalizedContract(analysis);
}

export function parseTuneAnalysisContract(raw: string, options: { source?: string } = {}): ValidatedContract<TuneAnalysis> {
  return parseBoundedJsonContract(raw, options, "tune_analysis", 256, validateTuneAnalysisContract);
}

export function validateTuneProposalContract(value: unknown, options: { source?: string } = {}): ValidatedContract<TuneProposal> {
  const source = options.source ?? "tune_proposal";
  const input = objectAt(value, source, PROPOSAL_FIELDS);
  if (input.schema !== TUNE_PROPOSAL_SCHEMA) fail(`${source}.schema`, `must be ${TUNE_PROPOSAL_SCHEMA}`);
  const analysis = validateTuneAnalysisContract(input.analysis, { source: `${source}.analysis` });
  const citationContract = validateCitationContractProposal(input.citation_contract, {
    source: `${source}.citation_contract`,
  });
  const proposal: TuneProposal = {
    schema: TUNE_PROPOSAL_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
    analysis: analysis.value,
    analysis_digest: stringAt(input.analysis_digest, `${source}.analysis_digest`, { pattern: SHA256 }),
    target: parseTarget(input.target, `${source}.target`),
    query: parseQuery(input.query, `${source}.query`),
    scope: enumAt(input.scope, `${source}.scope`, TUNE_SCOPES),
    window: parseWindow(input.window, `${source}.window`),
    baseline: parseBaseline(input.baseline, `${source}.baseline`),
    policy: parsePolicy(input.policy, `${source}.policy`),
    outcome: enumAt(input.outcome, `${source}.outcome`, TUNE_PROPOSAL_OUTCOMES),
    changes: arrayAt(input.changes, `${source}.changes`, parseChange, { max: 64 }),
    citation_contract: citationContract.value,
    ratchet_input: validateRatchetDifferentialInput(input.ratchet_input, {
      source: `${source}.ratchet_input`,
    }).value,
  };
  if (analysis.digest !== proposal.analysis_digest) {
    fail(`${source}.analysis_digest`, "does not match canonical tune analysis digest");
  }
  if (proposal.outcome === "propose" && proposal.changes.length === 0) {
    fail(`${source}.changes`, "must contain at least one change when outcome is propose");
  }
  if (proposal.outcome !== "propose" && proposal.changes.length !== 0) {
    fail(`${source}.changes`, "must be empty unless outcome is propose");
  }
  if (new Set(proposal.changes.map((change) => change.path)).size !== proposal.changes.length) {
    fail(`${source}.changes`, "must not contain duplicate paths");
  }
  assertProposalMatchesIntent(proposal, source);
  assertProposalEvidenceBindings(proposal, source, citationContract.digest);
  return normalizedContract(proposal);
}

export function parseTuneProposalContract(raw: string, options: { source?: string } = {}): ValidatedContract<TuneProposal> {
  return parseBoundedJsonContract(raw, options, "tune_proposal", 640, validateTuneProposalContract);
}

export function validateTuneDecisionContract(
  value: unknown,
  options: TuneDecisionValidationOptions = {}
): ValidatedContract<TuneDecision> {
  const source = options.source ?? "tune_decision";
  const input = objectAt(value, source, DECISION_FIELDS);
  if (input.schema !== TUNE_DECISION_SCHEMA) fail(`${source}.schema`, `must be ${TUNE_DECISION_SCHEMA}`);
  const decision: TuneDecision = {
    schema: TUNE_DECISION_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
    proposal_digest: stringAt(input.proposal_digest, `${source}.proposal_digest`, { pattern: SHA256 }),
    citation_decision_digest: stringAt(input.citation_decision_digest, `${source}.citation_decision_digest`, { pattern: SHA256 }),
    ratchet_decision_digest: stringAt(input.ratchet_decision_digest, `${source}.ratchet_decision_digest`, { pattern: SHA256 }),
    outcome: enumAt(input.outcome, `${source}.outcome`, TUNE_DECISION_OUTCOMES),
    rationale: stringAt(input.rationale, `${source}.rationale`, { max: 2_000 }),
  };
  let proposal: TuneProposal | undefined;
  if (options.proposal !== undefined) {
    const validatedProposal = validateTuneProposalContract(options.proposal, { source: `${source}.proposal` });
    proposal = validatedProposal.value;
    if (decision.proposal_digest !== validatedProposal.digest) {
      fail(`${source}.proposal_digest`, "does not match canonical tune proposal digest");
    }
    if (decision.outcome === "accept" && proposal.outcome !== "propose") {
      fail(`${source}.outcome`, "cannot accept a proposal without proposed changes");
    }
  }
  if (options.citationDecisionDigest !== undefined) {
    const expected = stringAt(options.citationDecisionDigest, `${source}.expected_citation_decision_digest`, {
      pattern: SHA256,
    });
    if (decision.citation_decision_digest !== expected) {
      fail(`${source}.citation_decision_digest`, "does not match supervisor citation decision digest");
    }
  }
  if (options.ratchetDecision !== undefined) {
    const validatedRatchetDecision = validateRatchetDecision(options.ratchetDecision, {
      source: `${source}.ratchet_decision`,
    });
    if (decision.ratchet_decision_digest !== validatedRatchetDecision.digest) {
      fail(`${source}.ratchet_decision_digest`, "does not match canonical ratchet decision digest");
    }
    if (proposal !== undefined) {
      const ratchetInputDigest = validateRatchetDifferentialInput(proposal.ratchet_input, {
        source: `${source}.proposal.ratchet_input`,
      }).digest;
      if (validatedRatchetDecision.value.input_digest !== ratchetInputDigest) {
        fail(`${source}.ratchet_decision_digest`, "ratchet decision does not bind the proposal ratchet input");
      }
    }
    if (decision.outcome === "accept" && validatedRatchetDecision.value.outcome !== "accept") {
      fail(`${source}.outcome`, "cannot accept when the ratchet decision rejects");
    }
  }
  return normalizedContract(decision);
}

export function parseTuneDecisionContract(
  raw: string,
  options: TuneDecisionValidationOptions = {}
): ValidatedContract<TuneDecision> {
  return parseBoundedJsonContract(raw, options, "tune_decision", 32, validateTuneDecisionContract);
}

export function validateTuneEditAuthorizationContract(
  value: unknown,
  options: TuneEditAuthorizationValidationOptions = {}
): ValidatedContract<TuneEditAuthorization> {
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
  let proposal: ValidatedContract<TuneProposal> | undefined;
  if (options.proposal !== undefined) {
    proposal = validateTuneProposalContract(options.proposal, { source: `${source}.proposal` });
    if (authorization.proposal_digest !== proposal.digest) {
      fail(`${source}.proposal_digest`, "does not match canonical tune proposal digest");
    }
    if (proposal.value.outcome !== "propose") {
      fail(`${source}.proposal_digest`, "must reference a proposal with proposed changes");
    }
    const proposedPaths = proposal.value.changes.map((change) => change.path).sort();
    const authorizedPaths = [...authorization.authorized_paths].sort();
    if (canonicalJson(proposedPaths) !== canonicalJson(authorizedPaths)) {
      fail(`${source}.authorized_paths`, "must exactly match the accepted proposal change paths");
    }
  }
  if (options.decision !== undefined) {
    const decision = validateTuneDecisionContract(options.decision, {
      source: `${source}.decision`,
      ...(proposal === undefined ? {} : { proposal: proposal.value }),
    });
    if (authorization.decision_digest !== decision.digest) {
      fail(`${source}.decision_digest`, "does not match canonical tune decision digest");
    }
    if (authorization.proposal_digest !== decision.value.proposal_digest) {
      fail(`${source}.proposal_digest`, "does not match the tune decision proposal digest");
    }
    if (decision.value.outcome !== "accept") {
      fail(`${source}.decision_digest`, "must reference an accepted tune decision");
    }
  }
  return normalizedContract(authorization);
}

export function parseTuneEditAuthorizationContract(
  raw: string,
  options: TuneEditAuthorizationValidationOptions = {}
): ValidatedContract<TuneEditAuthorization> {
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
