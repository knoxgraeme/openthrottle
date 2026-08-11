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
      ticket_id: "issue-1",
      ticket_reference: "OT-1",
      session_id: "session-1",
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

  it("fails closed when a human ticket reference is ambiguous across providers", () => {
    store.upsertUnpinned({
      ticket_id: "github:issue-1",
      ticket_reference: "OT-1",
      session_id: "github-session-1",
      control_provider: "github",
      external_thread_id: "1",
      external_thread_reference: "OT-1",
      sandbox_id: null,
      branch: "ot/github-ot-1",
      agent: "codex",
      repo: "owner/repo",
      base_branch: "main",
      pr_url: null,
      state: "active",
    });

    expect(store.getByIdentifier("OT-1")).toBeUndefined();
    expect(store.getByIssueId("issue-1")?.control_provider).toBe("linear");
    expect(store.getByIssueId("github:issue-1")?.control_provider).toBe("github");
  });

  it("keys repository registrations by repo and rejects different-provider authority transfer", () => {
    store.registerRepository({
      linearTeamKey: "ENG",
      linearTeamId: "team-1",
      githubRepo: "acme/widget",
      baseBranch: "develop",
      webhookId: 42,
      snapshot: "openthrottle",
    });

    expect(() =>
      store.registerRepository({
        controlProvider: "github",
        githubRepo: "ACME/WIDGET",
        baseBranch: "main",
        webhookId: 43,
        snapshot: "openthrottle",
      })
    ).toThrow(/already registered for linear control/);
    expect(store.getRepositoryRegistration("team-1", undefined, "github")).toBeUndefined();
  });

  it("rejects moving a Linear route to another repository", () => {
    store.registerRepository({
      linearTeamKey: "ENG",
      linearTeamId: "team-1",
      githubRepo: "acme/widget",
      baseBranch: "develop",
      webhookId: 42,
      snapshot: "openthrottle",
    });

    expect(() =>
      store.registerRepository({
        linearTeamKey: "ENG",
        linearTeamId: "team-1",
        githubRepo: "acme/other",
        baseBranch: "main",
        webhookId: 43,
        snapshot: "openthrottle",
      })
    ).toThrow(/refusing to transfer authority/);
  });

  it("supersedes session generations without carrying actor state forward", () => {
    store.upsertUnpinned({
      ...store.getByIssueId("issue-1")!,
      session_id: "session-2",
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
