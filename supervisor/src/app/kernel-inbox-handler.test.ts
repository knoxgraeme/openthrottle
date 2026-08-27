import { describe, expect, it, vi } from "vitest";
import type { KernelInboxEvent } from "../persistence/kernel-inbox-store.js";
import type { KernelRepositoryRegistrationPort } from "../persistence/kernel-registration-store.js";
import {
  KernelAdmissionInboxHandler,
  linearAdmissionPrompt,
  selectKernelInboxPipeline,
} from "./kernel-inbox-handler.js";

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

function structuredPlanBlock(marker = "json"): string {
  return `\`\`\`${marker}\n${JSON.stringify(structuredPlan)}\n\`\`\``;
}

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

  it("restores a valid plan fence normalized by Linear before routing and sealing", () => {
    const prompt = linearAdmissionPrompt({
      event_kind: "linear/agent-session-event/created@1",
      title: "Execute the accepted plan",
      description: "Use the exact bounded units.",
      payload: { promptContext: structuredPlanBlock() },
    });

    expect(prompt).toContain("```json openthrottle.execution-plan/v2\n");
    expect(selectKernelInboxPipeline([], prompt)).toBe("core/structured");
  });

  it.each([
    ["two normalized plans", `${structuredPlanBlock()}\n${structuredPlanBlock()}`],
    [
      "one tagged and one normalized plan",
      `${structuredPlanBlock("json openthrottle.execution-plan/v2")}\n${structuredPlanBlock()}`,
    ],
  ])("keeps Linear plan ambiguity fail closed for %s", (_label, promptContext) => {
    const prompt = linearAdmissionPrompt({
      event_kind: "linear/agent-session-event/created@1",
      title: "Ambiguous plan",
      description: "Do not choose between plan blocks.",
      payload: { promptContext },
    });

    expect(selectKernelInboxPipeline([], prompt)).toBe("core/admission");
  });

  it.each([
    ["unrelated JSON", "```json\n{\"answer\":42}\n```"],
    ["malformed JSON", "```json\n{not-json}\n```"],
    [
      "a JSON block with another schema",
      "```json\n{\"schema\":\"example.execution-plan/v1\"}\n```",
    ],
    [
      "a multi-token fence Linear did not normalize",
      structuredPlanBlock("json unrelated-marker"),
    ],
    [
      "an invalid plan shape",
      "```json\n{\"schema\":\"openthrottle.execution-plan/v2\",\"pipeline_id\":\"core/structured\"}\n```",
    ],
    [
      "a plan for another pipeline",
      `\`\`\`json\n${JSON.stringify({ ...structuredPlan, pipeline_id: "core/implement" })}\n\`\`\``,
    ],
    [
      "a schema mention outside a fence",
      'The prose says {"schema":"openthrottle.execution-plan/v2"}.',
    ],
  ])("does not promote %s after Linear prompt normalization", (_label, promptContext) => {
    const prompt = linearAdmissionPrompt({
      event_kind: "linear/agent-session-event/created@1",
      title: "Ordinary task",
      description: "Keep admission authoritative.",
      payload: { promptContext },
    });

    expect(selectKernelInboxPipeline([], prompt)).toBe("core/admission");
  });

  it("uses the activity body for a no-run Linear prompt", () => {
    const prompt = linearAdmissionPrompt({
      event_kind: "linear/agent-session-event/prompted@1",
      title: "Execute the accepted plan",
      description: "Use the exact bounded units.",
      payload: {
        promptContext: "Stale context must not replace the prompted directive.",
        agentActivity: {
          id: "activity-1",
          body: "Fallback body must not replace content.body.",
          content: { body: structuredPlanBlock() },
        },
      },
    });

    expect(prompt).toContain("```json openthrottle.execution-plan/v2\n");
    expect(prompt).not.toContain("Stale context");
    expect(prompt).not.toContain("Fallback body");
    expect(selectKernelInboxPipeline([], prompt)).toBe("core/structured");
  });

  it("keeps created-session prompt context authoritative over activity content", () => {
    const prompt = linearAdmissionPrompt({
      event_kind: "linear/agent-session-event/created@1",
      title: "Created session",
      description: "Use the created-session context.",
      payload: {
        promptContext: "Created-session directive.",
        agentActivity: { id: "activity-1", body: "Unrelated activity body." },
      },
    });

    expect(prompt).toContain("Created-session directive.");
    expect(prompt).not.toContain("Unrelated activity body.");
  });

  it("preserves the explicit investigate route", () => {
    expect(selectKernelInboxPipeline(["Investigate"], "Diagnose the failure.")).toBe("core/investigate");
  });
});

