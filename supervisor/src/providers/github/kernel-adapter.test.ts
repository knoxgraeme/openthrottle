import { describe, expect, it, vi } from "vitest";
import type { EffectIntent } from "@openthrottle/contracts";
import { GithubKernelAdapter } from "./kernel-adapter.js";
import { pushRepositoryCheckpoint } from "./checkpoint-push.js";
import { buildGithubPullRequestBody } from "./pull-request-body.js";

vi.mock("./checkpoint-push.js", () => ({
  pushRepositoryCheckpoint: vi.fn(async () => ({ sha: "a".repeat(40) })),
}));

const SUBJECT = "a".repeat(40);
const BASE_SUBJECT = "b".repeat(40);
const CHECKPOINT_BASE_SUBJECT = "c".repeat(40);
const CHECKPOINT_TREE = "d".repeat(40);
const CHECKPOINT_DIGEST = "e".repeat(64);
const TASK_BRANCH = "ot/ope-201-deadbeef";
const OWNERSHIP_MARKER = "openthrottle:run:0123456789abcdef";
const PULL_REQUEST_TITLE = "Dogfood repair";
const PULL_REQUEST_BODY = "Publish the accepted repair.";
const CANONICAL_PULL_REQUEST_BODY = buildGithubPullRequestBody(
  PULL_REQUEST_BODY,
  OWNERSHIP_MARKER,
);

type RequiredObservation =
  | { kind: "check_run"; name: string; app_slug: string }
  | { kind: "commit_status"; context: string; creator_login: string };

const REQUIRED_CHECKS: RequiredObservation[] = [
  { kind: "check_run", name: "docker-smoke", app_slug: "github-actions" },
  { kind: "check_run", name: "quality", app_slug: "github-actions" },
];

function providerWait(required = REQUIRED_CHECKS): EffectIntent {
  return {
    schema: "openthrottle.effect-intent/v1",
    id: "effect-wait",
    pipeline_run_id: "run-1",
    decision_record_id: "decision-1",
    kind: "github/provider-wait@1",
    idempotency_key: `run-1:provider:${SUBJECT}`,
    target: `github:owner/repo:checks:${SUBJECT}`,
    subject: SUBJECT,
    payload: {
      schema: "openthrottle.github-provider-wait/v1",
      repository: "owner/repo",
      subject: SUBJECT,
      policy: { required_observations: required },
    },
  };
}

function pullRequest(input: { body?: string; ownershipMarker?: string } = {}): EffectIntent {
  return {
    schema: "openthrottle.effect-intent/v1",
    id: "effect-pull-request",
    pipeline_run_id: "run-1",
    decision_record_id: "decision-1",
    kind: "github/upsert-pull-request@1",
    idempotency_key: `run-1:pull-request:${SUBJECT}`,
    target: `github:owner/repo:pull:${TASK_BRANCH}`,
    subject: SUBJECT,
    payload: {
      schema: "openthrottle.github-pull-request/v1",
      repository: "owner/repo",
      branch: TASK_BRANCH,
      base_branch: "main",
      expected_head_subject: SUBJECT,
      title: PULL_REQUEST_TITLE,
      body: input.body ?? PULL_REQUEST_BODY,
      ownership_marker: input.ownershipMarker ?? OWNERSHIP_MARKER,
      publication_selection: {
        result_record_id: `result-${"1".repeat(48)}`,
        acceptance_decision_record_id: `decision-${"2".repeat(48)}`,
        pipeline_run_id: "run-1",
        definition_bundle_hash: "f".repeat(64),
        input_subject: SUBJECT,
      },
      publication_provenance: {
        work_item_id: "work-1",
        source_provider: "linear",
        source_id: "issue-1",
        source_reference: "OPE-201",
      },
      verified_gate_record_ids: [],
    },
  };
}

function checkpointPush(refMode: "create" | "update" = "update"): EffectIntent {
  return {
    schema: "openthrottle.effect-intent/v1",
    id: "effect-push-checkpoint",
    pipeline_run_id: "run-1",
    decision_record_id: "decision-1",
    kind: "github/push-checkpoint@1",
    idempotency_key: `run-1:push:${SUBJECT}`,
    target: `github:owner/repo:refs/heads/${TASK_BRANCH}`,
    subject: SUBJECT,
    payload: {
      schema: "openthrottle.github-push-checkpoint/v1",
      ref_mode: refMode,
      repository: "owner/repo",
      ref: `refs/heads/${TASK_BRANCH}`,
      expected_old_subject: BASE_SUBJECT,
      expected_new_subject: SUBJECT,
      checkpoint_base_subject: refMode === "create" ? CHECKPOINT_BASE_SUBJECT : BASE_SUBJECT,
      checkpoint_blob: {
        algorithm: "sha256",
        digest: CHECKPOINT_DIGEST,
        bytes: 16,
        encoding: "binary",
        media_type: "application/x-git-bundle",
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      },
      checkpoint_tree: CHECKPOINT_TREE,
    },
  };
}

