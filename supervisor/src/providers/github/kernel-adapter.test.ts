import { describe, expect, it, vi } from "vitest";
import type { EffectIntent } from "@openthrottle/contracts";
import { GithubKernelAdapter } from "./kernel-adapter.js";

const SUBJECT = "a".repeat(40);

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
