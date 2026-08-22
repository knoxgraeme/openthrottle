import { describe, expect, it, vi } from "vitest";
import { createLinearSessionStartProvider } from "./session-start.js";

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_API_URL = "https://api.linear.app/graphql";

function normalizeDocument(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const ACTIVITY_BY_ID_DOCUMENT = normalizeDocument(`
  query AgentActivityById($id: ID!) {
    agentActivities(first: 2, filter: { id: { eq: $id } }) {
      nodes { id agentSession { id } }
    }
  }
`);

const ACTIVITY_CREATE_DOCUMENT = normalizeDocument(`
  mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
    agentActivityCreate(input: $input) {
      success
      agentActivity { id agentSession { id } }
    }
  }
`);

type ActivityCreateInput = {
  id: string;
  agentSessionId: string;
  content: { type: string; body: string };
  ephemeral: boolean;
};

type LinearApiRequest =
  | {
    operation: "AgentActivityById";
    query: string;
    variables: { id: string };
  }
  | {
    operation: "AgentActivityCreate";
    query: string;
    variables: { input: ActivityCreateInput };
  };

function linearApiRequest(
  url: string | URL | Request,
  init: RequestInit | undefined,
): LinearApiRequest {
  expect(String(url)).toBe(LINEAR_API_URL);
  const parsed = JSON.parse(String(init?.body)) as {
    query?: unknown;
    variables?: unknown;
    [key: string]: unknown;
  };
  expect(Object.keys(parsed).sort()).toEqual(["query", "variables"]);
  expect(typeof parsed.query).toBe("string");
  const query = String(parsed.query);
  const document = normalizeDocument(query);

  if (document === ACTIVITY_BY_ID_DOCUMENT) {
    expect(parsed.variables).toEqual({ id: expect.stringMatching(UUID_V4) });
    return {
      operation: "AgentActivityById",
      query,
      variables: parsed.variables as { id: string },
    };
  }
  if (document === ACTIVITY_CREATE_DOCUMENT) {
    expect(parsed.variables).toEqual({
      input: {
        id: expect.stringMatching(UUID_V4),
        agentSessionId: expect.any(String),
        content: { type: "thought", body: "Spinning up a workspace…" },
        ephemeral: true,
      },
    });
    return {
      operation: "AgentActivityCreate",
      query,
      variables: parsed.variables as { input: ActivityCreateInput },
    };
  }
  throw new Error(`Unexpected Linear API operation document: ${document.slice(0, 120)}`);
}

function tokenResponse(value = "access-token", expiresIn = 3_600): Response {
  return Response.json({
    access_token: value,
    token_type: "Bearer",
    expires_in: expiresIn,
    scope: "read write",
  });
}

function activityNode(id: string, sessionId: string) {
  return { id, agentSession: { id: sessionId } };
}

describe("Linear AgentSession start provider", () => {
  it("uses one deadline, client credentials, query-before-create, and a cached token", async () => {
    const requests: Array<{
      url: string;
      init?: RequestInit;
      request?: LinearApiRequest;
    }> = [];
    let queryCount = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === LINEAR_TOKEN_URL) {
        requests.push({ url: href, init });
        return tokenResponse();
      }
      const request = linearApiRequest(url, init);
      requests.push({ url: href, init, request });
      if (request.operation === "AgentActivityById") {
        queryCount += 1;
        const id = request.variables.id;
        return Response.json({
          data: {
            agentActivities: {
              nodes: queryCount === 1 ? [] : [activityNode(id, "session-1")],
            },
          },
        });
      }
      const input = request.variables.input;
      return Response.json({
        data: {
          agentActivityCreate: {
            success: true,
            agentActivity: activityNode(input.id, input.agentSessionId),
          },
        },
      });
    }) as unknown as typeof fetch;
    const provider = createLinearSessionStartProvider({
      clientId: "client-id",
      clientSecret: "client-secret",
      fetch: fetchMock,
      deadlineMs: 4_000,
      now: () => 1_000,
    });
    const input = {
      inbox_event_id: "inbox-1",
      webhook_id: "webhook-1",
      session_id: "session-1",
    };

    await provider.ensureStarted(input);
    await provider.ensureStarted(input);

    expect(requests).toHaveLength(4);
    const tokenRequest = requests[0]!;
    expect(tokenRequest.url).toBe(LINEAR_TOKEN_URL);
    expect(tokenRequest.init?.method).toBe("POST");
    expect(new Headers(tokenRequest.init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    expect(new Headers(tokenRequest.init?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(new URLSearchParams(String(tokenRequest.init?.body)).get("grant_type")).toBe(
      "client_credentials",
    );
    expect(new URLSearchParams(String(tokenRequest.init?.body)).get("scope")).toBe("read,write");

    const firstQuery = requests[1]!;
    const mutation = requests[2]!;
    const secondQuery = requests[3]!;
    if (firstQuery.request?.operation !== "AgentActivityById") {
      throw new Error("expected the initial activity identity query");
    }
    if (mutation.request?.operation !== "AgentActivityCreate") {
      throw new Error("expected the activity creation mutation");
    }
    if (secondQuery.request?.operation !== "AgentActivityById") {
      throw new Error("expected the cached-token activity identity query");
    }
    const activityId = firstQuery.request.variables.id;
    expect(activityId).toMatch(UUID_V4);
    expect(normalizeDocument(firstQuery.request.query)).toBe(ACTIVITY_BY_ID_DOCUMENT);
    expect(normalizeDocument(mutation.request.query)).toBe(ACTIVITY_CREATE_DOCUMENT);
    expect(mutation.request.variables).toEqual({
      input: {
        id: activityId,
        agentSessionId: "session-1",
        content: { type: "thought", body: "Spinning up a workspace…" },
        ephemeral: true,
      },
    });
    expect(secondQuery.request.variables).toEqual({ id: activityId });
    expect(firstQuery.init?.signal).toBe(tokenRequest.init?.signal);
    expect(mutation.init?.signal).toBe(tokenRequest.init?.signal);
    expect(secondQuery.init?.signal).not.toBe(tokenRequest.init?.signal);
    expect(new Headers(firstQuery.init?.headers).get("authorization")).toBe(
      "Bearer access-token",
    );
  });

  it("derives the activity UUID from every immutable identity component", async () => {
    const activityIds: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === LINEAR_TOKEN_URL) return tokenResponse();
      const request = linearApiRequest(url, init);
      if (request.operation === "AgentActivityById") {
        return Response.json({ data: { agentActivities: { nodes: [] } } });
      }
      const input = request.variables.input;
      activityIds.push(input.id);
      return Response.json({
        data: {
          agentActivityCreate: {
            success: true,
            agentActivity: activityNode(input.id, input.agentSessionId),
          },
        },
      });
    }) as unknown as typeof fetch;
    const provider = createLinearSessionStartProvider({
      clientId: "client-id",
      clientSecret: "client-secret",
      fetch: fetchMock,
    });

    await provider.ensureStarted({
      inbox_event_id: "inbox-1",
      webhook_id: "webhook-1",
      session_id: "session-1",
    });
    await provider.ensureStarted({
      inbox_event_id: "inbox-2",
      webhook_id: "webhook-1",
      session_id: "session-1",
    });
    await provider.ensureStarted({
      inbox_event_id: "inbox-1",
      webhook_id: "webhook-2",
      session_id: "session-1",
    });
    await provider.ensureStarted({
      inbox_event_id: "inbox-1",
      webhook_id: "webhook-1",
      session_id: "session-2",
    });

    expect(activityIds).toHaveLength(4);
    expect(new Set(activityIds)).toHaveLength(4);
    expect(activityIds.every((id) => UUID_V4.test(id))).toBe(true);
  });

  it("fails closed when a pre-existing deterministic activity belongs to another session", async () => {
    let mutationCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === LINEAR_TOKEN_URL) return tokenResponse();
      const request = linearApiRequest(url, init);
      if (request.operation === "AgentActivityById") {
        return Response.json({
          data: {
            agentActivities: {
              nodes: [activityNode(request.variables.id, "another-session")],
            },
          },
        });
      }
      mutationCalls += 1;
      return Response.json({ data: { agentActivityCreate: { success: true } } });
    }) as unknown as typeof fetch;
    const provider = createLinearSessionStartProvider({
      clientId: "client-id",
      clientSecret: "client-secret",
      fetch: fetchMock,
    });

    await expect(provider.ensureStarted({
      inbox_event_id: "inbox-1",
      webhook_id: "webhook-1",
      session_id: "session-1",
    })).rejects.toThrow(/activity identity conflict/i);
    expect(mutationCalls).toBe(0);
  });

  it("reserves a live final reconciliation signal after an aborted mutation", async () => {
    const deadlineMs = 400;
    let activityCreated = false;
    let queryCount = 0;
    let finalSignalWasLive = false;
    const querySignals: AbortSignal[] = [];
    const mutationSignals: AbortSignal[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === LINEAR_TOKEN_URL) return tokenResponse();
      const request = linearApiRequest(url, init);
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error("expected a bounded request signal");
      if (request.operation === "AgentActivityById") {
        queryCount += 1;
        querySignals.push(signal);
        if (queryCount === 2) finalSignalWasLive = !signal.aborted;
        return Response.json({
          data: {
            agentActivities: {
              nodes: activityCreated
                ? [activityNode(request.variables.id, "session-1")]
                : [],
            },
          },
        });
      }
      mutationSignals.push(signal);
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          activityCreated = true;
          reject(signal.reason ?? new Error("mutation aborted"));
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }) as unknown as typeof fetch;
    const provider = createLinearSessionStartProvider({
      clientId: "client-id",
      clientSecret: "client-secret",
      fetch: fetchMock,
      deadlineMs,
    });

    const startedAt = Date.now();
    await expect(provider.ensureStarted({
      inbox_event_id: "inbox-1",
      webhook_id: "webhook-1",
      session_id: "session-1",
    })).resolves.toBeUndefined();
    const elapsedMs = Date.now() - startedAt;

    expect(queryCount).toBe(2);
    expect(mutationSignals).toHaveLength(1);
    expect(mutationSignals[0]!.aborted).toBe(true);
    expect(querySignals).toHaveLength(2);
    expect(querySignals[0]).toBe(mutationSignals[0]);
    expect(querySignals[1]).not.toBe(mutationSignals[0]);
    expect(finalSignalWasLive).toBe(true);
    expect(activityCreated).toBe(true);
    expect(elapsedMs).toBeLessThanOrEqual(deadlineMs);
  });

  it("reports an unreconciled mutation generically without exposing credentials", async () => {
    let queryCount = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === LINEAR_TOKEN_URL) {
        return tokenResponse("very-secret-access-token");
      }
      const request = linearApiRequest(url, init);
      if (request.operation === "AgentActivityById") {
        queryCount += 1;
        return Response.json({ data: { agentActivities: { nodes: [] } } });
      }
      return new Response("client-secret very-secret-access-token", { status: 502 });
    }) as unknown as typeof fetch;
    const provider = createLinearSessionStartProvider({
      clientId: "client-id",
      clientSecret: "client-secret",
      fetch: fetchMock,
    });

    let diagnostic = "";
    try {
      await provider.ensureStarted({
        inbox_event_id: "inbox-1",
        webhook_id: "webhook-1",
        session_id: "session-1",
      });
    } catch (error) {
      diagnostic = String(error);
    }
    expect(diagnostic).toMatch(/could not be reconciled/i);
    expect(diagnostic).not.toContain("client-id");
    expect(diagnostic).not.toContain("client-secret");
    expect(diagnostic).not.toContain("very-secret-access-token");
    expect(queryCount).toBe(2);
  });

  it("refreshes one cached token on 401 and replays the exact reconciliation", async () => {
    let tokenCalls = 0;
    let queryCalls = 0;
    let mutationCalls = 0;
    let activityId = "";
    const observedQueries: Array<{
      request: Extract<LinearApiRequest, { operation: "AgentActivityById" }>;
      authorization: string | null;
    }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === LINEAR_TOKEN_URL) {
        tokenCalls += 1;
        return tokenResponse(`access-token-${tokenCalls}`);
      }
      const request = linearApiRequest(url, init);
      const authorization = new Headers(init?.headers).get("authorization");
      if (request.operation === "AgentActivityById") {
        queryCalls += 1;
        observedQueries.push({ request, authorization });
        activityId ||= request.variables.id;
        if (queryCalls === 1) {
          return Response.json({ data: { agentActivities: { nodes: [] } } });
        }
        if (queryCalls === 2) return new Response(null, { status: 401 });
        return Response.json({
          data: {
            agentActivities: {
              nodes: [activityNode(request.variables.id, "session-1")],
            },
          },
        });
      }
      mutationCalls += 1;
      const input = request.variables.input;
      return Response.json({
        data: {
          agentActivityCreate: {
            success: true,
            agentActivity: activityNode(input.id, input.agentSessionId),
          },
        },
      });
    }) as unknown as typeof fetch;
    const provider = createLinearSessionStartProvider({
      clientId: "client-id",
      clientSecret: "client-secret",
      fetch: fetchMock,
      now: () => 1_000,
    });
    const input = {
      inbox_event_id: "inbox-1",
      webhook_id: "webhook-1",
      session_id: "session-1",
    };

    await provider.ensureStarted(input);
    await provider.ensureStarted(input);

    expect(tokenCalls).toBe(2);
    expect(queryCalls).toBe(3);
    expect(mutationCalls).toBe(1);
    expect(observedQueries.map(({ authorization }) => authorization)).toEqual([
      "Bearer access-token-1",
      "Bearer access-token-1",
      "Bearer access-token-2",
    ]);
    expect(normalizeDocument(observedQueries[1]!.request.query)).toBe(ACTIVITY_BY_ID_DOCUMENT);
    expect(observedQueries[1]!.request.query).toBe(observedQueries[2]!.request.query);
    expect(observedQueries[1]!.request.variables).toEqual({ id: activityId });
    expect(observedQueries[2]!.request.variables).toEqual({ id: activityId });
  });

  it("refreshes the in-memory token before its expiry window", async () => {
    let now = 1_000;
    let tokenCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === LINEAR_TOKEN_URL) {
        tokenCalls += 1;
        return tokenResponse(`access-token-${tokenCalls}`, 120);
      }
      const request = linearApiRequest(url, init);
      if (request.operation !== "AgentActivityById") {
        throw new Error("did not expect activity creation");
      }
      return Response.json({
        data: {
          agentActivities: {
            nodes: [activityNode(request.variables.id, "session-1")],
          },
        },
      });
    }) as unknown as typeof fetch;
    const provider = createLinearSessionStartProvider({
      clientId: "client-id",
      clientSecret: "client-secret",
      fetch: fetchMock,
      now: () => now,
    });
    const input = {
      inbox_event_id: "inbox-1",
      webhook_id: "webhook-1",
      session_id: "session-1",
    };

    await provider.ensureStarted(input);
    now += 30_000;
    await provider.ensureStarted(input);
    now += 40_000;
    await provider.ensureStarted(input);

    expect(tokenCalls).toBe(2);
  });

  it("cancels an oversized streamed response as soon as the byte bound is crossed", async () => {
    let pulls = 0;
    let cancelled = false;
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(32 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === LINEAR_TOKEN_URL) return tokenResponse();
      const request = linearApiRequest(url, init);
      if (request.operation !== "AgentActivityById") {
        throw new Error("did not expect activity creation");
      }
      return new Response(oversizedBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const provider = createLinearSessionStartProvider({
      clientId: "client-id",
      clientSecret: "client-secret",
      fetch: fetchMock,
    });

    await expect(provider.ensureStarted({
      inbox_event_id: "inbox-1",
      webhook_id: "webhook-1",
      session_id: "session-1",
    })).rejects.toThrow(/response exceeded its size bound/i);
    expect(pulls).toBe(3);
    expect(cancelled).toBe(true);
  });

  it.each([
    ["null", () => new Response(null, { status: 200 }), /invalid response body/i],
    [
      "invalid UTF-8",
      () => new Response(Uint8Array.of(0xff), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      /invalid JSON/i,
    ],
  ] as const)("fails closed on a %s successful response body", async (_label, response, message) => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === LINEAR_TOKEN_URL) return tokenResponse();
      const request = linearApiRequest(url, init);
      if (request.operation !== "AgentActivityById") {
        throw new Error("did not expect activity creation");
      }
      return response();
    }) as unknown as typeof fetch;
    const provider = createLinearSessionStartProvider({
      clientId: "client-id",
      clientSecret: "client-secret",
      fetch: fetchMock,
    });

    await expect(provider.ensureStarted({
      inbox_event_id: "inbox-1",
      webhook_id: "webhook-1",
      session_id: "session-1",
    })).rejects.toThrow(message);
  });
});