function check(input: {
  id: number;
  name: string;
  app_slug: string;
  status?: string;
  conclusion?: string | null;
}) {
  return {
    id: input.id,
    name: input.name,
    app: { slug: input.app_slug },
    status: input.status ?? "completed",
    conclusion: input.conclusion === undefined ? "success" : input.conclusion,
  };
}

function status(input: {
  id: number;
  context: string;
  creator_login: string;
  state: string;
}) {
  return {
    id: input.id,
    context: input.context,
    creator: { login: input.creator_login },
    state: input.state,
  };
}

function reconciliation(fetch: typeof globalThis.fetch, intent = providerWait()) {
  const adapter = new GithubKernelAdapter({ token: "token", blob_store: {} as never, fetch });
  const binding = adapter.effectBindings().find(
    ({ effect_kind }) => effect_kind === "github/provider-wait@1",
  )!;
  return binding.adapter.reconcile({
    intent,
    external_identity: intent.target,
    dispatch_fence: null,
  });
}

function pullRequestReconciliation(
  fetch: typeof globalThis.fetch,
  intent = pullRequest(),
) {
  const adapter = new GithubKernelAdapter({ token: "token", blob_store: {} as never, fetch });
  const binding = adapter.effectBindings().find(
    ({ effect_kind }) => effect_kind === "github/upsert-pull-request@1",
  )!;
  return binding.adapter.reconcile({
    intent,
    external_identity: intent.target,
    dispatch_fence: null,
  });
}

function pushBinding(adapter: GithubKernelAdapter) {
  return adapter.effectBindings().find(
    ({ effect_kind }) => effect_kind === "github/push-checkpoint@1",
  )!;
}

function pullRequestBinding(adapter: GithubKernelAdapter) {
  return adapter.effectBindings().find(
    ({ effect_kind }) => effect_kind === "github/upsert-pull-request@1",
  )!;
}

function pushReconciliation(fetch: typeof globalThis.fetch, intent = checkpointPush()) {
  const adapter = new GithubKernelAdapter({ token: "token", blob_store: {} as never, fetch });
  return pushBinding(adapter).adapter.reconcile({
    intent,
    external_identity: intent.target,
    dispatch_fence: null,
  });
}

