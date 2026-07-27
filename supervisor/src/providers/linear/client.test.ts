import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  agentActivityCreate,
  agentSessionUpdate,
  buildLinearInstallUrl,
  findIssueCommentByMarker,
  issueStateUpdate,
  linearFileUpload,
} from "./client.js";
import {
  fetchIssueLabels,
  isRecentLinearWebhook,
  parseLinearWebhook,
  verifyLinearSignature,
} from "./events.js";

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
    expect(parsed.agentSession.issue?.labels).toEqual([
      { name: "agent:codex" },
      { name: "investigate" },
    ]);
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
      parseLinearWebhook(JSON.stringify({
        ...parsed,
        agentSession: {
          ...parsed.agentSession,
          issue: { ...parsed.agentSession.issue!, labels: { nodes: [{ name: "backend" }] } },
        },
      })).agentSession.issue?.labels
    ).toEqual({ nodes: [{ name: "backend" }] });
  });

  it("sends exact activity and session-update GraphQL variables", async () => {
    const requests: Array<{ query?: string; variables?: { id?: string; stateId?: string } }> = [];
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

  it("fetches issue labels with their parent group", async () => {
    const requests: Array<{ query?: string }> = [];
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
  });

  it("moves issues forward by workflow state type and caches team states", async () => {
    const requests: Array<{ query?: string; variables?: { id?: string; stateId?: string } }> = [];
    let currentState = { id: "backlog", name: "Backlog", type: "backlog" };
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        query?: string;
        variables?: { id?: string; stateId?: string };
      };
      requests.push(request);
      if (request.query?.includes("IssueWorkflowState")) {
        return Response.json({
          data: {
            issue: {
              id: request.variables?.id,
              state: currentState,
              team: { id: "team-1" },
            },
          },
        });
      }
      if (request.query?.includes("TeamWorkflowStates")) {
        return Response.json({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "backlog", name: "Backlog", type: "backlog" },
                  { id: "todo", name: "Todo", type: "unstarted" },
                  { id: "progress", name: "In Progress", type: "started" },
                  { id: "review", name: "In Review", type: "started" },
                  { id: "done", name: "Done", type: "completed" },
                  { id: "canceled", name: "Canceled", type: "canceled" },
                ],
              },
            },
          },
        });
      }
      if (request.query?.includes("IssueStateUpdate")) {
        currentState = request.variables?.stateId === "done"
          ? { id: "done", name: "Done", type: "completed" }
          : request.variables?.stateId === "review"
            ? { id: "review", name: "In Review", type: "started" }
            : { id: "progress", name: "In Progress", type: "started" };
        return Response.json({
          data: {
            issueUpdate: {
              success: true,
              issue: { id: "issue-1", state: currentState },
            },
          },
        });
      }
      throw new Error("unexpected Linear request");
    }) as unknown as typeof fetch;
    const client = { accessToken: "oauth", fetch: fetchMock };

    await issueStateUpdate(client, { issueId: "issue-1", signal: "started" });
    await issueStateUpdate(client, { issueId: "issue-1", signal: "review" });
    await issueStateUpdate(client, { issueId: "issue-1", signal: "completed" });

    expect(requests.filter((request) => request.query?.includes("TeamWorkflowStates"))).toHaveLength(1);
    expect(requests.filter((request) => request.query?.includes("IssueStateUpdate"))
      .map((request) => request.variables?.stateId)).toEqual(["progress", "review", "done"]);
  });

  it("does not clobber terminal or already-at-review issue states", async () => {
    const states = [
      { id: "progress", name: "In Progress", type: "started" },
      { id: "review", name: "In Review", type: "started" },
      { id: "done", name: "Done", type: "completed" },
      { id: "canceled", name: "Canceled", type: "canceled" },
    ];
    const requests: Array<{ query?: string }> = [];
    let currentState = states[1]!;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query?: string };
      requests.push(request);
      if (request.query?.includes("IssueWorkflowState")) {
        return Response.json({
          data: { issue: { id: "issue-1", state: currentState, team: { id: "team-1" } } },
        });
      }
      if (request.query?.includes("TeamWorkflowStates")) {
        return Response.json({ data: { team: { states: { nodes: states } } } });
      }
      if (request.query?.includes("IssueStateUpdate")) throw new Error("should not update");
      throw new Error("unexpected Linear request");
    }) as unknown as typeof fetch;
    const client = { accessToken: "oauth", fetch: fetchMock };

    await expect(issueStateUpdate(client, { issueId: "issue-1", signal: "review" }))
      .resolves.toMatchObject({ skipped: true });
    currentState = states[3]!;
    await expect(issueStateUpdate(client, { issueId: "issue-1", signal: "started" }))
      .resolves.toMatchObject({ skipped: true });

    expect(requests.filter((request) => request.query?.includes("IssueStateUpdate"))).toHaveLength(0);
  });

  it("paginates issue comments until it finds a marker", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(request);
      const after = (request.variables as { after?: string | null }).after;
      return Response.json({
        data: {
          issue: {
            comments: after
              ? {
                  nodes: [{
                    id: "comment-2",
                    body: "second <!-- marker -->",
                    url: "https://linear.test/comment/2",
                    user: { id: "app-user", app: true, isMe: true },
                  }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                }
              : {
                  nodes: [{ id: "comment-1", body: "first", url: "https://linear.test/comment/1" }],
                  pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                },
          },
        },
      });
    }) as unknown as typeof fetch;

    await expect(findIssueCommentByMarker({ accessToken: "oauth", fetch: fetchMock }, "issue-1", "<!-- marker -->"))
      .resolves.toEqual({
        id: "comment-2",
        body: "second <!-- marker -->",
        url: "https://linear.test/comment/2",
        user: { id: "app-user", app: true, isMe: true },
      });
    expect(requests.map((request) => (request.variables as { after?: string | null }).after))
      .toEqual([null, "cursor-1"]);
  });

  it("ignores marked comments that were not created by the current app user", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: {
          issue: {
            comments: {
              nodes: [
                {
                  id: "foreign-user",
                  body: "copied <!-- marker -->",
                  url: "https://linear.test/comment/foreign-user",
                  user: { id: "user-1", app: false, isMe: false },
                },
                {
                  id: "foreign-app",
                  body: "other app <!-- marker -->",
                  url: "https://linear.test/comment/foreign-app",
                  user: { id: "app-2", app: true, isMe: false },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      })
    ) as unknown as typeof fetch;

    await expect(findIssueCommentByMarker({ accessToken: "oauth", fetch: fetchMock }, "issue-1", "<!-- marker -->"))
      .resolves.toBeUndefined();
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
