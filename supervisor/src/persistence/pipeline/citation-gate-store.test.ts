import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../database.js";
import { createCitationGateStore } from "./citation-gate-store.js";
import type { CitationGateDecision } from "../../pipeline/citation-gate.js";

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function decision(overrides: Partial<CitationGateDecision> = {}): CitationGateDecision {
  const base: CitationGateDecision = {
    schema: "openthrottle.citation-gate/v1",
    proposal_id: "proposal_one",
    proposal_hash: "a".repeat(64),
    result: "passed",
    outcome: "success",
    reason: "all_citations_reproduced",
    surviving_claim_ids: ["claim_one"],
    dropped_claim_ids: [],
    grade_hash: "b".repeat(64),
    source_digests: ["c".repeat(64)],
    payload: JSON.stringify({ schema: "openthrottle.citation-gate/v1", proposal_id: "proposal_one" }),
    hash: "d".repeat(64),
  };
  return { ...base, ...overrides };
}

describe("citation gate store", () => {
  it("persists a durable receipt and returns the same row on exact replay", () => {
    db = openDb(":memory:");
    const store = createCitationGateStore(db, () => "2026-08-08T00:00:00.000Z");
    const first = store.recordCitationGateDecision(decision());
    const second = store.recordCitationGateDecision(decision());

    expect(second).toEqual(first);
    expect(store.getCitationGateReceipt("a".repeat(64))).toMatchObject({
      proposal_id: "proposal_one",
      gate_result: "passed",
      reason: "all_citations_reproduced",
      receipt_hash: "d".repeat(64),
    });
  });

  it("rejects a conflicting replay for the same proposal hash", () => {
    db = openDb(":memory:");
    const store = createCitationGateStore(db, () => "2026-08-08T00:00:00.000Z");
    store.recordCitationGateDecision(decision());

    expect(() => store.recordCitationGateDecision(decision({
      reason: "stale_evidence",
      result: "failed",
      outcome: "failure",
      grade_hash: "e".repeat(64),
      hash: "f".repeat(64),
    }))).toThrow(/citation gate replay mismatch/);
  });
});
