import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  agentActivityCreate,
  agentSessionUpdate,
  buildLinearInstallUrl,
  extractLabelNames,
  isRecentLinearWebhook,
  parseLinearWebhook,
  verifyLinearSignature,
} from "./linear.js";

const createdPayload = {
  action: "created",
  type: "AgentSessionEvent",
  webhookId: "delivery-1",
  webhookTimestamp: 1_750_000_000_000,
  organizationId: "org-1",
  agentSession: {
    id: "session-1",
    issue: {
      id: "issue-1",
      identifier: "OT-1",
      labels: [{ name: "agent:codex" }, { name: "investigate" }],
    },
  },
} as const;

describe("Linear contracts", () => {
  it("verifies the documented hex HMAC and timestamp window", () => {
    const raw = JSON.stringify(createdPayload);
    const signature = createHmac("sha256", "secret").update(raw).digest("hex");
    expect(verifyLinearSignature(raw, signature, "secret")).toBe(true);
    expect(verifyLinearSignature(`${raw}x`, signature, "secret")).toBe(false);
    expect(verifyLinearSignature(raw, "not-hex", "secret")).toBe(false);
    expect(isRecentLinearWebhook(1_000_000, 60, 1_059_999)).toBe(true);
    expect(isRecentLinearWebhook(1_000_000, 60, 1_060_001)).toBe(false);
  });

  it("validates created and prompted payloads and both label encodings", () => {
    const parsed = parseLinearWebhook(JSON.stringify(createdPayload));
    expect(extractLabelNames(parsed)).toEqual(["agent:codex", "investigate"]);
    expect(() =>
      parseLinearWebhook(JSON.stringify({ ...createdPayload, promptContext: { unsafe: true } }))
    ).toThrow("invalid promptContext");

    const prompted = parseLinearWebhook(
      JSON.stringify({
        ...createdPayload,
        action: "prompted",
        agentActivity: { id: "activity-1", content: { type: "prompt", body: "continue" } },
      })
    );
    expect(prompted.action).toBe("prompted");
    expect(() =>
      parseLinearWebhook(JSON.stringify({ ...createdPayload, action: "prompted" }))
    ).toThrow(/agentActivity/);
    expect(() =>
      parseLinearWebhook(
        JSON.stringify({
          ...createdPayload,
          agentSession: {
            ...createdPayload.agentSession,
            issue: { ...createdPayload.agentSession.issue, identifier: "OT-1'; unsafe" },
          },
        })
      )
    ).toThrow(/unsafe/);
    expect(
      extractLabelNames({
        ...parsed,
        agentSession: {
          ...parsed.agentSession,
          issue: { ...parsed.agentSession.issue!, labels: { nodes: [{ name: "legacy" }] } },
        },
      })
    ).toEqual(["legacy"]);
  });

  it("sends exact activity and session-update GraphQL variables", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      signals.push(init?.signal);
      const query = String((requests.at(-1) as { query?: string }).query);
      const data = query.includes("AgentSessionUpdate")
        ? { agentSessionUpdate: { success: true } }
        : { agentActivityCreate: { success: true, agentActivity: { id: "activity-1" } } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = { accessToken: "oauth", fetch: fetchMock };

    await agentActivityCreate(client, {
      sessionId: "session-1",
      type: "action",
      action: "Created workspace",
      parameter: "sb-1",
      result: "ready",
    });
    await agentSessionUpdate(client, {
      sessionId: "session-1",
      addedExternalUrls: [{ label: "PR", url: "https://github.com/o/r/pull/1" }],
    });

    expect(requests[0]).toMatchObject({
      variables: {
        input: {
          agentSessionId: "session-1",
          content: {
            type: "action",
            action: "Created workspace",
            parameter: "sb-1",
            result: "ready",
          },
          ephemeral: false,
        },
      },
    });
    expect(requests[1]).toMatchObject({
      variables: {
        id: "session-1",
        input: { addedExternalUrls: [{ label: "PR", url: "https://github.com/o/r/pull/1" }] },
      },
    });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("builds app-actor OAuth URLs with agent scopes", () => {
    const url = new URL(
      buildLinearInstallUrl({ clientId: "client", redirectUri: "https://ot.test/oauth/callback", state: "state" })
    );
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("scope")).toBe("read,write,app:assignable,app:mentionable");
    expect(url.searchParams.get("state")).toBe("state");
  });

  it("rejects a false mutation success result", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: { agentActivityCreate: { success: false } } })
    ) as unknown as typeof fetch;

    await expect(
      agentActivityCreate(
        { accessToken: "oauth", fetch: fetchMock },
        { sessionId: "session-1", type: "thought", body: "working" }
      )
    ).rejects.toThrow("success: false");
  });
});
