import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../database.js";
import { createJournalStore } from "./journal-store.js";

describe("orchestration journal store", () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function seedTicket(
    issueId = "linear:issue-1",
    identifier = "OT-1",
    sessionId = "session-1",
    provider: "linear" | "github" = "linear"
  ): void {
    db!.prepare(`
      INSERT INTO tickets (
        ticket_id, ticket_reference, session_id, control_provider,
        sandbox_id, branch, agent, repo, pr_url, state, base_branch, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, 'ot/ot-1', 'codex', 'owner/repo', NULL, 'active', 'main', ?, ?)
    `).run(
      issueId,
      identifier,
      sessionId,
      provider,
      "2026-07-27T00:00:00.000Z",
      "2026-07-27T00:00:00.000Z"
    );
  }

  function registerRepository(teamKey: string, updatedAt: string): void {
    db!.prepare(`
      INSERT INTO repository_registrations (
        linear_team_key, linear_team_id, github_repo, base_branch,
        webhook_id, snapshot, created_at, updated_at
      ) VALUES (?, ?, 'owner/repo', 'main', ?, '{}', ?, ?)
    `).run(teamKey, `team-${teamKey}`, teamKey.length, "2026-07-27T00:00:00.000Z", updatedAt);
  }

  it("prefers the issue team over the repository route fallback", () => {
    db = openDb(":memory:");
    seedTicket("linear:issue-1", "OT-1");
    registerRepository("QA", "2026-07-27T01:00:00.000Z");

    const journal = createJournalStore(db, () => "2026-07-27T02:00:00.000Z");
    journal.recordJournalEntry({
      id: "team-row",
      issueId: "linear:issue-1",
      actor: "supervisor",
      kind: "delegated",
      trigger: "test",
      action: "Delegated the ticket.",
      refs: {},
    });

    expect(journal.listJournalEntries({ issueId: "linear:issue-1" })[0]).toMatchObject({
      team: "OT",
      repository: "owner/repo",
      issue: "linear:issue-1",
    });
  });

  it("keeps journal identity provider-qualified when display references collide", () => {
    db = openDb(":memory:");
    seedTicket("linear:issue-1", "OT-1", "linear-session");
    seedTicket("github:issue-1", "OT-1", "github-session", "github");
    registerRepository("OT", "2026-07-27T00:00:00.000Z");

    const journal = createJournalStore(db, () => "2026-07-27T02:00:00.000Z");
    for (const [id, issueId] of [
      ["00000000-0000-4000-8000-000000000001", "linear:issue-1"],
      ["00000000-0000-4000-8000-000000000002", "github:issue-1"],
    ] as const) {
      journal.recordJournalEntry({
        id,
        issueId,
        actor: "supervisor",
        kind: "delegated",
        trigger: "test",
        action: `Delegated ${issueId}.`,
        refs: {},
      });
    }

    expect(journal.listJournalEntries({ issueId: "linear:issue-1" }).map((entry) => entry.id))
      .toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(journal.listJournalEntries({ issueId: "github:issue-1" }).map((entry) => entry.id))
      .toEqual(["00000000-0000-4000-8000-000000000002"]);
    expect(db.prepare("SELECT id, issue FROM orchestration_journal ORDER BY id").all()).toEqual([
      { id: "00000000-0000-4000-8000-000000000001", issue: "linear:issue-1" },
      { id: "00000000-0000-4000-8000-000000000002", issue: "github:issue-1" },
    ]);
  });

  it("normalizes offset timestamp filters before comparing recorded_at values", () => {
    db = openDb(":memory:");
    seedTicket();
    registerRepository("OT", "2026-07-27T00:00:00.000Z");

    const journal = createJournalStore(db, () => "2026-07-27T00:00:00.000Z");
    journal.recordJournalEntry({
      id: "timestamp-row",
      issueId: "linear:issue-1",
      actor: "supervisor",
      kind: "published",
      trigger: "test",
      action: "Published the branch.",
      refs: {},
    });

    expect(journal.listJournalEntries({
      issueId: "linear:issue-1",
      from: "2026-07-27T01:00:00+02:00",
    })).toHaveLength(1);
    expect(journal.listJournalEntries({
      issueId: "linear:issue-1",
      to: "2026-07-27T01:00:00+02:00",
    })).toHaveLength(0);

    // The ISO-8601 basic offset form (no colon) is just as unambiguous as the
    // extended form above and Date.parse itself already accepts it -- a
    // stricter shape check must not reject it (PR #158 review).
    expect(journal.listJournalEntries({
      issueId: "linear:issue-1",
      from: "2026-07-27T01:00:00+0200",
    })).toHaveLength(1);
    expect(journal.listJournalEntries({
      issueId: "linear:issue-1",
      to: "2026-07-27T01:00:00+0200",
    })).toHaveLength(0);
  });

  it("rejects a value Date.parse would loosely accept but that is not ISO-8601 shaped", () => {
    // Date.parse's non-standard fallback parser accepts both of these
    // (`0` -> epoch, `08/08/2026` -> a valid local date), so relying on
    // Date.parse alone would silently query an unintended time range instead
    // of failing closed (backported from analysis-store.ts, PR #156
    // follow-up review).
    db = openDb(":memory:");
    seedTicket();
    registerRepository("OT", "2026-07-27T00:00:00.000Z");
    const journal = createJournalStore(db, () => "2026-07-27T00:00:00.000Z");

    expect(() => journal.listJournalEntries({ issueId: "linear:issue-1", from: "0" }))
      .toThrow(/from must be an ISO-8601 timestamp/);
    expect(() => journal.listJournalEntries({ issueId: "linear:issue-1", from: "08/08/2026" }))
      .toThrow(/from must be an ISO-8601 timestamp/);
    expect(() => journal.listJournalEntries({ issueId: "linear:issue-1", to: "2026-08-08" }))
      .toThrow(/to must be an ISO-8601 timestamp/);
  });

  it("rejects a non-safe-integer limit instead of silently falling back to the default", () => {
    // Every other filter on this endpoint fails closed on a malformed value;
    // `Number("abc")`/`Number("Infinity")`/`Number("1.5")` all reach here as
    // a non-safe-integer number, and previously fell back to the 200-row
    // default silently instead (PR #156 follow-up review).
    db = openDb(":memory:");
    seedTicket();
    registerRepository("OT", "2026-07-27T00:00:00.000Z");
    const journal = createJournalStore(db, () => "2026-07-27T00:00:00.000Z");

    expect(() => journal.listJournalEntries({ issueId: "linear:issue-1", limit: Number.NaN }))
      .toThrow(/limit must be a safe integer/);
    expect(() => journal.listJournalEntries({ issueId: "linear:issue-1", limit: Number.POSITIVE_INFINITY }))
      .toThrow(/limit must be a safe integer/);
    expect(() => journal.listJournalEntries({ issueId: "linear:issue-1", limit: 1.5 }))
      .toThrow(/limit must be a safe integer/);
  });

  it("can retrieve the newest bounded journal window deterministically", () => {
    db = openDb(":memory:");
    seedTicket();
    registerRepository("OT", "2026-07-27T00:00:00.000Z");
    let recordedAt = "2026-07-27T00:00:00.000Z";
    const journal = createJournalStore(db, () => recordedAt);
    for (const [id, at] of [
      ["00000000-0000-4000-8000-000000000001", "2026-07-27T00:00:01.000Z"],
      ["00000000-0000-4000-8000-000000000002", "2026-07-27T00:00:02.000Z"],
      ["00000000-0000-4000-8000-000000000003", "2026-07-27T00:00:03.000Z"],
    ] as const) {
      recordedAt = at;
      journal.recordJournalEntry({
        id,
        issueId: "linear:issue-1",
        actor: "supervisor",
        kind: "run_note",
        trigger: "ordering",
        action: id,
        refs: {},
      });
    }

    expect(journal.listJournalEntries({ issueId: "linear:issue-1", order: "newest", limit: 2 }).map((entry) => entry.id))
      .toEqual([
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000002",
      ]);
  });
});
