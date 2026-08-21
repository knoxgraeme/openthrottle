import { describe, expect, it, vi } from "vitest";
import type { EffectIntent } from "@openthrottle/contracts";
import { GithubKernelAdapter } from "./kernel-adapter.js";

const SUBJECT = "a".repeat(40);

function providerWait(): EffectIntent {
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
    },
  };
}

describe("GithubKernelAdapter", () => {
  it.each(["check-runs", "status"])(
    "keeps a provider wait unresolved when the %s endpoint returns 404",
    async (missingEndpoint) => {
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        const missing = url.includes(`/${missingEndpoint}`);
        const body = url.includes("/check-runs")
          ? { check_runs: [] }
          : { state: "success", statuses: [] };
        return new Response(JSON.stringify(missing ? {} : body), {
          status: missing ? 404 : 200,
          headers: { "content-type": "application/json" },
        });
      });
      const adapter = new GithubKernelAdapter({
        token: "token",
        blob_store: {} as never,
        fetch: fetch as typeof globalThis.fetch,
      });
      const binding = adapter.effectBindings().find(
        ({ effect_kind }) => effect_kind === "github/provider-wait@1",
      )!;

      await expect(binding.adapter.reconcile({
        intent: providerWait(),
        external_identity: `github:owner/repo:checks:${SUBJECT}`,
        dispatch_fence: null,
      })).resolves.toEqual({ kind: "not_found" });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
});
