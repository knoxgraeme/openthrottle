import { describe, expect, it } from "vitest";
import {
  beginGithubSupervisorCommentWrite,
  githubSupervisorCommentWriteIsPending,
  settleGithubSupervisorCommentWrite,
} from "./comment-provenance.js";

describe("GitHub supervisor comment provenance", () => {
  function settings() {
    const values = new Map<string, string>();
    const leases = new Map<string, { owner: string; leaseUntil: string }>();
    return {
      acquireSupervisorLease: (
        name: string,
        owner: string,
        nowIso: string,
        leaseUntilIso: string
      ) => {
        const existing = leases.get(name);
        if (existing && existing.owner !== owner && existing.leaseUntil > nowIso) return false;
        leases.set(name, { owner, leaseUntil: leaseUntilIso });
        return true;
      },
      releaseSupervisorLease: (name: string, owner: string) =>
        leases.get(name)?.owner === owner && leases.delete(name),
      getSetting: (key: string) => values.get(key),
      setSetting: (key: string, value: string) => values.set(key, value),
    };
  }

  it("defers only a matching in-flight marker and stops deferring after settlement", () => {
    const store = settings();
    const marker = "<!-- openthrottle:pipeline-summary:github:owner/repo#12 -->";
    const now = new Date("2026-08-11T00:00:00.000Z");
    const intent = beginGithubSupervisorCommentWrite(store, "owner/repo", 12, marker, now);

    expect(githubSupervisorCommentWriteIsPending(
      store,
      "OWNER/REPO",
      12,
      `${marker}\nstatus`,
      new Date(now.getTime() + 1_000)
    )).toBe(true);
    expect(githubSupervisorCommentWriteIsPending(
      store,
      "owner/repo",
      13,
      `${marker}\nstatus`,
      new Date(now.getTime() + 1_000)
    )).toBe(false);

    settleGithubSupervisorCommentWrite(store, intent, 99);
    expect(githubSupervisorCommentWriteIsPending(
      store,
      "owner/repo",
      12,
      `${marker}\nstatus`,
      new Date(now.getTime() + 2_000)
    )).toBe(false);
  });

  it("expires an uncertain write instead of trusting marker text indefinitely", () => {
    const store = settings();
    const marker = "<!-- openthrottle:control-session:abc -->";
    const now = new Date("2026-08-11T00:00:00.000Z");
    beginGithubSupervisorCommentWrite(store, "owner/repo", 12, marker, now);

    expect(githubSupervisorCommentWriteIsPending(
      store,
      "owner/repo",
      12,
      marker,
      new Date(now.getTime() + 5 * 60 * 1000 + 1)
    )).toBe(false);
    expect(githubSupervisorCommentWriteIsPending(
      store,
      "owner/repo",
      12,
      "<!-- openthrottle:copied-but-never-pending -->\nfeedback",
      now
    )).toBe(false);
  });

  it("serializes concurrent first writes for the same marker", () => {
    const store = settings();
    const marker = "<!-- openthrottle:control-session:abc -->";
    const now = new Date("2026-08-11T00:00:00.000Z");
    const first = beginGithubSupervisorCommentWrite(store, "owner/repo", 12, marker, now);

    expect(() => beginGithubSupervisorCommentWrite(store, "OWNER/REPO", 12, marker, now))
      .toThrow("already in flight");
    settleGithubSupervisorCommentWrite(store, first, 101);
    expect(() => beginGithubSupervisorCommentWrite(store, "owner/repo", 12, marker, now))
      .not.toThrow();
  });

  it("prevents an expired owner from settling over its successor", () => {
    const store = settings();
    const marker = "<!-- openthrottle:control-session:abc -->";
    const startedAt = new Date("2026-08-11T00:00:00.000Z");
    const first = beginGithubSupervisorCommentWrite(store, "owner/repo", 12, marker, startedAt);
    const successorAt = new Date(startedAt.getTime() + 5 * 60 * 1000 + 1);
    const second = beginGithubSupervisorCommentWrite(
      store,
      "owner/repo",
      12,
      marker,
      successorAt
    );

    expect(() => settleGithubSupervisorCommentWrite(store, first, 101, successorAt))
      .toThrow("lease was lost");
    expect(githubSupervisorCommentWriteIsPending(
      store,
      "owner/repo",
      12,
      marker,
      successorAt
    )).toBe(true);

    settleGithubSupervisorCommentWrite(store, second, 102, successorAt);
    expect(githubSupervisorCommentWriteIsPending(
      store,
      "owner/repo",
      12,
      marker,
      successorAt
    )).toBe(false);
  });
});
