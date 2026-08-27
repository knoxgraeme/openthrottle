import { describe, expect, it, vi } from "vitest";
import {
  SqliteKernelInboxStore,
  type KernelInboxEvent,
} from "../persistence/kernel-inbox-store.js";
import type { KernelStatusProjection } from "../persistence/kernel-projection-store.js";
import { freshKernelFixture } from "../persistence/__fixtures__/kernel-epoch.js";
import { KernelWorker } from "../operations/kernel-worker.js";
import { KernelProviderPromptHandler } from "./kernel-provider-prompt.js";

function event(overrides: Partial<KernelInboxEvent> = {}): KernelInboxEvent {
  return {
    id: "inbox-provider-1",
    source_provider: "linear",
    delivery_id: "linear-delivery-1",
    kind: "linear/agent-session-event/prompted@1",
    work_item_id: null,
    pipeline_run_id: null,
    attempt_id: null,
    generation: 0,
    event_group_key: "linear:delivery-1",
    delivery_attempt: 1,
    subject: null,
    payload_hash: "b".repeat(64),
    payload_schema: "openthrottle.provider-event/linear/v1",
    payload: {
      agentSession: { issue: { identifier: "OPE-188" } },
      agentActivity: {
        id: "activity-1",
        content: { body: "Please focus on the failing contract." },
      },
    },
    status: "processing",
    available_at: "2026-08-20T12:00:00.000Z",
    lease_id: "lease-inbox-1",
    lease_owner_id: "worker-1",
    lease_expires_at: "2026-08-20T12:02:00.000Z",
    version: 1,
    created_at: "2026-08-20T12:00:00.000Z",
    consumed_at: null,
    ...overrides,
  };
}

function status(overrides: Partial<KernelStatusProjection> = {}): KernelStatusProjection {
  return {
    pipeline_run_id: "run-1",
    work_item_id: "work-1",
    source_provider: "linear",
    source_reference: "OPE-188",
    title: "Repair schema handling",
    pipeline_id: "core/implement",
    status: "running",
    terminal_outcome: null,
    stage_id: "implement",
    cursor_version: 4,
    current_subject: "a".repeat(40),
    definition_bundle_hash: "b".repeat(64),
    whose_move: "working",
    attempt_status_counts: {
      pending: 0, running: 1, work_complete: 0, result_pending: 0, recorded: 0,
      settled: 0, needs_human: 0, failed: 0, canceled: 0, superseded: 0,
    },
    effect_status_counts: {
      pending: 0, processing: 0, unknown: 0, acknowledged: 0,
      rejected: 0, canceled: 0, failed: 0,
    },
    attempts: [{
      id: "attempt-1",
      scope_kind: "stage",
      stage_id: "implement",
      status: "running",
      repository_authority: "edit",
      input_subject: "a".repeat(40),
      output_subject: null,
      native_session_bound: true,
      work_retry_ordinal: 0,
      result_correction_count: 0,
      result_correction_deadline: null,
      pending_diagnostic_count: 0,
      lease_purpose: "work",
      lease_expires_at: "2026-08-20T12:02:00.000Z",
      updated_at: "2026-08-20T12:00:00.000Z",
    }],
    effects: [],
    truncated: false,
    updated_at: "2026-08-20T12:00:00.000Z",
    ...overrides,
  };
}

function handler(input: {
  projected?: KernelStatusProjection;
  authorizeGithubComment?: (input: { repository: string; username: string }) => Promise<boolean>;
  pendingGithubAdmissions?: KernelInboxEvent[];
  pendingGithubAdmissionsTruncated?: boolean;
  resolveRun?: () => {
    pipeline_run_id: string;
    work_item_id: string;
    source_provider: "linear";
    source_reference: string;
  } | undefined;
} = {}) {
  const requestRunControl = vi.fn(async () => ({ disposition: "consumed" as const }));
  const enqueueSteering = vi.fn(async () => ({
    accepted: true as const,
    acknowledge: true as const,
    retryable: false as const,
    duplicate: false,
    event: event({ id: "steering-activity-1", kind: "steering/message@1" }),
  }));
  return {
    value: new KernelProviderPromptHandler({
      runs: { resolveRun: input.resolveRun ?? (() => ({
        pipeline_run_id: "run-1",
        work_item_id: "work-1",
        source_provider: "linear" as const,
        source_reference: "OPE-188",
      })) },
      projections: {
        getStatus: () => input.projected ?? status(),
        listLog: () => ({ entries: [], next_cursor: null, truncated: false }),
      },
      github_authorization: {
        authorizeComment: input.authorizeGithubComment ?? (async () => true),
      },
      inbox: {
        matchUnsettled: (_observation, matches) =>
          (input.pendingGithubAdmissions ?? []).some(matches)
            ? "matched"
            : input.pendingGithubAdmissionsTruncated ? "truncated" : "none",
      },
      control: { requestRunControl, enqueueSteering },
    }),
    requestRunControl,
    enqueueSteering,
  };
}

