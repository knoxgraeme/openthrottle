import {
  IDENTIFIER,
  SHA256,
  arrayAt,
  enumAt,
  fail,
  integerAt,
  normalizedContract,
  objectAt,
  optional,
  parseIdentifierList,
  stringAt,
  timestampAt,
  unique,
  type ValidatedContract,
} from "./validation.js";

const CITATION_CONTRACT_SCHEMA = "openthrottle.citation-contract/v1" as const;

export const ANALYSIS_QUERY_OUTCOMES = ["shipped", "no_change", "needs_human", "canceled", "superseded", "failed"] as const;
export const ANALYSIS_QUERY_REASONS = [
  "success",
  "no_change",
  "semantic_repair_required",
  "failure",
  "needs_human",
  "retryable_infrastructure_failure",
  "canceled",
  "superseded",
] as const;
export const ANALYSIS_QUERY_ATTRIBUTIONS = ["executor", "agent", "provider", "unknown"] as const;
const CLAIM_DISPOSITIONS = ["supported", "contradicted", "insufficient", "not_applicable"] as const;
const GRADE_VALUES = ["pass", "pass_with_concerns", "fail", "not_applicable"] as const;

const ANALYSIS_RUN_QUERY_FIELDS = [
  "outcome", "reason", "attribution", "graph", "skill_digest", "from", "to", "limit",
] as const;
const ANALYSIS_RUN_RESULT_FIELDS = [
  "pipeline_instance_id", "generation", "execution_graph_id", "outcome", "closed_reason",
  "fault_attribution", "created_at",
] as const;
const CITATION_CONTRACT_FIELDS = ["schema", "id", "summary", "claims", "citations", "dispositions", "grades"] as const;

export interface AnalysisRunQuery {
  outcome?: (typeof ANALYSIS_QUERY_OUTCOMES)[number];
  reason?: (typeof ANALYSIS_QUERY_REASONS)[number];
  attribution?: (typeof ANALYSIS_QUERY_ATTRIBUTIONS)[number];
  graph?: string;
  skill_digest?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface AnalysisRunResult {
  pipeline_instance_id: string;
  generation: number;
  execution_graph_id: string | null;
  outcome: (typeof ANALYSIS_QUERY_OUTCOMES)[number];
  closed_reason: (typeof ANALYSIS_QUERY_REASONS)[number];
  fault_attribution: (typeof ANALYSIS_QUERY_ATTRIBUTIONS)[number] | null;
  created_at: string;
}

interface CitationContractCitation {
  id: string;
  query: AnalysisRunQuery;
  expected_result: AnalysisRunResult[];
  source_digests: string[];
}

interface CitationContractClaim {
  id: string;
  text: string;
  citation_ids: string[];
}

interface CitationContractDisposition {
  claim_id: string;
  disposition: (typeof CLAIM_DISPOSITIONS)[number];
  rationale: string;
  citation_ids: string[];
}

interface CitationContractGrade {
  id: string;
  value: (typeof GRADE_VALUES)[number];
  disposition_claim_ids: string[];
  rationale: string;
}

export interface CitationContractProposal {
  schema: typeof CITATION_CONTRACT_SCHEMA;
  id: string;
  summary: string;
  claims: CitationContractClaim[];
  citations: CitationContractCitation[];
  dispositions: CitationContractDisposition[];
  grades: CitationContractGrade[];
}

function parseAnalysisRunQuery(value: unknown, path: string): AnalysisRunQuery {
  const input = objectAt(value, path, ANALYSIS_RUN_QUERY_FIELDS);
  if (Object.keys(input).length === 0) fail(path, "must include at least one allowlisted filter");
  const query: AnalysisRunQuery = {
    ...optional(input.outcome, (entry) => ({ outcome: enumAt(entry, `${path}.outcome`, ANALYSIS_QUERY_OUTCOMES) })),
    ...optional(input.reason, (entry) => ({ reason: enumAt(entry, `${path}.reason`, ANALYSIS_QUERY_REASONS) })),
    ...optional(input.attribution, (entry) => ({
      attribution: enumAt(entry, `${path}.attribution`, ANALYSIS_QUERY_ATTRIBUTIONS),
    })),
    ...optional(input.graph, (entry) => ({ graph: stringAt(entry, `${path}.graph`, { pattern: IDENTIFIER }) })),
    ...optional(input.skill_digest, (entry) => ({
      skill_digest: stringAt(entry, `${path}.skill_digest`, { max: 320 }),
    })),
    ...optional(input.from, (entry) => ({ from: timestampAt(entry, `${path}.from`) })),
    ...optional(input.to, (entry) => ({ to: timestampAt(entry, `${path}.to`) })),
    ...optional(input.limit, (entry) => ({ limit: integerAt(entry, `${path}.limit`, 1, 200) })),
  };
  if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
    fail(path, "from must not be later than to");
  }
  return query;
}

