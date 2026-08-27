import { describe, expect, it, vi } from "vitest";
import {
  SqliteKernelInboxStore,
  type KernelInboxEvent,
} from "../persistence/kernel-inbox-store.js";
import type { KernelStatusProjection } from "../persistence/kernel-projection-store.js";
import type { KernelRunReference } from "../persistence/kernel-registration-store.js";
import { freshKernelFixture } from "../persistence/__fixtures__/kernel-epoch.js";
import { KernelWorker } from "../operations/kernel-worker.js";
import { KernelProviderPromptHandler } from "./kernel-provider-prompt.js";

const STOP_RECEIVED_AT = "2026-08-20T12:00:00.000Z";
const STOP_OCCURRED_AT = "2026-08-20T11:59:30.000Z";
const PRIOR_ORIGIN_AT = "2026-08-20T11:59:00.000Z";
const FUTURE_ORIGIN_AT = "2026-08-20T12:00:00.000Z";
const ADMITTED_AT = "2026-08-20T11:59:15.000Z";

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

function githubStop(input: {
  id?: string;
  received_at?: string;
  occurred_at?: string | null;
  actor?: string | null;
  issue?: Record<string, unknown>;
  comment?: Record<string, unknown>;
} = {}): KernelInboxEvent {
  const comment = {
    id: 991,
    body: "/stop",
    ...(input.actor === null ? {} : { user: { login: input.actor ?? "maintainer" } }),
    ...(input.occurred_at === null ? {} : { created_at: input.occurred_at ?? STOP_OCCURRED_AT }),
    ...input.comment,
  };
  return event({
    id: input.id ?? "inbox-github-stop",
    source_provider: "github",
    delivery_id: `delivery-${input.id ?? "github-stop"}`,
    kind: "github/issue-comment/created@1",
    created_at: input.received_at ?? STOP_RECEIVED_AT,
    payload: {
      repository: { full_name: "Owner/Repo" },
      issue: { number: 188, ...input.issue },
      comment,
    },
  });
}

function githubOrigin(input: {
  id?: string;
  kind?: "github/issues/opened@1" | "github/issues/labeled@1" | "github/issues/edited@1";
  occurred_at?: string | null;
  received_at?: string;
  consumed_at?: string;
  issue?: Record<string, unknown>;
} = {}): KernelInboxEvent {
  const kind = input.kind ?? "github/issues/labeled@1";
  const occurredAt = input.occurred_at === null ? {} : {
    [kind === "github/issues/opened@1" ? "created_at" : "updated_at"]:
      input.occurred_at ?? PRIOR_ORIGIN_AT,
  };
  return event({
    id: input.id ?? "inbox-github-origin",
    source_provider: "github",
    delivery_id: `delivery-${input.id ?? "github-origin"}`,
    kind,
    status: "consumed",
    lease_id: null,
    lease_owner_id: null,
    lease_expires_at: null,
    created_at: input.received_at ?? "2026-08-20T11:58:00.000Z",
    consumed_at: input.consumed_at ?? ADMITTED_AT,
    payload: {
      repository: { full_name: "Owner/Repo" },
      issue: {
        number: 188,
        labels: [{ name: "openthrottle" }],
        ...occurredAt,
        ...input.issue,
      },
    },
  });
}

function handler(input: {
  projected?: KernelStatusProjection;
  authorizeGithubComment?: (input: { repository: string; username: string }) => Promise<boolean>;
  originGithubAdmissions?: KernelInboxEvent[];
  originGithubAdmissionsTruncated?: boolean;
  originGithubAdmissionsCorrupt?: boolean;
  now?: () => Date;
  resolveRun?: () => KernelRunReference | undefined;
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
        admitted_at: ADMITTED_AT,
      })) },
      projections: {
        getStatus: () => input.projected ?? status(),
        listLog: () => ({ entries: [], next_cursor: null, truncated: false }),
      },
      github_authorization: {
        authorizeComment: input.authorizeGithubComment ?? (async () => true),
      },
      inbox: {
        listConsumedAt: () => ({
          events: input.originGithubAdmissions ?? [],
          truncated: input.originGithubAdmissionsTruncated ?? false,
          corrupt: input.originGithubAdmissionsCorrupt ?? false,
        }),
      },
      now: input.now ?? (() => new Date("2026-08-20T12:20:00.000Z")),
      control: { requestRunControl, enqueueSteering },
    }),
    requestRunControl,
    enqueueSteering,
  };
}

