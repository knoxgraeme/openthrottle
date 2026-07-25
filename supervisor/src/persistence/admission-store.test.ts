import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./database.js";
import { createSupervisorStore, type SupervisorStore } from "./store.js";

describe("admission store", () => {
  let db: ReturnType<typeof openDb>;
  let store: SupervisorStore;

  beforeEach(() => {
    db = openDb(":memory:");
    store = createSupervisorStore(db);
    store.upsertUnpinned({
      linear_issue_id: "issue-1",
      linear_issue_identifier: "OT-1",
      linear_session_id: "session-1",
      sandbox_id: null,
      branch: "ot/ot-1",
      agent: "codex",
      repo: "owner/repo",
      base_branch: "main",
      pr_url: null,
      state: "active",
    });
  });

  afterEach(() => db.close());

  it("does not create the removed session-work projection", () => {
    expect(db.prepare(
      "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'session_work'"
    ).pluck().get()).toBe(0);
    expect(store.getCurrentSession("issue-1")).toMatchObject({
      id: "session-1",
      generation: 1,
      state: "current",
    });
  });

  it("routes only through durable repository registrations", () => {
    store.registerRepository({
      linearTeamKey: "ENG",
      linearTeamId: "team-1",
      githubRepo: "acme/widget",
      baseBranch: "develop",
      webhookId: 42,
      snapshot: "openthrottle",
    });
    expect(store.getRepositoryRegistration(undefined, "eng")).toMatchObject({
      github_repo: "acme/widget",
      base_branch: "develop",
    });
    expect(store.getRepositoryRegistration("team-1", "OTHER")?.linear_team_key).toBe("ENG");
    expect(store.getRepositoryRegistration(undefined, "missing")).toBeUndefined();
  });

  it("supersedes session generations without carrying actor state forward", () => {
    store.upsertUnpinned({
      ...store.getByIssueId("issue-1")!,
      linear_session_id: "session-2",
      sandbox_id: null,
    });
    expect(store.getSession("session-1")?.state).toBe("superseded");
    expect(store.getCurrentSession("issue-1")).toMatchObject({
      id: "session-2",
      generation: 2,
      state: "current",
    });
  });
});