function endpointFetch(input: {
  checks?: unknown;
  statuses?: unknown;
  checkStatus?: number;
  statusStatus?: number;
}) {
  return vi.fn(async (request: string | URL | Request) => {
    const checks = String(request).includes("/check-runs");
    return new Response(JSON.stringify(checks ? input.checks ?? {} : input.statuses ?? {}), {
      status: checks ? input.checkStatus ?? 200 : input.statusStatus ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

function publicationFetch(input: {
  pulls?: unknown[];
  taskHead?: string | null;
  baseHead?: string | null;
  commonAncestor?: boolean;
  comparisonStatus?: "ahead" | "behind" | "diverged" | "identical";
  aheadBy?: number;
  publicationParent?: unknown | null;
  compareBaseCommit?: unknown | null;
  compareHeadCommit?: unknown | null;
}) {
  return vi.fn(async (request: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(request));
    const path = decodeURIComponent(url.pathname);
    if (path.endsWith(`/git/ref/heads/${TASK_BRANCH}`)) {
      return input.taskHead === null
        ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
        : new Response(JSON.stringify({ object: { sha: input.taskHead ?? SUBJECT } }));
    }
    if (path.endsWith("/git/ref/heads/main")) {
      return input.baseHead === null
        ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
        : new Response(JSON.stringify({ object: { sha: input.baseHead ?? BASE_SUBJECT } }));
    }
    if (path.endsWith(`/git/commits/${CHECKPOINT_BASE_SUBJECT}`)) {
      if (input.publicationParent === null) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      return new Response(JSON.stringify(
        input.publicationParent === undefined
          ? { sha: CHECKPOINT_BASE_SUBJECT }
          : input.publicationParent,
      ));
    }
    if (path.endsWith(`/git/commits/${BASE_SUBJECT}`)) {
      return input.compareBaseCommit === null
        ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
        : new Response(JSON.stringify(input.compareBaseCommit ?? { sha: BASE_SUBJECT }));
    }
    if (path.endsWith(`/git/commits/${SUBJECT}`)) {
      return input.compareHeadCommit === null
        ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
        : new Response(JSON.stringify(input.compareHeadCommit ?? { sha: SUBJECT }));
    }
    if (path.endsWith("/pulls")) return new Response(JSON.stringify(input.pulls ?? []));
    if (path.includes("/compare/")) {
      return input.commonAncestor === false
        ? new Response(JSON.stringify({ message: "No common ancestor" }), { status: 404 })
        : new Response(JSON.stringify({
          merge_base_commit: { sha: BASE_SUBJECT },
          status: input.comparisonStatus ?? "ahead",
          ahead_by: input.aheadBy ?? 1,
        }));
    }
    throw new Error(`unexpected GitHub request ${url}`);
  });
}

function ownedPull(overrides: Record<string, unknown> = {}) {
  return {
    html_url: "https://github.com/owner/repo/pull/1",
    title: PULL_REQUEST_TITLE,
    body: CANONICAL_PULL_REQUEST_BODY,
    state: "open",
    merged_at: null,
    head: { sha: SUBJECT, ref: TASK_BRANCH, repo: { full_name: "owner/repo" } },
    base: { ref: "main" },
    ...overrides,
  };
}

describe("GithubKernelAdapter checkpoint push", () => {
  it("creates only from an absent ref and confirms an already-published replay", async () => {
    const create = checkpointPush("create");
    (create.payload as Record<string, unknown>).expected_old_subject = CHECKPOINT_BASE_SUBJECT;
    const absent = publicationFetch({ taskHead: null });
    await expect(pushReconciliation(absent, create)).resolves.toEqual({ kind: "not_found" });

    const replay = publicationFetch({ taskHead: SUBJECT });
    await expect(pushReconciliation(replay, create)).resolves.toEqual({
      kind: "found",
      status: "confirmed",
      payload: {
        schema: "openthrottle.github-push-delivery/v1",
        repository: "owner/repo",
        ref: `refs/heads/${TASK_BRANCH}`,
        sha: SUBJECT,
        ref_mode: "create",
      },
    });
  });

  it("rejects create mode when its exact publication parent was pruned", async () => {
    const create = checkpointPush("create");
    (create.payload as Record<string, unknown>).expected_old_subject = CHECKPOINT_BASE_SUBJECT;
    await expect(pushReconciliation(publicationFetch({
      taskHead: null,
      publicationParent: null,
    }), create)).resolves.toMatchObject({
      kind: "found",
      status: "rejected",
      payload: { reason: "publication_parent_missing", actual: null },
    });
  });

  it("holds create mode unknown on malformed publication-parent evidence", async () => {
    const create = checkpointPush("create");
    (create.payload as Record<string, unknown>).expected_old_subject = CHECKPOINT_BASE_SUBJECT;
    await expect(pushReconciliation(publicationFetch({
      taskHead: null,
      publicationParent: { sha: "not-the-parent" },
    }), create)).resolves.toEqual({
      kind: "unknown",
      detail: "GitHub returned invalid publication parent evidence",
    });
  });

  it.each([
    ["missing", null, "ref_missing"],
    ["moved", "f".repeat(40), "ref_conflict"],
  ] as const)("rejects an update whose exact task ref is %s", async (_label, taskHead, reason) => {
    await expect(pushReconciliation(publicationFetch({ taskHead }))).resolves.toMatchObject({
      kind: "found",
      status: "rejected",
      payload: {
        schema: "openthrottle.github-push-delivery/v1",
        ref_mode: "update",
        actual: taskHead,
        reason,
      },
    });
  });

  it("rejects create mode when the supposedly absent ref already exists", async () => {
    const create = checkpointPush("create");
    (create.payload as Record<string, unknown>).expected_old_subject = CHECKPOINT_BASE_SUBJECT;
    await expect(pushReconciliation(publicationFetch({ taskHead: BASE_SUBJECT }), create))
      .resolves.toMatchObject({
        kind: "found",
        status: "rejected",
        payload: { ref_mode: "create", actual: BASE_SUBJECT, reason: "ref_conflict" },
      });
  });

  it("passes the sealed update mode with its exact publication-parent cutoff", async () => {
    vi.mocked(pushRepositoryCheckpoint).mockClear();
    const bytes = Buffer.from("checkpoint-bytes");
    const read = vi.fn(() => bytes);
    const adapter = new GithubKernelAdapter({
      token: "token",
      blob_store: { read } as never,
    });
    const intent = checkpointPush();

    await pushBinding(adapter).adapter.dispatch({
      intent,
      external_identity: intent.target,
      dispatch_fence: null,
      deduplication: {
        strategy: "deterministic_target",
        key: intent.idempotency_key,
        target: intent.target,
      },
    });

    expect(read).toHaveBeenCalledWith((intent.payload as Record<string, unknown>).checkpoint_blob);
    expect(pushRepositoryCheckpoint).toHaveBeenCalledWith(
      { token: "token" },
      expect.objectContaining({
        mode: "update",
        expectedOldSha: BASE_SUBJECT,
        expectedNewSha: SUBJECT,
        checkpointBaseSha: BASE_SUBJECT,
      }),
    );
  });

  it("passes create authority only for an explicitly sealed first publication", async () => {
    vi.mocked(pushRepositoryCheckpoint).mockClear();
    const adapter = new GithubKernelAdapter({
      token: "token",
      blob_store: { read: () => Buffer.from("checkpoint-bytes") } as never,
    });
    const intent = checkpointPush("create");
    (intent.payload as Record<string, unknown>).expected_old_subject = CHECKPOINT_BASE_SUBJECT;

    await pushBinding(adapter).adapter.dispatch({
      intent,
      external_identity: intent.target,
      dispatch_fence: null,
      deduplication: {
        strategy: "deterministic_target",
        key: intent.idempotency_key,
        target: intent.target,
      },
    });

    expect(pushRepositoryCheckpoint).toHaveBeenCalledWith(
      { token: "token" },
      expect.objectContaining({ mode: "create" }),
    );
  });

  it("dispatches an identity checkpoint whose old and new subjects are equal", async () => {
    vi.mocked(pushRepositoryCheckpoint).mockClear();
    const bytes = Buffer.from("identity-checkpoint");
    const read = vi.fn(() => bytes);
    const adapter = new GithubKernelAdapter({
      token: "token",
      blob_store: { read } as never,
    });
    const intent = checkpointPush();
    (intent.payload as Record<string, unknown>).expected_old_subject = SUBJECT;
    (intent.payload as Record<string, unknown>).checkpoint_base_subject = SUBJECT;

    await pushBinding(adapter).adapter.dispatch({
      intent,
      external_identity: intent.target,
      dispatch_fence: null,
      deduplication: {
        strategy: "deterministic_target",
        key: intent.idempotency_key,
        target: intent.target,
      },
    });

    expect(read).toHaveBeenCalledOnce();
    expect(pushRepositoryCheckpoint).toHaveBeenCalledWith(
      { token: "token" },
      expect.objectContaining({
        expectedOldSha: SUBJECT,
        expectedNewSha: SUBJECT,
        checkpointBaseSha: SUBJECT,
      }),
    );
  });

  it.each([
    ["missing", undefined],
    ["malformed", "f".repeat(39)],
  ])("rejects a %s checkpoint base before blob or provider access", async (_label, value) => {
    vi.mocked(pushRepositoryCheckpoint).mockClear();
    const read = vi.fn(() => Buffer.from("checkpoint-bytes"));
    const adapter = new GithubKernelAdapter({ token: "token", blob_store: { read } as never });
    const intent = checkpointPush();
    if (value === undefined) {
      delete (intent.payload as Record<string, unknown>).checkpoint_base_subject;
    } else {
      (intent.payload as Record<string, unknown>).checkpoint_base_subject = value;
    }

    await expect(pushBinding(adapter).adapter.dispatch({
      intent,
      external_identity: intent.target,
      dispatch_fence: null,
      deduplication: {
        strategy: "deterministic_target",
        key: intent.idempotency_key,
        target: intent.target,
      },
    })).rejects.toThrow(/checkpoint push (?:payload|authority)/i);
    expect(read).not.toHaveBeenCalled();
    expect(pushRepositoryCheckpoint).not.toHaveBeenCalled();
  });
});

describe("GithubKernelAdapter pull request reconciliation", () => {
  it.each([
    ["oversized title", (payload: Record<string, unknown>) => { payload.title = "t".repeat(73); }],
    ["empty body", (payload: Record<string, unknown>) => { payload.body = ""; }],
    ["oversized body", (payload: Record<string, unknown>) => { payload.body = "b".repeat(12_001); }],
    ["extra payload field", (payload: Record<string, unknown>) => { payload.forged = true; }],
    ["foreign run selection", (payload: Record<string, unknown>) => {
      (payload.publication_selection as Record<string, unknown>).pipeline_run_id = "run-foreign";
    }],
    ["extra selection field", (payload: Record<string, unknown>) => {
      (payload.publication_selection as Record<string, unknown>).forged = true;
    }],
    ["invalid provenance", (payload: Record<string, unknown>) => {
      (payload.publication_provenance as Record<string, unknown>).source_provider = "agent";
    }],
    ["duplicate gate evidence", (payload: Record<string, unknown>) => {
      payload.verified_gate_record_ids = [
        `result-${"3".repeat(48)}`,
        `result-${"3".repeat(48)}`,
      ];
    }],
  ])("rejects %s before GitHub access", async (_label, mutate) => {
    const intent = structuredClone(pullRequest());
    mutate(intent.payload as Record<string, unknown>);
    const fetch = vi.fn();

    await expect(pullRequestReconciliation(fetch as unknown as typeof globalThis.fetch, intent))
      .rejects.toThrow(/publication|pull request/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "trailing whitespace",
      `${PULL_REQUEST_BODY} \t\n\n `,
      CANONICAL_PULL_REQUEST_BODY,
    ],
    [
      "pre-existing marker placement",
      `${PULL_REQUEST_BODY}\n\n<!-- ${OWNERSHIP_MARKER} -->\n`,
      `${PULL_REQUEST_BODY}\n\n<!-- ${OWNERSHIP_MARKER} -->\n\n<!-- ${OWNERSHIP_MARKER} -->\n`,
    ],
  ])("dispatches and reconciles byte-identical fenced bodies with %s", async (
    _label,
    body,
    expectedBody,
  ) => {
    const intent = pullRequest({ body });
    let dispatchedBody: string | undefined;
    const dispatchFetch = vi.fn(async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = new URL(String(request));
      const path = decodeURIComponent(url.pathname);
      if (path.endsWith(`/git/ref/heads/${TASK_BRANCH}`)) {
        return Response.json({ object: { sha: SUBJECT } });
      }
      if (path.endsWith("/pulls") && init?.method === undefined) {
        return Response.json([]);
      }
      if (path.endsWith("/pulls") && init?.method === "POST") {
        const posted = JSON.parse(String(init.body)) as Record<string, string>;
        dispatchedBody = posted.body;
        return Response.json({
          html_url: "https://github.com/owner/repo/pull/1",
          title: posted.title,
          body: posted.body,
          head: { sha: SUBJECT, ref: TASK_BRANCH, repo: { full_name: "owner/repo" } },
          base: { ref: "main" },
        }, { status: 201 });
      }
      throw new Error(`unexpected GitHub request ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = new GithubKernelAdapter({
      token: "token",
      blob_store: {} as never,
      fetch: dispatchFetch,
    });

    await pullRequestBinding(adapter).adapter.dispatch({
      intent,
      external_identity: intent.target,
      dispatch_fence: null,
      deduplication: {
        strategy: "deterministic_target",
        key: intent.idempotency_key,
        target: intent.target,
      },
    });

    expect(Buffer.from(dispatchedBody!)).toEqual(Buffer.from(expectedBody));
    const reconcileFetch = publicationFetch({
      pulls: [ownedPull({ body: dispatchedBody })],
    });
    await expect(pullRequestReconciliation(reconcileFetch, intent)).resolves.toEqual({
      kind: "found",
      status: "confirmed",
      payload: { url: "https://github.com/owner/repo/pull/1" },
    });
  });

  it("queries bounded all-state history first and confirms one exact owned open pull request", async () => {
    const fetch = publicationFetch({ pulls: [ownedPull()] });

    await expect(pullRequestReconciliation(fetch)).resolves.toEqual({
      kind: "found",
      status: "confirmed",
      payload: { url: "https://github.com/owner/repo/pull/1" },
    });
    const firstRequest = new URL(String(fetch.mock.calls[0]![0]));
    expect(firstRequest.pathname).toBe("/repos/owner/repo/pulls");
    expect(Object.fromEntries(firstRequest.searchParams)).toMatchObject({
      state: "all",
      head: `owner:${TASK_BRANCH}`,
      base: "main",
      per_page: "100",
      page: "1",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("confirms an exact owned merged pull request after its task branch was deleted", async () => {
    const fetch = publicationFetch({
      pulls: [ownedPull({ state: "closed", merged_at: "2026-08-22T07:30:00Z" })],
      taskHead: null,
    });

    await expect(pullRequestReconciliation(fetch)).resolves.toEqual({
      kind: "found",
      status: "confirmed",
      payload: { url: "https://github.com/owner/repo/pull/1" },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects an exact owned pull request that was closed without merging", async () => {
    const fetch = publicationFetch({
      pulls: [ownedPull({ state: "closed", merged_at: null })],
    });

    await expect(pullRequestReconciliation(fetch)).resolves.toEqual({
      kind: "found",
      status: "rejected",
      payload: {
        repository: "owner/repo",
        branch: TASK_BRANCH,
        base_branch: "main",
        expected_head_subject: SUBJECT,
        url: "https://github.com/owner/repo/pull/1",
        reason: "pull_request_closed_unmerged",
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("holds unknown when multiple exact owned historical pull requests match", async () => {
    const fetch = publicationFetch({
      pulls: [
        ownedPull(),
        ownedPull({ html_url: "https://github.com/owner/repo/pull/2" }),
      ],
    });

    await expect(pullRequestReconciliation(fetch)).resolves.toEqual({
      kind: "unknown",
      detail: "multiple owned pull requests match one publication",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["title", { title: "Changed after dispatch" }],
    ["body", { body: `Changed after dispatch\n\n<!-- ${OWNERSHIP_MARKER} -->\n` }],
    ["marker-only body", { body: `<!-- ${OWNERSHIP_MARKER} -->` }],
    ["spoofed ownership marker body", { body: `Published by OpenThrottle. <!-- prefix-${OWNERSHIP_MARKER} -->` }],
  ])("rejects immutable pull request %s drift", async (_label, overrides) => {
    const fetch = publicationFetch({ pulls: [ownedPull(overrides)] });
    await expect(pullRequestReconciliation(fetch)).resolves.toMatchObject({
      kind: "found",
      status: "rejected",
      payload: { reason: "pull_request_immutable_payload_conflict" },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["head SHA", { head: { sha: "c".repeat(40), ref: TASK_BRANCH, repo: { full_name: "owner/repo" } } }],
    ["head ref", { head: { sha: SUBJECT, ref: "ot/wrong", repo: { full_name: "owner/repo" } } }],
    ["head repository", { head: { sha: SUBJECT, ref: TASK_BRANCH, repo: { full_name: "fork/repo" } } }],
    ["base", { base: { ref: "release" } }],
  ])("does not confirm an otherwise-owned pull request with the wrong %s", async (_label, overrides) => {
    const fetch = publicationFetch({ pulls: [ownedPull(overrides)] });

    await expect(pullRequestReconciliation(fetch)).resolves.toEqual({ kind: "not_found" });
    expect(fetch.mock.calls.some(([request]) => String(request).includes("/compare/"))).toBe(true);
  });

  it("rejects an existing exact task head with no common ancestor to the exact base", async () => {
    const fetch = publicationFetch({ commonAncestor: false });

    await expect(pullRequestReconciliation(fetch)).resolves.toEqual({
      kind: "found",
      status: "rejected",
      payload: {
        repository: "owner/repo",
        branch: TASK_BRANCH,
        base_branch: "main",
        expected_head_subject: SUBJECT,
        reason: "no_common_ancestor",
      },
    });
    expect(fetch.mock.calls.map(([request]) => new URL(String(request)).pathname)).toEqual([
      "/repos/owner/repo/pulls",
      `/repos/owner/repo/git/ref/heads%2F${TASK_BRANCH.replace("/", "%2F")}`,
      "/repos/owner/repo/git/ref/heads%2Fmain",
      `/repos/owner/repo/compare/${BASE_SUBJECT}...${SUBJECT}`,
      `/repos/owner/repo/git/commits/${BASE_SUBJECT}`,
      `/repos/owner/repo/git/commits/${SUBJECT}`,
    ]);
  });

  it("holds unknown when compare returns 404 but an exact commit lookup is inaccessible", async () => {
    const fetch = publicationFetch({ commonAncestor: false, compareHeadCommit: null });

    await expect(pullRequestReconciliation(fetch)).resolves.toEqual({
      kind: "unknown",
      detail: "GitHub comparison 404 lacked exact base and head commit evidence",
    });
    expect(fetch.mock.calls.some(([request]) =>
      String(request).includes(`/git/commits/${BASE_SUBJECT}`))).toBe(true);
    expect(fetch.mock.calls.some(([request]) =>
      String(request).includes(`/git/commits/${SUBJECT}`))).toBe(true);
  });

  it.each([
    ["base SHA disagrees", { compareBaseCommit: { sha: "c".repeat(40) } }],
    ["head SHA is absent", { compareHeadCommit: { message: "ambiguous evidence" } }],
  ])("holds unknown when compare returns 404 and the %s", async (_label, evidence) => {
    const fetch = publicationFetch({ commonAncestor: false, ...evidence });

    await expect(pullRequestReconciliation(fetch)).resolves.toEqual({
      kind: "unknown",
      detail: "GitHub comparison 404 lacked exact base and head commit evidence",
    });
  });

  it("rejects a live task ref that moved away from the expected subject", async () => {
    const actualHead = "c".repeat(40);
    const fetch = publicationFetch({ taskHead: actualHead });

    await expect(pullRequestReconciliation(fetch)).resolves.toEqual({
      kind: "found",
      status: "rejected",
      payload: {
        repository: "owner/repo",
        branch: TASK_BRANCH,
        expected_head_subject: SUBJECT,
        actual_head_subject: actualHead,
        reason: "ref_conflict",
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a missing task ref after publication instead of redispatching the PR", async () => {
    const fetch = publicationFetch({ taskHead: null });
    await expect(pullRequestReconciliation(fetch)).resolves.toMatchObject({
      kind: "found",
      status: "rejected",
      payload: { reason: "task_ref_missing" },
    });
    expect(fetch.mock.calls.some(([request]) => String(request).includes("/compare/"))).toBe(false);
  });

  it("rejects a missing exact base ref when no owned pull request exists", async () => {
    const fetch = publicationFetch({ baseHead: null });

    await expect(pullRequestReconciliation(fetch)).resolves.toEqual({
      kind: "found",
      status: "rejected",
      payload: {
        repository: "owner/repo",
        branch: TASK_BRANCH,
        base_branch: "main",
        expected_head_subject: SUBJECT,
        reason: "base_ref_missing",
      },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps a connected exact task head without a pull request dispatchable", async () => {
    const fetch = publicationFetch({ commonAncestor: true });

    await expect(pullRequestReconciliation(fetch)).resolves.toEqual({ kind: "not_found" });
  });

  it.each([
    ["equal to", "identical" as const, 0],
    ["contained by", "behind" as const, 0],
  ])("rejects an exact task head already %s the advanced base", async (_label, comparisonStatus, aheadBy) => {
    const fetch = publicationFetch({ comparisonStatus, aheadBy });
    await expect(pullRequestReconciliation(fetch)).resolves.toMatchObject({
      kind: "found",
      status: "rejected",
      payload: { reason: "expected_head_already_in_base" },
    });
  });

  it("holds unknown when the bounded historical pull request window is exhausted", async () => {
    const unrelatedPage = Array.from({ length: 100 }, (_, index) => ownedPull({
      html_url: `https://github.com/owner/repo/pull/${index + 1}`,
      body: "human-created",
    }));
    const fetch = vi.fn(async () => Response.json(unrelatedPage)) as unknown as typeof globalThis.fetch;

    await expect(pullRequestReconciliation(fetch)).resolves.toEqual({
      kind: "unknown",
      detail: "GitHub pull request pagination bound of 10 pages was exhausted",
    });
    expect(fetch).toHaveBeenCalledTimes(10);
  });
});

describe("GithubKernelAdapter provider wait", () => {
  it.each([
    ["empty", []],
    ["unrelated", [check({ id: 1, name: "unrelated", app_slug: "github-actions" })]],
    ["untrusted", [check({ id: 1, name: "quality", app_slug: "untrusted-app" })]],
    ["pending", [check({ id: 1, name: "quality", app_slug: "github-actions", status: "in_progress", conclusion: null })]],
    ["missing one required", [check({ id: 1, name: "quality", app_slug: "github-actions" })]],
  ])("keeps %s required-check evidence unresolved", async (_label, checkRuns) => {
    const fetch = endpointFetch({ checks: { check_runs: checkRuns } });
    await expect(reconciliation(fetch)).resolves.toEqual({ kind: "not_found" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("ignores unrelated failures but waits for a pending required check", async () => {
    const fetch = endpointFetch({ checks: { check_runs: [
      check({ id: 1, name: "quality", app_slug: "github-actions" }),
      check({ id: 2, name: "docker-smoke", app_slug: "github-actions", status: "queued", conclusion: null }),
      check({ id: 3, name: "unrelated", app_slug: "github-actions", conclusion: "failure" }),
    ] } });

    await expect(reconciliation(fetch)).resolves.toEqual({ kind: "not_found" });
  });

  it("rejects a failed required observation even when another requirement is missing", async () => {
    const fetch = endpointFetch({ checks: { check_runs: [
      check({ id: 7, name: "quality", app_slug: "github-actions", conclusion: "failure" }),
    ] } });

    await expect(reconciliation(fetch)).resolves.toEqual({
      kind: "found",
      status: "rejected",
      payload: {
        schema: "openthrottle.github-provider-observation/v1",
        subject: SUBJECT,
        reason: "required_observation_failed",
        matched_observations: [{
          kind: "check_run",
          id: 7,
          name: "quality",
          app_slug: "github-actions",
          status: "completed",
          conclusion: "failure",
        }],
      },
    });
  });

  it("confirms all exact trusted kinds and never uses the combined top-level status", async () => {
    const required: RequiredObservation[] = [
      { kind: "commit_status", context: "coverage", creator_login: "coverage-bot" },
      { kind: "check_run", name: "quality", app_slug: "github-actions" },
    ];
    const fetch = endpointFetch({
      checks: { check_runs: [
        check({ id: 10, name: "quality", app_slug: "github-actions" }),
        check({ id: 11, name: "unrelated", app_slug: "github-actions", conclusion: "failure" }),
      ] },
      statuses: {
        state: "failure",
        statuses: [
          status({ id: 21, context: "coverage", creator_login: "coverage-bot", state: "success" }),
          status({ id: 22, context: "unrelated", creator_login: "coverage-bot", state: "pending" }),
        ],
      },
    });

    await expect(reconciliation(fetch, providerWait(required))).resolves.toEqual({
      kind: "found",
      status: "confirmed",
      payload: {
        schema: "openthrottle.github-provider-observation/v1",
        subject: SUBJECT,
        reason: "all_required_observations_succeeded",
        matched_observations: [
          {
            kind: "check_run",
            id: 10,
            name: "quality",
            app_slug: "github-actions",
            status: "completed",
            conclusion: "success",
          },
          {
            kind: "commit_status",
            id: 21,
            context: "coverage",
            creator_login: "coverage-bot",
            state: "success",
          },
        ],
      },
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("fails closed on duplicate exact observations or malformed identity", async () => {
    const required = [{ kind: "check_run", name: "quality", app_slug: "github-actions" }] as const;
    const duplicate = endpointFetch({ checks: { check_runs: [
      check({ id: 1, name: "quality", app_slug: "github-actions" }),
      check({ id: 2, name: "quality", app_slug: "github-actions", status: "in_progress", conclusion: null }),
    ] } });
    await expect(reconciliation(duplicate, providerWait([...required]))).resolves.toMatchObject({
      kind: "unknown",
      detail: expect.stringMatching(/multiple exact matches/i),
    });

    const malformed = endpointFetch({ checks: { check_runs: [{
      name: "quality", app: { slug: "github-actions" }, status: "completed", conclusion: "success",
    }] } });
    await expect(reconciliation(malformed, providerWait([...required]))).resolves.toMatchObject({
      kind: "unknown",
      detail: expect.stringMatching(/id/i),
    });
  });

  it("paginates within a fixed bound and holds unknown when the bound cannot prove absence", async () => {
    const required = [{ kind: "check_run", name: "quality", app_slug: "github-actions" }] as const;
    const unrelatedPage = Array.from({ length: 100 }, (_, index) =>
      check({ id: index + 1, name: `unrelated-${index}`, app_slug: "github-actions" }));
    const paged = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(String(request));
      const page = Number(url.searchParams.get("page") ?? "1");
      return new Response(JSON.stringify({ check_runs: page === 1
        ? unrelatedPage
        : [check({ id: 101, name: "quality", app_slug: "github-actions" })] }));
    }) as unknown as typeof globalThis.fetch;
    await expect(reconciliation(paged, providerWait([...required]))).resolves.toMatchObject({
      kind: "found",
      status: "confirmed",
    });
    expect(paged).toHaveBeenCalledTimes(3);

    const unbounded = vi.fn(async () => new Response(JSON.stringify({ check_runs: unrelatedPage }))) as
      unknown as typeof globalThis.fetch;
    await expect(reconciliation(unbounded, providerWait([...required]))).resolves.toMatchObject({
      kind: "unknown",
      detail: expect.stringMatching(/pagination bound/i),
    });
    expect(unbounded).toHaveBeenCalledTimes(10);
  });

  it("holds unknown when the provider pagination window changes during collection", async () => {
    const required = [{ kind: "check_run", name: "quality", app_slug: "github-actions" }] as const;
    let requestCount = 0;
    const fetch = vi.fn(async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ check_runs: [check({
        id: requestCount,
        name: "quality",
        app_slug: "github-actions",
        status: requestCount === 1 ? "completed" : "in_progress",
        conclusion: requestCount === 1 ? "success" : null,
      })] }));
    }) as unknown as typeof globalThis.fetch;

    await expect(reconciliation(fetch, providerWait([...required]))).resolves.toMatchObject({
      kind: "unknown",
      detail: expect.stringMatching(/window changed/i),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds provider reconciliation with the shared request abort signal", async () => {
    const fetch = vi.fn(async (_request: string | URL | Request, init?: RequestInit) => {
      if (!(init?.signal instanceof AbortSignal)) throw new Error("missing bounded signal");
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }) as unknown as typeof globalThis.fetch;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      queueMicrotask(() => controller.abort(new DOMException("timed out", "TimeoutError")));
      return controller.signal;
    });

    try {
      await expect(reconciliation(fetch, providerWait([
        { kind: "check_run", name: "quality", app_slug: "github-actions" },
      ]))).resolves.toMatchObject({
        kind: "unknown",
        detail: expect.stringMatching(/observation failed.*timed out/i),
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(timeout).toHaveBeenCalledWith(15_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("rejects missing or extra sealed wait payload fields before provider access", async () => {
    const fetch = endpointFetch({ checks: { check_runs: [] } });
    const missing = providerWait();
    delete (missing.payload as Record<string, unknown>).policy;
    await expect(reconciliation(fetch, missing)).rejects.toThrow(/unknown or missing fields/);
    const extra = providerWait();
    (extra.payload as Record<string, unknown>).unexpected = true;
    await expect(reconciliation(fetch, extra)).rejects.toThrow(/unknown or missing fields/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["check-runs", "status"])(
    "keeps a required provider wait unresolved when the %s endpoint returns 404",
    async (missingEndpoint) => {
      const required: RequiredObservation[] = missingEndpoint === "check-runs"
        ? [{ kind: "check_run", name: "quality", app_slug: "github-actions" }]
        : [{ kind: "commit_status", context: "coverage", creator_login: "coverage-bot" }];
      const fetch = endpointFetch({
        checks: { check_runs: [] },
        statuses: { statuses: [] },
        ...(missingEndpoint === "check-runs" ? { checkStatus: 404 } : { statusStatus: 404 }),
      });
      await expect(reconciliation(fetch, providerWait(required))).resolves.toEqual({ kind: "not_found" });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});
