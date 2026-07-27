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

  function seedTicket(issueId = "issue-1", identifier = "OT-1"): void {
    db!.prepare(`
      INSERT INTO tickets (
        linear_issue_id, linear_issue_identifier, linear_session_id,
        sandbox_id, branch, agent, repo, pr_url, state, base_branch, created_at, updated_at
      ) VALUES (?, ?, 'session-1', NULL, 'ot/ot-1', 'codex', 'owner/repo', NULL, 'active', 'main', ?, ?)
    `).run(issueId, identifier, "2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z");
  }

  function registerRepository(teamKey: string, updatedAt: string): void {
    db!.prepare(`
      INSERT INTO repository_registrations (
        linear_team_key, linear_team_id, github_repo, base_branch,
        webhook_id, snapshot, created_at, updated_at
      ) VALUES (?, ?, 'owner/repo', 'main', ?, '{}', ?, ?)
    `).run(teamKey, `team-${teamKey}`, teamKey.length, "2026-07-27T00:00:00.000Z", updatedAt);
  }

  it("preserves the issue team when multiple teams share a repository", () => {
    db = openDb(":memory:");
    seedTicket("issue-1", "OT-1");
    registerRepository("OT", "2026-07-27T00:00:00.000Z");
    registerRepository("QA", "2026-07-27T01:00:00.000Z");

    const journal = createJournalStore(db, () => "2026-07-27T02:00:00.000Z");
    journal.recordJournalEntry({
      id: "team-row",
      issueId: "issue-1",
      actor: "supervisor",
      kind: "delegated",
      trigger: "test",
      action: "Delegated the ticket.",
      refs: {},
    });

    expect(journal.listJournalEntries({ issueId: "issue-1" })[0]).toMatchObject({
      team: "OT",
      repository: "owner/repo",
      issue: "OT-1",
    });
  });

  it("normalizes offset timestamp filters before comparing recorded_at values", () => {
    db = openDb(":memory:");
    seedTicket();
    registerRepository("OT", "2026-07-27T00:00:00.000Z");

    const journal = createJournalStore(db, () => "2026-07-27T00:00:00.000Z");
    journal.recordJournalEntry({
      id: "timestamp-row",
      issueId: "issue-1",
      actor: "supervisor",
      kind: "published",
      trigger: "test",
      action: "Published the branch.",
      refs: {},
    });

    expect(journal.listJournalEntries({
      issueId: "issue-1",
      from: "2026-07-27T01:00:00+02:00",
    })).toHaveLength(1);
    expect(journal.listJournalEntries({
      issueId: "issue-1",
      to: "2026-07-27T01:00:00+02:00",
    })).toHaveLength(0);
  });
});