function parseAnalysisRunResult(value: unknown, path: string): AnalysisRunResult {
  const input = objectAt(value, path, ANALYSIS_RUN_RESULT_FIELDS);
  return {
    pipeline_instance_id: stringAt(input.pipeline_instance_id, `${path}.pipeline_instance_id`, { max: 160 }),
    generation: integerAt(input.generation, `${path}.generation`, 1, 1_000_000),
    execution_graph_id: input.execution_graph_id === null
      ? null
      : stringAt(input.execution_graph_id, `${path}.execution_graph_id`, { pattern: IDENTIFIER }),
    outcome: enumAt(input.outcome, `${path}.outcome`, ANALYSIS_QUERY_OUTCOMES),
    closed_reason: enumAt(input.closed_reason, `${path}.closed_reason`, ANALYSIS_QUERY_REASONS),
    fault_attribution: input.fault_attribution === null
      ? null
      : enumAt(input.fault_attribution, `${path}.fault_attribution`, ANALYSIS_QUERY_ATTRIBUTIONS),
    created_at: timestampAt(input.created_at, `${path}.created_at`),
  };
}

function parseCitation(value: unknown, path: string): CitationContractCitation {
  const input = objectAt(value, path, ["id", "query", "expected_result", "source_digests"]);
  return {
    id: stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER }),
    query: parseAnalysisRunQuery(input.query, `${path}.query`),
    expected_result: arrayAt(input.expected_result, `${path}.expected_result`, parseAnalysisRunResult, { max: 200 }),
    source_digests: unique(arrayAt(input.source_digests, `${path}.source_digests`, (entry, entryPath) => {
      return stringAt(entry, entryPath, { pattern: SHA256 });
    }, { min: 1, max: 32 }), `${path}.source_digests`),
  };
}

function parseClaim(value: unknown, path: string): CitationContractClaim {
  const input = objectAt(value, path, ["id", "text", "citation_ids"]);
  return {
    id: stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER }),
    text: stringAt(input.text, `${path}.text`, { max: 2_000 }),
    citation_ids: parseIdentifierList(input.citation_ids, `${path}.citation_ids`, { min: 1, max: 32 }),
  };
}

function parseDisposition(value: unknown, path: string): CitationContractDisposition {
  const input = objectAt(value, path, ["claim_id", "disposition", "rationale", "citation_ids"]);
  return {
    claim_id: stringAt(input.claim_id, `${path}.claim_id`, { pattern: IDENTIFIER }),
    disposition: enumAt(input.disposition, `${path}.disposition`, CLAIM_DISPOSITIONS),
    rationale: stringAt(input.rationale, `${path}.rationale`, { max: 2_000 }),
    citation_ids: parseIdentifierList(input.citation_ids, `${path}.citation_ids`, { min: 1, max: 32 }),
  };
}

function parseGrade(value: unknown, path: string): CitationContractGrade {
  const input = objectAt(value, path, ["id", "value", "disposition_claim_ids", "rationale"]);
  return {
    id: stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER }),
    value: enumAt(input.value, `${path}.value`, GRADE_VALUES),
    disposition_claim_ids: parseIdentifierList(input.disposition_claim_ids, `${path}.disposition_claim_ids`, { min: 1, max: 64 }),
    rationale: stringAt(input.rationale, `${path}.rationale`, { max: 2_000 }),
  };
}


