import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { canonicalJson } from "@openthrottle/contracts";

export interface TuneStateRecord {
  id: string;
  intent_id: string;
  intent_digest: string;
  proposal_id: string;
  proposal_digest: string;
  citation_decision_digest: string;
  ratchet_decision_digest: string;
  edit_authorization_digest: string;
  release_descriptor_digest: string;
  outcome: "accepted" | "rejected" | "needs_human";
  payload: string;
  payload_digest: string;
  created_at: string;
}

export interface TuneStateInput {
  id: string;
  intentId: string;
  intentDigest: string;
  proposalId: string;
  proposalDigest: string;
  citationDecisionDigest: string;
  ratchetDecisionDigest: string;
  editAuthorizationDigest: string;
  releaseDescriptorDigest: string;
  outcome: TuneStateRecord["outcome"];
  payload: unknown;
}

export interface TuneStore {
  recordTuneState(input: TuneStateInput): TuneStateRecord;
  getTuneStateByProposal(proposalDigest: string): TuneStateRecord | undefined;
  listTuneStateByIntent(intentDigest: string, limit?: number): TuneStateRecord[];
}

function digestPayload(payload: unknown): { normalized: string; digest: string } {
  const normalized = canonicalJson(payload);
  return {
    normalized,
    digest: createHash("sha256").update(normalized).digest("hex"),
  };
}

export function createTuneStore(db: Database.Database, now: () => string = () => new Date().toISOString()): TuneStore {
  function getTuneStateByProposal(proposalDigest: string): TuneStateRecord | undefined {
    return db.prepare("SELECT * FROM tune_state WHERE proposal_digest = ?")
      .get(proposalDigest) as TuneStateRecord | undefined;
  }

  return {
    getTuneStateByProposal,
    listTuneStateByIntent(intentDigest, limit = 50) {
      const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
      return db.prepare(`
        SELECT * FROM tune_state
        WHERE intent_digest = ?
        ORDER BY created_at, id
        LIMIT ?
      `).all(intentDigest, boundedLimit) as TuneStateRecord[];
    },
    recordTuneState(input) {
      const payload = digestPayload(input.payload);
      const existing = getTuneStateByProposal(input.proposalDigest);
      if (existing) {
        if (
          existing.id !== input.id ||
          existing.intent_id !== input.intentId ||
          existing.intent_digest !== input.intentDigest ||
          existing.proposal_id !== input.proposalId ||
          existing.citation_decision_digest !== input.citationDecisionDigest ||
          existing.ratchet_decision_digest !== input.ratchetDecisionDigest ||
          existing.edit_authorization_digest !== input.editAuthorizationDigest ||
          existing.release_descriptor_digest !== input.releaseDescriptorDigest ||
          existing.outcome !== input.outcome ||
          existing.payload !== payload.normalized ||
          existing.payload_digest !== payload.digest
        ) {
          throw new Error(`tune state replay mismatch for proposal ${input.proposalId}`);
        }
        return existing;
      }

      db.prepare(`
        INSERT INTO tune_state (
          id, intent_id, intent_digest, proposal_id, proposal_digest,
          citation_decision_digest, ratchet_decision_digest, edit_authorization_digest,
          release_descriptor_digest, outcome, payload, payload_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.intentId,
        input.intentDigest,
        input.proposalId,
        input.proposalDigest,
        input.citationDecisionDigest,
        input.ratchetDecisionDigest,
        input.editAuthorizationDigest,
        input.releaseDescriptorDigest,
        input.outcome,
        payload.normalized,
        payload.digest,
        now()
      );
      return getTuneStateByProposal(input.proposalDigest)!;
    },
  };
}