describe("KernelAdmissionInboxHandler", () => {
  it("acknowledges a new Linear session before repository admission work", async () => {
    const registration = {
      id: "registration-linear",
      control_provider: "linear" as const,
      route_key: "team-linear",
      linear_team_id: "team-linear",
      linear_team_key: "OPE",
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
      findGithubRoute: () => undefined,
      findLinearRoute: () => registration,
      list: () => [registration],
      put: () => { throw new Error("not used"); },
    } satisfies KernelRepositoryRegistrationPort;
    const ensureStarted = vi.fn(async () => {});
    const read = vi.fn(async () => {
      throw new Error("stop after session acknowledgement");
    });
    const event: KernelInboxEvent = {
      id: "inbox-linear",
      source_provider: "linear",
      delivery_id: "delivery-linear",
      kind: "linear/agent-session-event/created@1",
      work_item_id: null,
      pipeline_run_id: null,
      attempt_id: null,
      generation: 0,
      event_group_key: "linear:webhook-linear",
      delivery_attempt: 1,
      subject: "a".repeat(40),
      payload_hash: "b".repeat(64),
      payload_schema: "openthrottle.provider-event/linear/v1",
      payload: {
        type: "AgentSessionEvent",
        action: "created",
        webhookId: "webhook-linear",
        agentSession: {
          id: "session-linear",
          issue: {
            id: "issue-linear",
            identifier: "OPE-193",
            title: "Fix the failed start",
            team: { id: "team-linear", key: "OPE" },
          },
        },
      },
      status: "processing",
      available_at: "2026-08-20T12:00:00.000Z",
      lease_id: "lease-linear",
      lease_owner_id: "worker-1",
      lease_expires_at: "2026-08-20T12:02:00.000Z",
      version: 1,
      created_at: "2026-08-20T12:00:00.000Z",
      consumed_at: null,
    };
    const handler = new KernelAdmissionInboxHandler({
      registrations,
      github_token: "token",
      source_reader: { read } as never,
      platform: {} as never,
      compiler_environment: {} as never,
      runtime: {} as never,
      blob_store: {} as never,
      store: {} as never,
      linear_session_start: { ensureStarted },
    });

    await expect(handler.handle(event)).rejects.toThrow("stop after session acknowledgement");
    expect(ensureStarted).toHaveBeenCalledWith({
      inbox_event_id: "inbox-linear",
      webhook_id: "webhook-linear",
      session_id: "session-linear",
    });
    expect(ensureStarted.mock.invocationCallOrder[0])
      .toBeLessThan(read.mock.invocationCallOrder[0]!);
  });

  it("acknowledges a new Linear session for an issue that already has a run", async () => {
    const ensureStarted = vi.fn(async () => {});
    const read = vi.fn();
    const registrations = {
      resolveRun: () => ({
        pipeline_run_id: "run-existing",
        work_item_id: "work-existing",
        source_provider: "linear",
        source_reference: "OPE-193",
      }),
      findGithubRoute: () => undefined,
      findLinearRoute: () => ({
        id: "registration-linear",
        github_repo: "owner/repo",
        base_branch: "main",
      }),
    } as unknown as KernelRepositoryRegistrationPort;
    const event = {
      id: "inbox-linear-new-session",
      source_provider: "linear",
      delivery_id: "delivery-linear-new-session",
      kind: "linear/agent-session-event/created@1",
      work_item_id: null,
      pipeline_run_id: null,
      attempt_id: null,
      generation: 0,
      event_group_key: "linear:webhook-linear-new-session",
      delivery_attempt: 1,
      subject: null,
      payload_hash: "c".repeat(64),
      payload_schema: "openthrottle.provider-event/linear/v1",
      payload: {
        type: "AgentSessionEvent",
        action: "created",
        webhookId: "webhook-linear-new-session",
        agentSession: {
          id: "session-linear-new",
          issue: {
            id: "issue-linear",
            identifier: "OPE-193",
            title: "Continue the existing work",
            team: { id: "team-linear", key: "OPE" },
          },
        },
      },
      status: "processing",
      available_at: "2026-08-20T12:00:00.000Z",
      lease_id: "lease-linear-new-session",
      lease_owner_id: "worker-1",
      lease_expires_at: "2026-08-20T12:02:00.000Z",
      version: 1,
      created_at: "2026-08-20T12:00:00.000Z",
      consumed_at: null,
    } satisfies KernelInboxEvent;
    const handler = new KernelAdmissionInboxHandler({
      registrations,
      github_token: "token",
      source_reader: { read } as never,
      platform: {} as never,
      compiler_environment: {} as never,
      runtime: {} as never,
      blob_store: {} as never,
      store: {} as never,
      linear_session_start: { ensureStarted },
    });

    await expect(handler.handle(event)).resolves.toBe("consumed");
    expect(ensureStarted).toHaveBeenCalledWith({
      inbox_event_id: "inbox-linear-new-session",
      webhook_id: "webhook-linear-new-session",
      session_id: "session-linear-new",
    });
    expect(read).not.toHaveBeenCalled();
  });

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