function validateReferences(proposal: CitationContractProposal, source: string): void {
  const citationIds = new Set(proposal.citations.map((citation) => citation.id));
  if (citationIds.size !== proposal.citations.length) fail(`${source}.citations`, "must not contain duplicate IDs");

  const claimIds = new Set(proposal.claims.map((claim) => claim.id));
  if (claimIds.size !== proposal.claims.length) fail(`${source}.claims`, "must not contain duplicate IDs");

  const dispositionClaimIds = new Set<string>();
  const referencedCitationIds = new Set<string>();
  for (const claim of proposal.claims) {
    for (const citationId of claim.citation_ids) {
      if (!citationIds.has(citationId)) fail(`${source}.claims.${claim.id}.citation_ids`, "references an unknown citation");
      referencedCitationIds.add(citationId);
    }
  }
  for (const disposition of proposal.dispositions) {
    if (!claimIds.has(disposition.claim_id)) fail(`${source}.dispositions.${disposition.claim_id}`, "references an unknown claim");
    if (dispositionClaimIds.has(disposition.claim_id)) fail(`${source}.dispositions`, "must not contain duplicate claim IDs");
    dispositionClaimIds.add(disposition.claim_id);
    for (const citationId of disposition.citation_ids) {
      if (!citationIds.has(citationId)) fail(`${source}.dispositions.${disposition.claim_id}.citation_ids`, "references an unknown citation");
      referencedCitationIds.add(citationId);
    }
  }
  for (const citation of proposal.citations) {
    if (!referencedCitationIds.has(citation.id)) {
      fail(`${source}.citations.${citation.id}`, "must be referenced by a claim or disposition");
    }
  }
  for (const claimId of claimIds) {
    if (!dispositionClaimIds.has(claimId)) fail(`${source}.dispositions`, "must include every claim");
  }
  const gradeIds = new Set(proposal.grades.map((grade) => grade.id));
  if (gradeIds.size !== proposal.grades.length) fail(`${source}.grades`, "must not contain duplicate IDs");

  const gradedDispositionClaimIds = new Set<string>();
  for (const grade of proposal.grades) {
    for (const claimId of grade.disposition_claim_ids) {
      if (!dispositionClaimIds.has(claimId)) {
        fail(`${source}.grades.${grade.id}.disposition_claim_ids`, "references an unknown claim disposition");
      }
      gradedDispositionClaimIds.add(claimId);
    }
  }
  for (const claimId of dispositionClaimIds) {
    if (!gradedDispositionClaimIds.has(claimId)) fail(`${source}.grades`, "must include every claim disposition");
  }
}

export function validateCitationContractProposal(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<CitationContractProposal> {
  const source = options.source ?? "citation_contract";
  const input = objectAt(value, source, CITATION_CONTRACT_FIELDS);
  if (input.schema !== CITATION_CONTRACT_SCHEMA) fail(`${source}.schema`, `must be ${CITATION_CONTRACT_SCHEMA}`);
  const proposal: CitationContractProposal = {
    schema: CITATION_CONTRACT_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
    summary: stringAt(input.summary, `${source}.summary`, { max: 4_000 }),
    claims: arrayAt(input.claims, `${source}.claims`, parseClaim, { min: 1, max: 128 }),
    citations: arrayAt(input.citations, `${source}.citations`, parseCitation, { min: 1, max: 128 }),
    dispositions: arrayAt(input.dispositions, `${source}.dispositions`, parseDisposition, { min: 1, max: 128 }),
    grades: arrayAt(input.grades, `${source}.grades`, parseGrade, { min: 1, max: 32 }),
  };
  validateReferences(proposal, source);
  return normalizedContract(proposal);
}

export function parseCitationContractProposal(
  raw: string,
  options: { source?: string } = {}
): ValidatedContract<CitationContractProposal> {
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) fail(options.source ?? "citation_contract", "JSON exceeds 256 KiB");
  return validateCitationContractProposal(JSON.parse(raw) as unknown, options);
}