describe("KernelProviderPromptHandler", () => {
  it("turns a Linear follow-up into attempt-bound durable steering", async () => {
    const test = handler();
    await expect(test.value.handle(event())).resolves.toBe("consumed");
    expect(test.enqueueSteering).toHaveBeenCalledWith({
      message_id: "activity-1",
      source: "human",
      body: "Please focus on the failing contract.",
      source_provider: "linear",
      delivery_id: "steering:activity-1",
      delivery_attempt: 1,
      pipeline_run_id: "run-1",
      attempt_id: "attempt-1",
    });
  });

  it("accepts Linear's top-level activity body shape", async () => {
    const test = handler();
    await expect(test.value.handle(event({
      payload: {
        agentSession: { issue: { identifier: "OPE-188" } },
        agentActivity: {
          id: "activity-1",
          body: "Please use the exact follow-up body.",
        },
      },
    }))).resolves.toBe("consumed");
    expect(test.enqueueSteering).toHaveBeenCalledWith(expect.objectContaining({
      body: "Please use the exact follow-up body.",
    }));
  });

  it("hands a Linear prompt without an existing run back to admission", async () => {
    const test = handler({ resolveRun: () => undefined });
    await expect(test.value.handle(event())).resolves.toBeNull();
    expect(test.requestRunControl).not.toHaveBeenCalled();
    expect(test.enqueueSteering).not.toHaveBeenCalled();
  });

  it("keeps a Linear stop retryable, then controls the run once it is admitted", async () => {
    let admitted = false;
    const test = handler({ resolveRun: () => admitted ? {
      pipeline_run_id: "run-1",
      work_item_id: "work-1",
      source_provider: "linear",
      source_reference: "OPE-188",
    } : undefined });
    const stop = event({
      payload: {
        agentSession: { issue: { identifier: "OPE-188" } },
        agentActivity: { id: "activity-1", signal: { type: "stop" } },
      },
    });
    await expect(test.value.handle(stop)).rejects.toThrow(/before OPE-188 is admitted/);
    expect(test.requestRunControl).not.toHaveBeenCalled();
    expect(test.enqueueSteering).not.toHaveBeenCalled();
    admitted = true;
    await expect(test.value.handle(stop)).resolves.toBe("consumed");
    expect(test.requestRunControl).toHaveBeenCalledWith({
      pipeline_run_id: "run-1",
      action: "stop",
      reason: "Stopped from the linear control thread.",
    });
  });

  it("keeps an authorized GitHub stop retryable until its run is admitted", async () => {
    const authorizeGithubComment = vi.fn(async () => true);
    const test = handler({
      resolveRun: () => undefined,
      authorizeGithubComment,
      pendingGithubAdmissions: [event({
        source_provider: "github",
        kind: "github/issues/labeled@1",
        payload: {
          repository: { full_name: "Owner/Repo" },
          issue: { number: 188, labels: [{ name: "openthrottle" }] },
        },
      })],
    });
    await expect(test.value.handle(event({
      source_provider: "github",
      kind: "github/issue-comment/created@1",
      payload: {
        repository: { full_name: "Owner/Repo" },
        issue: { number: 188, labels: [{ name: "openthrottle" }] },
        comment: { id: 991, body: "/stop", user: { login: "maintainer" } },
      },
    }))).rejects.toThrow(/before owner\/repo#188 is admitted/i);
    expect(authorizeGithubComment).toHaveBeenCalledWith({
      repository: "Owner/Repo",
      username: "maintainer",
    });
    expect(test.requestRunControl).not.toHaveBeenCalled();
  });

  it("preserves an authorized stop when an earlier admission is delayed past label removal", async () => {
    const authorizeGithubComment = vi.fn(async () => true);
    const test = handler({
      resolveRun: () => undefined,
      authorizeGithubComment,
      pendingGithubAdmissions: [event({
        source_provider: "github",
        kind: "github/issues/labeled@1",
        payload: {
          repository: { full_name: "Owner/Repo" },
          issue: {
            number: 188,
            labels: [{ name: "openthrottle" }],
          },
        },
      })],
    });

    await expect(test.value.handle(event({
      source_provider: "github",
      kind: "github/issue-comment/created@1",
      payload: {
        repository: { full_name: "Owner/Repo" },
        issue: { number: 188 },
        comment: { id: 991, body: "/stop", user: { login: "maintainer" } },
      },
    }))).rejects.toThrow(/before owner\/repo#188 is admitted/i);
    expect(authorizeGithubComment).toHaveBeenCalledWith({
      repository: "Owner/Repo",
      username: "maintainer",
    });
    expect(test.requestRunControl).not.toHaveBeenCalled();
  });

  it("converges when inbox retry ordering puts a post-removal stop before delayed admission", async () => {
    const fixture = freshKernelFixture();
    try {
      let now = new Date("2026-08-20T12:00:00.000Z");
      const inbox = new SqliteKernelInboxStore({
        db: fixture.db,
        blob_store: fixture.blobs,
        now: () => now.toISOString(),
      });
      inbox.ingest({
        id: "inbox-delayed-admission",
        source_provider: "github",
        delivery_id: "delivery-delayed-admission",
        kind: "github/issues/labeled@1",
        generation: 0,
        event_group_key: "issue:188:labeled",
        delivery_attempt: 1,
        payload_schema: "openthrottle.provider-event/github/v1",
        payload: {
          repository: { full_name: "Owner/Repo" },
          issue: { number: 188, labels: [{ name: "openthrottle" }] },
        },
      });
      let admitted = false;
      let admissionCalls = 0;
      const requestRunControl = vi.fn(async () => ({ disposition: "consumed" as const }));
      const prompts = new KernelProviderPromptHandler({
        runs: { resolveRun: () => admitted ? {
          pipeline_run_id: "run-1",
          work_item_id: "work-1",
          source_provider: "github" as const,
          source_reference: "owner/repo#188",
        } : undefined },
        projections: {
          getStatus: () => status(),
          listLog: () => ({ entries: [], next_cursor: null, truncated: false }),
        },
        inbox,
        github_authorization: { authorizeComment: async () => true },
        control: {
          requestRunControl,
          enqueueSteering: async () => { throw new Error("not used"); },
        },
      });
      const worker = new KernelWorker({
        attempts: {
          recoverExpiredAttemptLeases: async () => [],
          leaseNextEligibleAttempt: async () => null,
        } as never,
        ordinary: {
          resumeReadyAttempt: async () => ({ disposition: "idle" as const }),
          terminalizeExhaustedRecovery: async () => null,
          executeLeasedAttempt: async () => ({ disposition: "idle" as const }),
        } as never,
        external: { resumeReadyAttempt: async () => ({ disposition: "idle" as const }) } as never,
        effects: { drainOne: async () => ({ kind: "idle" as const }) } as never,
        inbox,
        inbox_handler: {
          async handle(leased) {
            if (leased.kind !== "github/issue-comment/created@1") {
              admissionCalls += 1;
              if (admissionCalls === 1) throw new Error("transient subject lookup failure");
              admitted = true;
              return "consumed";
            }
            return await prompts.handle(leased) ?? "stale";
          },
        },
        worker_id: "worker-1",
        lease_seconds: 120,
        cycle_limit: 1,
        execution_width: 1,
        now: () => now,
      });

      await worker.runCycle();
      expect(inbox.get("inbox-delayed-admission")).toMatchObject({ status: "pending" });

      now = new Date("2026-08-20T12:00:00.500Z");
      inbox.ingest({
        id: "inbox-stop-after-removal",
        source_provider: "github",
        delivery_id: "delivery-stop-after-removal",
        kind: "github/issue-comment/created@1",
        generation: 0,
        event_group_key: "issue:188:stop",
        delivery_attempt: 1,
        payload_schema: "openthrottle.provider-event/github/v1",
        payload: {
          repository: { full_name: "Owner/Repo" },
          issue: { number: 188 },
          comment: { id: 991, body: "/stop", user: { login: "maintainer" } },
        },
      });
      await worker.runCycle();
      expect(inbox.get("inbox-stop-after-removal")).toMatchObject({ status: "pending" });

      now = new Date("2026-08-20T12:00:01.000Z");
      await worker.runCycle();
      expect(admitted).toBe(true);
      now = new Date("2026-08-20T12:00:01.500Z");
      await worker.runCycle();

      expect(requestRunControl).toHaveBeenCalledOnce();
      expect(inbox.get("inbox-stop-after-removal")).toMatchObject({ status: "consumed" });
    } finally {
      fixture.cleanup();
    }
  });

  it("retains an authorized stop when the bounded admission observation is truncated", async () => {
    const authorizeGithubComment = vi.fn(async () => true);
    const test = handler({
      resolveRun: () => undefined,
      authorizeGithubComment,
      pendingGithubAdmissionsTruncated: true,
    });
    await expect(test.value.handle(event({
      source_provider: "github",
      kind: "github/issue-comment/created@1",
      payload: {
        repository: { full_name: "Owner/Repo" },
        issue: { number: 188 },
        comment: { id: 991, body: "/stop", user: { login: "maintainer" } },
      },
    }))).rejects.toThrow(/before owner\/repo#188 is admitted/i);
    expect(authorizeGithubComment).toHaveBeenCalledOnce();
  });

  it("settles a stop when unsettled GitHub events cannot admit its issue", async () => {
    const authorizeGithubComment = vi.fn(async () => true);
    const test = handler({
      resolveRun: () => undefined,
      authorizeGithubComment,
      pendingGithubAdmissions: [
        event({
          source_provider: "github",
          kind: "github/issues/opened@1",
          payload: {
            repository: { full_name: "Owner/Repo" },
            issue: { number: 189, labels: [{ name: "openthrottle" }] },
          },
        }),
        event({
          source_provider: "github",
          kind: "github/issues/labeled@1",
          payload: {
            repository: { full_name: "Owner/Repo" },
            issue: { number: 188 },
          },
        }),
        event({
          source_provider: "github",
          kind: "github/issues/edited@1",
          payload: {
            repository: { full_name: "Owner/Repo" },
            issue: {
              number: 188,
              labels: [{ name: "openthrottle" }],
              pull_request: { url: "https://api.github.com/repos/Owner/Repo/pulls/188" },
            },
          },
        }),
      ],
    });
    await expect(test.value.handle(event({
      source_provider: "github",
      kind: "github/issue-comment/created@1",
      payload: {
        repository: { full_name: "Owner/Repo" },
        issue: { number: 188 },
        comment: { id: 991, body: "/stop", user: { login: "maintainer" } },
      },
    }))).resolves.toBe("stale");
    expect(authorizeGithubComment).not.toHaveBeenCalled();
  });

  it.each([
    ["an issue without the control label", { number: 188 }],
    ["a labeled issue without a pending admission", {
      number: 188,
      labels: [{ name: "openthrottle" }],
    }],
    [
      "a pull request",
      {
        number: 188,
        labels: [{ name: "openthrottle" }],
        pull_request: { url: "https://api.github.com/repos/Owner/Repo/pulls/188" },
      },
    ],
  ])("settles an authorized GitHub stop on %s when no run exists", async (_label, issue) => {
    const authorizeGithubComment = vi.fn(async () => true);
    const test = handler({ resolveRun: () => undefined, authorizeGithubComment });
    await expect(test.value.handle(event({
      source_provider: "github",
      kind: "github/issue-comment/created@1",
      payload: {
        repository: { full_name: "Owner/Repo" },
        issue,
        comment: { id: 991, body: "/stop", user: { login: "maintainer" } },
      },
    }))).resolves.toBe("stale");
    expect(authorizeGithubComment).not.toHaveBeenCalled();
    expect(test.requestRunControl).not.toHaveBeenCalled();
  });

  it.each([
    ["an outsider", { id: 991, body: "/stop", user: { login: "outsider" } }],
    ["a missing actor", { id: 991, body: "/stop" }],
  ])("settles a no-run GitHub stop from %s without retrying it", async (_label, comment) => {
    const authorizeGithubComment = vi.fn(async () => false);
    const test = handler({
      resolveRun: () => undefined,
      authorizeGithubComment,
      pendingGithubAdmissions: [event({
        source_provider: "github",
        kind: "github/issues/labeled@1",
        payload: {
          repository: { full_name: "Owner/Repo" },
          issue: { number: 188, labels: [{ name: "openthrottle" }] },
        },
      })],
    });
    await expect(test.value.handle(event({
      source_provider: "github",
      kind: "github/issue-comment/created@1",
      payload: {
        repository: { full_name: "Owner/Repo" },
        issue: { number: 188, labels: [{ name: "openthrottle" }] },
        comment,
      },
    }))).resolves.toBe("stale");
    expect(test.requestRunControl).not.toHaveBeenCalled();
    if (_label === "a missing actor") expect(authorizeGithubComment).not.toHaveBeenCalled();
  });

  it("settles an irrelevant no-run GitHub comment without depending on authorization", async () => {
    const authorizeGithubComment = vi.fn(async () => {
      throw new Error("GitHub permission lookup unavailable");
    });
    const test = handler({ resolveRun: () => undefined, authorizeGithubComment });
    await expect(test.value.handle(event({
      source_provider: "github",
      kind: "github/issue-comment/created@1",
      payload: {
        repository: { full_name: "Owner/Repo" },
        issue: { number: 188 },
        comment: {
          id: 991,
          body: "There is no admitted run for this comment.",
          user: { login: "maintainer" },
        },
      },
    }))).resolves.toBeNull();
    expect(authorizeGithubComment).not.toHaveBeenCalled();
  });

  it("routes a Linear stop signal through the shared run controller", async () => {
    const test = handler();
    await expect(test.value.handle(event({
      payload: {
        agentSession: { issue: { identifier: "OPE-188" } },
        agentActivity: { id: "activity-1", signal: { type: "stop" } },
      },
    }))).resolves.toBe("consumed");
    expect(test.requestRunControl).toHaveBeenCalledWith({
      pipeline_run_id: "run-1",
      action: "stop",
      reason: "Stopped from the linear control thread.",
    });
    expect(test.enqueueSteering).not.toHaveBeenCalled();
  });

  it("keeps a follow-up retryable until an active attempt binds its session", async () => {
    const test = handler({ projected: status({ attempts: [] }) });
    await expect(test.value.handle(event())).rejects.toThrow("no bound steering-capable attempt yet");
  });

  it("routes GitHub issue comments to the same steering primitive", async () => {
    const authorizeGithubComment = vi.fn(async () => true);
    const test = handler({ authorizeGithubComment });
    await expect(test.value.handle(event({
      source_provider: "github",
      kind: "github/issue-comment/created@1",
      payload: {
        repository: { full_name: "Owner/Repo" },
        issue: { number: 188 },
        comment: {
          id: 991,
          body: "Please rerun the focused test.",
          user: { login: "maintainer" },
        },
      },
    }))).resolves.toBe("consumed");
    expect(authorizeGithubComment).toHaveBeenCalledWith({
      repository: "Owner/Repo",
      username: "maintainer",
    });
    expect(test.enqueueSteering).toHaveBeenCalledWith(expect.objectContaining({
      message_id: "991",
      source_provider: "github",
      body: "Please rerun the focused test.",
    }));
  });

  it.each([
    ["steering", "Please rerun the focused test."],
    ["stop", "/stop"],
  ])("ignores an outsider GitHub comment instead of accepting %s", async (_kind, body) => {
    const test = handler({ authorizeGithubComment: async () => false });

    await expect(test.value.handle(event({
      source_provider: "github",
      kind: "github/issue-comment/created@1",
      payload: {
        repository: { full_name: "Owner/Repo" },
        issue: { number: 188 },
        comment: { id: 991, body, user: { login: "outsider" } },
      },
    }))).resolves.toBe("stale");
    expect(test.requestRunControl).not.toHaveBeenCalled();
    expect(test.enqueueSteering).not.toHaveBeenCalled();
  });

  it("keeps GitHub comments retryable when collaborator permission lookup fails", async () => {
    const test = handler({
      authorizeGithubComment: async () => {
        throw new Error("GitHub permission lookup unavailable");
      },
    });

    await expect(test.value.handle(event({
      source_provider: "github",
      kind: "github/issue-comment/created@1",
      payload: {
        repository: { full_name: "Owner/Repo" },
        issue: { number: 188 },
        comment: { id: 991, body: "/stop", user: { login: "maintainer" } },
      },
    }))).rejects.toThrow("GitHub permission lookup unavailable");
    expect(test.requestRunControl).not.toHaveBeenCalled();
  });

  it("treats a GitHub comment without a trusted actor identity as stale", async () => {
    const authorizeGithubComment = vi.fn(async () => true);
    const test = handler({ authorizeGithubComment });

    await expect(test.value.handle(event({
      source_provider: "github",
      kind: "github/issue-comment/created@1",
      payload: {
        repository: { full_name: "Owner/Repo" },
        issue: { number: 188 },
        comment: { id: 991, body: "/stop" },
      },
    }))).resolves.toBe("stale");
    expect(authorizeGithubComment).not.toHaveBeenCalled();
  });
});
