import { describe, expect, it, vi } from "vitest";
import type { KernelInboxEvent } from "../persistence/kernel-inbox-store.js";
import type { KernelRepositoryRegistrationPort } from "../persistence/kernel-registration-store.js";
import { KernelAdmissionInboxHandler, selectKernelInboxPipeline } from "./kernel-inbox-handler.js";

const structuredPlan = {
  schema: "openthrottle.execution-plan/v2",
  pipeline_id: "core/structured",
  plan_id: "plan-1",
  units: [{
    id: "unit-a",
    title: "Unit A",
    depends_on: [],
    objective: "Implement A",
    requirements: ["A is durable"],
    files: ["a.ts"],
    approach: ["Implement the bounded change"],
    tests: ["Test A"],
    acceptance: ["A works"],
    verification: ["npm test"],
  }],
  commands: [],
};

describe("kernel inbox pipeline selection", () => {
  it("routes ordinary unplanned work through filesystem-defined admission", () => {
    expect(selectKernelInboxPipeline([], "Fix the failing behavior.")).toBe("core/admission");
    expect(selectKernelInboxPipeline([], [
      "This merely mentions a schema-like fragment:",
      '"schema": "openthrottle.execution-plan/v2"',
    ].join("\n"))).toBe("core/admission");
  });

  it("bypasses admission only for an exact valid structured plan", () => {
    const prompt = `Execute this plan.\n\n\`\`\`json openthrottle.execution-plan/v2\n${JSON.stringify(structuredPlan)}\n\`\`\``;
    expect(selectKernelInboxPipeline([], prompt)).toBe("core/structured");
    expect(selectKernelInboxPipeline([], `${prompt}\n${prompt}`)).toBe("core/admission");
  });

  it("preserves the explicit investigate route", () => {
    expect(selectKernelInboxPipeline(["Investigate"], "Diagnose the failure.")).toBe("core/investigate");
  });
});

describe("KernelAdmissionInboxHandler", () => {
  it("bounds GitHub subject resolution with an abort signal", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("subject lookup timed out", "AbortError");
    });
    const registration = {
      id: "registration-1",
      control_provider: "github" as const,
      route_key: "owner/repo",
      linear_team_id: null,
      linear_team_key: null,
      github_repo: "owner/repo",
      github_installation_id: null,
      base_branch: "main",
      webhook_id: null,
      runtime_snapshot: "snapshot",
      version: 0,
      created_at: "2026-08-20T12:00:00.000Z",
      updated_at: "2026-08-20T12:00:00.000Z",
    };
    const registrations = {
      resolveRun: () => undefined,
      findGithubRoute: () => registration,
      findLinearRoute: () => undefined,
      list: () => [registration],
      put: () => { throw new Error("not used"); },
    } satisfies KernelRepositoryRegistrationPort;
    const event: KernelInboxEvent = {
      id: "inbox-1",
      source_provider: "github",
      delivery_id: "delivery-1",
      kind: "github/issues/opened@1",
      work_item_id: null,
      pipeline_run_id: null,
      attempt_id: null,
      generation: 0,
      event_group_key: "issue-opened",
      delivery_attempt: 1,
      subject: null,
      payload_hash: "a".repeat(64),
      payload_schema: "openthrottle.provider-event/github/v1",
      payload: {
        repository: { full_name: "owner/repo" },
        issue: { id: 42, number: 42, title: "Task", body: "Implement it", labels: [{ name: "openthrottle" }] },
      },
      status: "processing",
      available_at: "2026-08-20T12:00:00.000Z",
      lease_id: "lease-1",
      lease_owner_id: "worker-1",
      lease_expires_at: "2026-08-20T12:02:00.000Z",
      version: 1,
      created_at: "2026-08-20T12:00:00.000Z",
      consumed_at: null,
    };
    const handler = new KernelAdmissionInboxHandler({
      registrations,
      github_token: "token",
      source_reader: {} as never,
      platform: {} as never,
      compiler_environment: {} as never,
      runtime: {} as never,
      blob_store: {} as never,
      store: {} as never,
      fetch: fetchMock,
      github_subject_timeout_ms: 100,
    });

    await expect(handler.handle(event)).rejects.toThrow(/timed out/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
