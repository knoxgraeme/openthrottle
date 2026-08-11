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

  it("persists the provider activation timestamp as the session generation fence", () => {
    store.upsertUnpinned({
      ticket_id: "github:owner/repo#1",
      ticket_reference: "GH-1",
      session_id: "github:owner/repo#1:initial",
      control_provider: "github",
      external_thread_id: "owner/repo#1",
      external_thread_reference: "GH-1",
      provider_activated_at: "2026-08-11T00:00:00Z",
      sandbox_id: null,
      branch: "ot/gh-1",
      agent: "codex",
      repo: "owner/repo",
      base_branch: "main",
      pr_url: null,
      state: "active",
    });

    expect(store.getCurrentSession("github:owner/repo#1")).toMatchObject({
      id: "github:owner/repo#1:initial",
      provider_activated_at: "2026-08-11T00:00:00Z",
    });

    // A duplicate delivery for the same deterministic session must not move
    // the generation fence forward and make already-authorized comments stale.
    store.upsertUnpinned({
      ticket_id: "github:owner/repo#1",
      ticket_reference: "GH-1",
      session_id: "github:owner/repo#1:initial",
      control_provider: "github",
      external_thread_id: "owner/repo#1",
      external_thread_reference: "GH-1",
      provider_activated_at: "2026-08-11T00:00:05Z",
      sandbox_id: null,
      branch: "ot/gh-1",
      agent: "codex",
      repo: "owner/repo",
      base_branch: "main",
      pr_url: null,
      state: "active",
    });
    expect(store.getCurrentSession("github:owner/repo#1")?.provider_activated_at)
      .toBe("2026-08-11T00:00:00Z");
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

  it("switches future repository routing without changing active ticket and session pins", () => {
    store.registerRepository({
      linearTeamKey: "ENG",
      linearTeamId: "team-1",
      githubRepo: "owner/repo",
      baseBranch: "develop",
      webhookId: 42,
      snapshot: "openthrottle",
    });

    expect(store.registerRepository({
      controlProvider: "github",
      githubRepo: "OWNER/REPO",
      baseBranch: "main",
      webhookId: 43,
      snapshot: "openthrottle-github",
    })).toMatchObject({
      github_repo: "owner/repo",
      control_provider: "github",
      linear_team_key: null,
      linear_team_id: null,
      base_branch: "main",
      webhook_id: 43,
      snapshot: "openthrottle-github",
    });

    expect(store.getByIssueId("issue-1")).toMatchObject({
      control_provider: "linear",
      session_id: "session-1",
    });
    expect(store.getCurrentSession("issue-1")).toMatchObject({
      id: "session-1",
      generation: 1,
      state: "current",
    });
    expect(store.getRepositoryRegistration("team-1", undefined, "github")).toBeUndefined();

    store.upsertUnpinned({
      ticket_id: "github:owner/repo:2",
      ticket_reference: "owner/repo#2",
      session_id: "github-session-2",
      control_provider: "github",
      external_thread_id: "2",
      external_thread_reference: "owner/repo#2",
      sandbox_id: null,
      branch: "ot/github-2",
      agent: "codex",
      repo: "owner/repo",
      base_branch: "main",
      pr_url: null,
      state: "active",
    });
    expect(store.registerRepository({
      controlProvider: "linear",
      linearTeamKey: "ENG",
      linearTeamId: "team-1",
      githubRepo: "owner/repo",
      baseBranch: "release",
      webhookId: 44,
      snapshot: "openthrottle-linear",
    })).toMatchObject({
      github_repo: "owner/repo",
      control_provider: "linear",
      linear_team_key: "ENG",
      linear_team_id: "team-1",
      base_branch: "release",
    });
    expect(store.getByIssueId("issue-1")).toMatchObject({
      control_provider: "linear",
      session_id: "session-1",
    });
    expect(store.getCurrentSession("issue-1")?.generation).toBe(1);
    expect(store.getByIssueId("github:owner/repo:2")).toMatchObject({
      control_provider: "github",
      session_id: "github-session-2",
    });
    expect(store.getCurrentSession("github:owner/repo:2")).toMatchObject({
      id: "github-session-2",
      generation: 1,
      state: "current",
    });
  });

  it("resolves GitHub-control repository registrations by provider route repository", () => {
    store.registerRepository({
      controlProvider: "github",
      githubRepo: "acme/widget",
      baseBranch: "main",
      webhookId: 43,
      snapshot: "openthrottle",
    });

    expect(store.getRepositoryRegistration(undefined, "ACME/WIDGET", "github")).toMatchObject({
      control_provider: "github",
      github_repo: "acme/widget",
      base_branch: "main",
    });
    expect(store.getRepositoryRegistration(undefined, "ACME/WIDGET", "linear")).toBeUndefined();
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

  it("leaves an existing GitHub route intact when a Linear authority switch is rejected", () => {
    store.registerRepository({
      linearTeamKey: "ENG",
      linearTeamId: "team-1",
      githubRepo: "acme/linear",
      baseBranch: "main",
      webhookId: 42,
      snapshot: "openthrottle",
    });
    store.registerRepository({
      controlProvider: "github",
      githubRepo: "acme/widget",
      baseBranch: "main",
      webhookId: 43,
      snapshot: "openthrottle-github",
    });

    expect(() =>
      store.registerRepository({
        controlProvider: "linear",
        linearTeamKey: "ENG",
        linearTeamId: "team-1",
        githubRepo: "acme/widget",
        baseBranch: "develop",
        webhookId: 44,
        snapshot: "openthrottle-linear",
      })
    ).toThrow(/refusing to transfer authority/);
    expect(store.getRepositoryRegistration(undefined, "acme/widget", "github")).toMatchObject({
      control_provider: "github",
      base_branch: "main",
      webhook_id: 43,
      snapshot: "openthrottle-github",
    });
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
