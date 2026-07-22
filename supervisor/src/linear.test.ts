import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  agentActivityCreate,
  agentSessionUpdate,
  buildLinearInstallUrl,
  extractLabelNames,
  fetchIssueLabels,
  isRecentLinearWebhook,
  labelMatchNames,
  linearFileUpload,
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

    // A "stop" interrupt (Linear's composer stop / force-send button) can
    // arrive with no body and with the signal delivered as an object rather
    // than a bare string. It must parse (never 4xx) and normalize to "stop"
    // so handlePrompted routes it to stopTicket.
    const stopObject = parseLinearWebhook(
      JSON.stringify({
        ...createdPayload,
        action: "prompted",
        agentActivity: { id: "activity-2", signal: { type: "STOP" } },
      })
    );
    expect(stopObject.agentActivity?.signal).toBe("stop");
    const stopString = parseLinearWebhook(
      JSON.stringify({
        ...createdPayload,
        action: "prompted",
        agentActivity: { id: "activity-3", signal: "stop" },
      })
    );
    expect(stopString.agentActivity?.signal).toBe("stop");
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
      id: "11111111-1111-4111-8111-111111111111",
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
          id: "11111111-1111-4111-8111-111111111111",
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

  it("fetches issue labels with their parent group and expands grouped names", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        data: {
          issue: {
            labels: {
              nodes: [
                { name: "feature/x", parent: { name: "branch" } },
                { name: "investigate", parent: null },
                { name: "bad" },
              ],
            },
          },
        },
      });
    }) as unknown as typeof fetch;

    const resolved = await fetchIssueLabels({ accessToken: "oauth", fetch: fetchMock }, "issue-1");
    expect(resolved).toEqual([
      { name: "feature/x", parentName: "branch" },
      { name: "investigate", parentName: undefined },
      { name: "bad", parentName: undefined },
    ]);
    expect(requests[0]).toMatchObject({ variables: { id: "issue-1" } });

    expect(labelMatchNames(resolved)).toEqual([
      "feature/x",
      "branch › feature/x",
      "investigate",
      "bad",
    ]);
  });

  it("tolerates an issue with no labels", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: { issue: { labels: { nodes: [] } } } })
    ) as unknown as typeof fetch;
    expect(await fetchIssueLabels({ accessToken: "oauth", fetch: fetchMock }, "issue-2")).toEqual([]);
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

  it("obtains a private upload target and uploads without forwarding Linear authorization", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: string }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("Authorization"),
        body: String(init?.body ?? ""),
      });
      if (String(input) === "https://uploads.linear.test/put") {
        expect(headers.get("Content-Type")).toBe("application/json");
        expect(headers.get("x-upload-token")).toBe("opaque");
        return new Response(null, { status: 200 });
      }
      return Response.json({ data: { fileUpload: { success: true, uploadFile: {
        uploadUrl: "https://uploads.linear.test/put",
        assetUrl: "https://uploads.linear.test/private/evidence.json",
        headers: [{ key: "x-upload-token", value: "opaque" }],
      } } } });
    }) as unknown as typeof fetch;

    await expect(linearFileUpload(
      { accessToken: "oauth-secret", fetch: fetchMock },
      { filename: "evidence.json", contentType: "application/json", content: "{\"ok\":true}" }
    )).resolves.toEqual({ assetUrl: "https://uploads.linear.test/private/evidence.json" });
    expect(requests[0]?.authorization).toBe("Bearer oauth-secret");
    expect(requests[1]?.authorization).toBeNull();
  });
});
