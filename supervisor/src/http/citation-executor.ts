import {
  parseCitationContractProposal,
  type AnalysisRunQuery,
  type AnalysisRunResult,
  type CitationContractProposal,
} from "@openthrottle/contracts";
import type { RunOutcome } from "../pipeline/store.js";
import {
  CITATION_GRADE_SCHEMA,
  evaluateCitationGate,
  gradeCitationContractProposal,
  type CitationGateDecision,
  type CitationGrade,
  type ResolvedCitation,
} from "../pipeline/citation-gate.js";
import type { AnalysisStore, AnalysisRunOutcomeQuery } from "../persistence/pipeline/analysis-store.js";
import type { CitationGateStore, CitationGateReceipt } from "../persistence/pipeline/citation-gate-store.js";

export { CITATION_GRADE_SCHEMA };

export interface CitationGateExecution {
  proposal: CitationContractProposal;
  grade: CitationGrade;
  decision: CitationGateDecision;
  receipt: CitationGateReceipt;
}

function analysisQueryFor(query: AnalysisRunQuery): AnalysisRunOutcomeQuery {
  return {
    outcome: query.outcome,
    reason: query.reason,
    attribution: query.attribution,
    graph: query.graph,
    skillDigest: query.skill_digest,
    from: query.from,
    to: query.to,
    limit: query.limit,
  };
}

function comparableRunOutcome(row: RunOutcome): AnalysisRunResult {
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

function resolveCitations(
  proposal: CitationContractProposal,
  analysisStore: AnalysisStore
): ResolvedCitation[] {
  return proposal.citations.map((citation) => ({
    id: citation.id,
    actual_result: analysisStore.listRunOutcomes(analysisQueryFor(citation.query)).map(comparableRunOutcome),
  }));
}

export function executeRawCitationGate(input: {
  raw: unknown;
  analysisStore: AnalysisStore;
  citationGateStore: CitationGateStore;
}): CitationGateExecution {
  const proposalContract = parseCitationContractProposal(JSON.stringify(input.raw), { source: "citation_contract" });
  const proposal = proposalContract.value;
  const resolvedCitations = resolveCitations(proposal, input.analysisStore);
  const grade = gradeCitationContractProposal(proposal, resolvedCitations);
  const decision = evaluateCitationGate({
    proposal,
    proposalHash: proposalContract.digest,
    resolvedCitations,
  });
  return {
    proposal,
    grade,
    decision,
    receipt: input.citationGateStore.recordCitationGateDecision(decision),
  };
}
