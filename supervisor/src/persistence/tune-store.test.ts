import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./database.js";
import { createTuneStore, type TuneStateInput } from "./tune-store.js";

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function tuneState(overrides: Partial<TuneStateInput> = {}): TuneStateInput {
  return {
    id: "tune-state-one",
    intentId: "intent-one",
    intentDigest: "a".repeat(64),
    proposalId: "proposal-one",
    proposalDigest: "b".repeat(64),
    citationDecisionDigest: "c".repeat(64),
    ratchetDecisionDigest: "d".repeat(64),
    editAuthorizationDigest: "e".repeat(64),
    releaseDescriptorDigest: "f".repeat(64),
    outcome: "accepted",
    payload: {
      proposal: "proposal-one",
      evidence: ["citation", "ratchet"],
    },
    ...overrides,
  };
}

describe("tune store", () => {
  it("records append-only tune evidence and returns the same row on exact replay", () => {
    db = openDb(":memory:");
    const store = createTuneStore(db, () => "2026-08-12T00:00:00.000Z");

    const first = store.recordTuneState(tuneState());
    const second = store.recordTuneState({
      ...tuneState(),
      payload: {
        evidence: ["citation", "ratchet"],
        proposal: "proposal-one",
      },
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      id: "tune-state-one",
      intent_digest: "a".repeat(64),
      proposal_digest: "b".repeat(64),
      payload: '{"evidence":["citation","ratchet"],"proposal":"proposal-one"}',
      created_at: "2026-08-12T00:00:00.000Z",
    });
  });

  it("rejects a conflicting replay for the same proposal digest", () => {
    db = openDb(":memory:");
    const store = createTuneStore(db, () => "2026-08-12T00:00:00.000Z");
    store.recordTuneState(tuneState());

    expect(() => store.recordTuneState(tuneState({
      outcome: "rejected",
      ratchetDecisionDigest: "1".repeat(64),
    }))).toThrow(/tune state replay mismatch/);
  });

  it("lists tune state by sealed intent with a bounded limit", () => {
    db = openDb(":memory:");
    const store = createTuneStore(db, () => "2026-08-12T00:00:00.000Z");
    store.recordTuneState(tuneState({ id: "first", proposalDigest: "1".repeat(64) }));
    store.recordTuneState(tuneState({ id: "second", proposalDigest: "2".repeat(64) }));

    expect(store.listTuneStateByIntent("a".repeat(64), 1).map((row) => row.id)).toEqual(["first"]);
    expect(store.listTuneStateByIntent("not-present")).toEqual([]);
  });
});