async function composedGithubOrdering(input: {
  admission_delivery: "before" | "after";
  origin_occurred_at: string;
}) {
  const fixture = freshKernelFixture();
  let now = new Date(STOP_RECEIVED_AT);
  const inbox = new SqliteKernelInboxStore({
    db: fixture.db,
    blob_store: fixture.blobs,
    now: () => now.toISOString(),
  });
  let admittedAt: string | null = null;
  let admissionCalls = 0;
  const requestRunControl = vi.fn(async () => ({ disposition: "consumed" as const }));
  const prompts = new KernelProviderPromptHandler({
    runs: { resolveRun: () => admittedAt === null ? undefined : {
      pipeline_run_id: "run-1",
      work_item_id: "work-1",
      source_provider: "github",
      source_reference: "owner/repo#188",
      admitted_at: admittedAt,
    } },
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
    now: () => now,
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
        if (leased.kind === "github/issue-comment/created@1") {
          return await prompts.handle(leased) ?? "stale";
        }
        admissionCalls += 1;
        if (input.admission_delivery === "before" && admissionCalls === 1) {
          throw new Error("transient subject lookup failure");
        }
        admittedAt = now.toISOString();
        return "consumed";
      },
    },
    worker_id: "worker-1",
    lease_seconds: 120,
    cycle_limit: 1,
    execution_width: 1,
    now: () => now,
  });
  const ingestAdmission = () => inbox.ingest({
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
      issue: {
        number: 188,
        labels: [{ name: "openthrottle" }],
        updated_at: input.origin_occurred_at,
      },
    },
  });
  const ingestStop = () => inbox.ingest({
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
      comment: {
        id: 991,
        body: "/stop",
        user: { login: "maintainer" },
        created_at: STOP_OCCURRED_AT,
      },
    },
  });

  try {
    if (input.admission_delivery === "before") {
      ingestAdmission();
      await worker.runCycle();
      expect(inbox.get("inbox-delayed-admission")).toMatchObject({ status: "pending" });

      now = new Date("2026-08-20T12:00:00.500Z");
      ingestStop();
      await worker.runCycle();
      expect(inbox.get("inbox-stop-after-removal")).toMatchObject({ status: "pending" });

      now = new Date("2026-08-20T12:00:01.000Z");
      await worker.runCycle();
      now = new Date("2026-08-20T12:00:01.500Z");
      await worker.runCycle();
    } else {
      ingestStop();
      await worker.runCycle();
      expect(inbox.get("inbox-stop-after-removal")).toMatchObject({ status: "pending" });

      now = new Date("2026-08-20T12:00:00.500Z");
      ingestAdmission();
      await worker.runCycle();
      now = new Date("2026-08-20T12:00:01.000Z");
      await worker.runCycle();
    }

    return {
      admissionCalls,
      requestRunControl,
      stop: inbox.get("inbox-stop-after-removal"),
      admission: inbox.get("inbox-delayed-admission"),
    };
  } finally {
    fixture.cleanup();
  }
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
      admitted_at: ADMITTED_AT,
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
      now: () => new Date("2026-08-20T12:09:59.999Z"),
    });
    await expect(test.value.handle(githubStop())).rejects
      .toThrow(/before owner\/repo#188 is admitted/i);
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
      now: () => new Date("2026-08-20T12:00:30.000Z"),
    });

    await expect(test.value.handle(githubStop({ issue: { labels: [] } }))).rejects
      .toThrow(/before owner\/repo#188 is admitted/i);
    expect(authorizeGithubComment).toHaveBeenCalledWith({
      repository: "Owner/Repo",
      username: "maintainer",
    });
    expect(test.requestRunControl).not.toHaveBeenCalled();
  });

  it("settles a no-run GitHub stop at the first lease on or after its grace deadline", async () => {
    const authorizeGithubComment = vi.fn(async () => true);
    const test = handler({
      resolveRun: () => undefined,
      authorizeGithubComment,
      now: () => new Date("2026-08-20T12:10:00.000Z"),
    });

    await expect(test.value.handle(githubStop())).resolves.toBe("stale");
    expect(authorizeGithubComment).not.toHaveBeenCalled();
    expect(test.requestRunControl).not.toHaveBeenCalled();
  });

  it.each([null, "not-an-instant", "2026-02-29T12:00:00Z"])(
    "dead-letters a temporal GitHub stop with invalid provider time %s",
    async (occurredAt) => {
      const authorizeGithubComment = vi.fn(async () => true);
      const test = handler({
        resolveRun: () => undefined,
        authorizeGithubComment,
        now: () => new Date("2026-08-20T12:00:30.000Z"),
      });

      await expect(test.value.handle(githubStop({ occurred_at: occurredAt })))
        .resolves.toBe("dead");
      expect(authorizeGithubComment).not.toHaveBeenCalled();
    },
  );

  it("controls a run when a causally-prior admission is retry-delayed before the stop", async () => {
    const result = await composedGithubOrdering({
      admission_delivery: "before",
      origin_occurred_at: PRIOR_ORIGIN_AT,
    });

    expect(result.admissionCalls).toBe(2);
    expect(result.admission).toMatchObject({ status: "consumed" });
    expect(result.requestRunControl).toHaveBeenCalledOnce();
    expect(result.stop).toMatchObject({ status: "consumed" });
  });

  it("controls a run when a causally-prior admission arrives after the stop first retries", async () => {
    const result = await composedGithubOrdering({
      admission_delivery: "after",
      origin_occurred_at: PRIOR_ORIGIN_AT,
    });

    expect(result.admissionCalls).toBe(1);
    expect(result.admission).toMatchObject({ status: "consumed" });
    expect(result.requestRunControl).toHaveBeenCalledOnce();
    expect(result.stop).toMatchObject({ status: "consumed" });
  });

  it("does not cancel a future-provider-time admission delivered during the stop grace", async () => {
    const result = await composedGithubOrdering({
      admission_delivery: "after",
      origin_occurred_at: FUTURE_ORIGIN_AT,
    });

    expect(result.admission).toMatchObject({ status: "consumed" });
    expect(result.requestRunControl).not.toHaveBeenCalled();
    expect(result.stop).toMatchObject({ status: "stale" });
  });

  it.each(["truncated", "corrupt"] as const)(
    "fails closed when the exact admission-origin observation is %s",
    async (failure) => {
      const authorizeGithubComment = vi.fn(async () => true);
      const test = handler({
        authorizeGithubComment,
        originGithubAdmissions: [githubOrigin()],
        originGithubAdmissionsTruncated: failure === "truncated",
        originGithubAdmissionsCorrupt: failure === "corrupt",
      });
      await expect(test.value.handle(githubStop())).resolves.toBe("stale");
      expect(authorizeGithubComment).not.toHaveBeenCalled();
      expect(test.requestRunControl).not.toHaveBeenCalled();
    },
  );

  it("settles a run-present stop unless exactly one eligible origin matches its reference", async () => {
    const authorizeGithubComment = vi.fn(async () => true);
    const test = handler({
      authorizeGithubComment,
      originGithubAdmissions: [
        githubOrigin({ id: "other-issue", issue: { number: 189 } }),
        githubOrigin({ id: "unlabeled", issue: { labels: [] } }),
        githubOrigin({
          id: "pull-request",
          issue: { pull_request: { url: "https://api.github.com/repos/Owner/Repo/pulls/188" } },
        }),
      ],
    });
    await expect(test.value.handle(githubStop())).resolves.toBe("stale");
    expect(authorizeGithubComment).not.toHaveBeenCalled();
  });

  it.each([
    "github/issues/opened@1",
    "github/issues/labeled@1",
    "github/issues/edited@1",
  ] as const)("stops a preexisting run with one exact %s origin", async (kind) => {
    const authorizeGithubComment = vi.fn(async () => true);
    const test = handler({
      authorizeGithubComment,
      originGithubAdmissions: [githubOrigin({ kind })],
    });

    await expect(test.value.handle(githubStop())).resolves.toBe("consumed");
    expect(authorizeGithubComment).toHaveBeenCalledOnce();
    expect(test.requestRunControl).toHaveBeenCalledOnce();
  });

  it.each([
    ["no exact origin", []],
    ["a future provider time", [githubOrigin({ occurred_at: FUTURE_ORIGIN_AT })]],
    ["an equal provider time received before the stop", [githubOrigin({
      occurred_at: STOP_OCCURRED_AT,
    })]],
    ["an equal provider time received after the stop", [githubOrigin({
      occurred_at: STOP_OCCURRED_AT,
      received_at: "2026-08-20T12:00:01.000Z",
    })]],
    ["a missing provider time", [githubOrigin({ occurred_at: null })]],
    ["an invalid provider time", [githubOrigin({ occurred_at: "invalid" })]],
    ["two eligible origins", [githubOrigin(), githubOrigin({ id: "inbox-origin-2" })]],
  ] as const)("settles a run-present stop with %s", async (_label, origins) => {
    const authorizeGithubComment = vi.fn(async () => true);
    const test = handler({
      authorizeGithubComment,
      originGithubAdmissions: [...origins],
    });

    await expect(test.value.handle(githubStop())).resolves.toBe("stale");
    expect(authorizeGithubComment).not.toHaveBeenCalled();
    expect(test.requestRunControl).not.toHaveBeenCalled();
  });

  it("dead-letters a run-present stop with an invalid provider timestamp", async () => {
    const authorizeGithubComment = vi.fn(async () => true);
    const test = handler({
      authorizeGithubComment,
      originGithubAdmissions: [githubOrigin()],
    });

    await expect(test.value.handle(githubStop({ occurred_at: "invalid" })))
      .resolves.toBe("dead");
    expect(authorizeGithubComment).not.toHaveBeenCalled();
    expect(test.requestRunControl).not.toHaveBeenCalled();
  });

  it("settles a stop when its run was admitted after the finite grace deadline", async () => {
    const admittedAt = "2026-08-20T12:10:00.001Z";
    const test = handler({
      resolveRun: () => ({
        pipeline_run_id: "run-1",
        work_item_id: "work-1",
        source_provider: "github",
        source_reference: "owner/repo#188",
        admitted_at: admittedAt,
      }),
      originGithubAdmissions: [githubOrigin({ consumed_at: admittedAt })],
    });

    await expect(test.value.handle(githubStop())).resolves.toBe("stale");
    expect(test.requestRunControl).not.toHaveBeenCalled();
  });

  it("settles a run-present pull-request stop before authorization", async () => {
    const authorizeGithubComment = vi.fn(async () => true);
    const test = handler({
      authorizeGithubComment,
      originGithubAdmissions: [githubOrigin()],
    });

    await expect(test.value.handle(githubStop({
      issue: { pull_request: { url: "https://api.github.com/repos/Owner/Repo/pulls/188" } },
    }))).resolves.toBe("stale");
    expect(authorizeGithubComment).not.toHaveBeenCalled();
    expect(test.requestRunControl).not.toHaveBeenCalled();
  });

  it.each([
    ["an issue without the control label", { number: 188 }],
    ["a labeled issue without an admitted run", {
      number: 188,
      labels: [{ name: "openthrottle" }],
    }],
  ])("settles a GitHub stop on %s after the no-run grace expires", async (_label, issue) => {
    const authorizeGithubComment = vi.fn(async () => true);
    const test = handler({ resolveRun: () => undefined, authorizeGithubComment });
    await expect(test.value.handle(githubStop({ issue }))).resolves.toBe("stale");
    expect(authorizeGithubComment).not.toHaveBeenCalled();
    expect(test.requestRunControl).not.toHaveBeenCalled();
  });

  it("settles a no-run pull-request stop immediately during the grace window", async () => {
    const authorizeGithubComment = vi.fn(async () => true);
    const test = handler({
      resolveRun: () => undefined,
      authorizeGithubComment,
      now: () => new Date("2026-08-20T12:00:30.000Z"),
    });

    await expect(test.value.handle(githubStop({
      issue: { pull_request: { url: "https://api.github.com/repos/Owner/Repo/pulls/188" } },
    }))).resolves.toBe("stale");
    expect(authorizeGithubComment).not.toHaveBeenCalled();
  });

  it.each([
    ["an outsider", "outsider"],
    ["a missing actor", null],
  ])("settles a no-run GitHub stop from %s without retrying it", async (_label, actor) => {
    const authorizeGithubComment = vi.fn(async () => false);
    const test = handler({
      resolveRun: () => undefined,
      authorizeGithubComment,
      now: () => new Date("2026-08-20T12:00:30.000Z"),
    });
    await expect(test.value.handle(githubStop({ actor }))).resolves.toBe("stale");
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
    const test = handler({
      authorizeGithubComment: async () => false,
      originGithubAdmissions: body === "/stop" ? [githubOrigin()] : [],
    });
    const comment = body === "/stop"
      ? githubStop({ actor: "outsider" })
      : event({
        source_provider: "github",
        kind: "github/issue-comment/created@1",
        payload: {
          repository: { full_name: "Owner/Repo" },
          issue: { number: 188 },
          comment: { id: 991, body, user: { login: "outsider" } },
        },
      });

    await expect(test.value.handle(comment)).resolves.toBe("stale");
    expect(test.requestRunControl).not.toHaveBeenCalled();
    expect(test.enqueueSteering).not.toHaveBeenCalled();
  });

  it("keeps GitHub comments retryable when collaborator permission lookup fails", async () => {
    const test = handler({
      originGithubAdmissions: [githubOrigin()],
      authorizeGithubComment: async () => {
        throw new Error("GitHub permission lookup unavailable");
      },
    });

    await expect(test.value.handle(githubStop()))
      .rejects.toThrow("GitHub permission lookup unavailable");
    expect(test.requestRunControl).not.toHaveBeenCalled();
  });

  it("treats a GitHub comment without a trusted actor identity as stale", async () => {
    const authorizeGithubComment = vi.fn(async () => true);
    const test = handler({ authorizeGithubComment });

    await expect(test.value.handle(githubStop({ actor: null }))).resolves.toBe("stale");
    expect(authorizeGithubComment).not.toHaveBeenCalled();
  });
});
