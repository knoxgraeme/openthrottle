import type Database from "better-sqlite3";
import type { CitationGateDecision, CitationGateReason } from "../../pipeline/citation-gate.js";
import { deterministicId } from "./helpers.js";

export interface CitationGateReceipt {
  id: string;
  proposal_id: string;
  proposal_hash: string;
  gate_result: "passed" | "failed";
  outcome: string;
  reason: CitationGateReason;
  grade_hash: string;
  payload: string;
  receipt_hash: string;
  created_at: string;
}

export interface CitationGateStore {
  recordCitationGateDecision(decision: CitationGateDecision): CitationGateReceipt;
  getCitationGateReceipt(proposalHash: string): CitationGateReceipt | undefined;
}

export function createCitationGateStore(db: Database.Database, now: () => string): CitationGateStore {
  function getCitationGateReceipt(proposalHash: string): CitationGateReceipt | undefined {
    return db.prepare(`
      SELECT * FROM citation_gate_receipts WHERE proposal_hash = ?
    `).get(proposalHash) as CitationGateReceipt | undefined;
  }

  return {
    getCitationGateReceipt,
    recordCitationGateDecision(decision) {
      const existing = getCitationGateReceipt(decision.proposal_hash);
      if (existing) {
        if (
          existing.proposal_id !== decision.proposal_id ||
          existing.gate_result !== decision.result ||
          existing.outcome !== decision.outcome ||
          existing.reason !== decision.reason ||
          existing.grade_hash !== decision.grade_hash ||
          existing.payload !== decision.payload ||
          existing.receipt_hash !== decision.hash
        ) {
          throw new Error(
            `citation gate replay mismatch for proposal ${decision.proposal_id}: ` +
            `existing reason ${existing.reason}, new reason ${decision.reason}`
          );
        }
        return existing;
      }

      const timestamp = now();
      const id = deterministicId("citation-gate", [decision.proposal_hash, decision.hash]);
      db.prepare(`
        INSERT INTO citation_gate_receipts (
          id, proposal_id, proposal_hash, gate_result, outcome, reason,
          grade_hash, payload, receipt_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        decision.proposal_id,
        decision.proposal_hash,
        decision.result,
        decision.outcome,
        decision.reason,
        decision.grade_hash,
        decision.payload,
        decision.hash,
        timestamp
      );
      return getCitationGateReceipt(decision.proposal_hash)!;
    },
  };
}
