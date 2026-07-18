import { createHmac, timingSafeEqual } from "node:crypto";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_OAUTH_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";

/**
 * Verify the `Linear-Signature` header against the raw (unparsed) request
 * body using HMAC-SHA256, per SPEC "Supervisor contract".
 * https://linear.app/developers/webhooks — TODO(verify-linear-api): confirm
 * header name casing and hex vs base64 digest encoding against current docs.
 */
export function verifyLinearSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  webhookSecret: string
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

// ---------------------------------------------------------------------------
// Webhook payload shapes (Linear Agent API — Developer Preview).
// TODO(verify-linear-api): every field name below must be checked against
// live Linear docs/schema before first deploy; Developer Preview APIs are
// known to change field names without notice.
// ---------------------------------------------------------------------------

export interface LinearAgentSessionEventPayload {
  action: "created" | "prompted"; // TODO(verify-linear-api): confirm exact action enum values
  type?: string; // e.g. "AgentSessionEvent" — TODO(verify-linear-api)
  agentSession: {
    id: string; // TODO(verify-linear-api): agent session id field name
    issue?: {
      id: string;
      identifier: string;
      labels?: { nodes?: { name: string }[] }; // TODO(verify-linear-api): label shape on issue
    };
  };
  agentActivity?: {
    id?: string;
    body?: string; // human message content for "prompted" events — TODO(verify-linear-api)
    content?: { body?: string };
  };
  webhookTimestamp?: number;
  organizationId?: string;
}

export function parseLinearWebhook(raw: string): LinearAgentSessionEventPayload {
  return JSON.parse(raw) as LinearAgentSessionEventPayload;
}

/** Extract label names from the webhook payload, used for agent routing (agent:codex). */
export function extractLabelNames(
  payload: LinearAgentSessionEventPayload
): string[] {
  // TODO(verify-linear-api): confirm issue.labels shape in the AgentSessionEvent payload.
  return payload.agentSession.issue?.labels?.nodes?.map((n) => n.name) ?? [];
}

// ---------------------------------------------------------------------------
// GraphQL client
// ---------------------------------------------------------------------------

export interface LinearClient {
  accessToken: string;
}

async function linearGraphQL<T>(
  client: LinearClient,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const res = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // TODO(verify-linear-api): OAuth app tokens are typically sent as a
      // bare token (no "Bearer " prefix) per Linear's older docs, but this
      // must be reconfirmed for actor=app tokens specifically.
      Authorization: client.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await res.json()) as { data?: T; errors?: unknown[] };
  if (!res.ok || json.errors) {
    throw new Error(
      `Linear GraphQL error (${res.status}): ${JSON.stringify(json.errors ?? json)}`
    );
  }
  if (!json.data) {
    throw new Error("Linear GraphQL response missing data");
  }
  return json.data;
}

export type AgentActivityType =
  | "thought"
  | "action"
  | "elicitation"
  | "response"
  | "error";

/**
 * Post an activity into an agent session.
 * Mutation name and input shape per SPEC: `agentActivityCreate` with types
 * thought/action/elicitation/response/error.
 * TODO(verify-linear-api): confirm `AgentActivityCreateInput` field names
 * (agentSessionId vs sessionId, content union shape, whether "action" type
 * takes an extra `action`/`parameter`/`result` sub-fields) against the
 * Linear Agent API (Developer Preview) schema before first deploy.
 */
export async function agentActivityCreate(
  client: LinearClient,
  params: { sessionId: string; type: AgentActivityType; body: string }
): Promise<{ success: boolean }> {
  const mutation = `
    mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) {
        success
        agentActivity {
          id
        }
      }
    }
  `;
  // TODO(verify-linear-api): confirm whether `content` is a discriminated
  // union `{ type: "thought", body: "..." }` (used here) or nested fields
  // like `{ thought: { body: "..." } }`.
  const variables = {
    input: {
      agentSessionId: params.sessionId,
      content: {
        type: params.type,
        body: params.body,
      },
    },
  };
  try {
    const data = await linearGraphQL<{
      agentActivityCreate: { success: boolean };
    }>(client, mutation, variables);
    return data.agentActivityCreate;
  } catch (err) {
    // Never throw out of activity posting into caller's critical path if
    // avoidable — callers still decide what to do, but log defensively here.
    console.error("[linear] agentActivityCreate failed:", err);
    throw err;
  }
}

/**
 * Attach a PR / external link and optionally update state on an agent
 * session. TODO(verify-linear-api): confirm `agentSessionUpdate` mutation
 * exists with this shape — SPEC says "attach PR/external links" but the
 * exact input fields (externalUrl vs url, label) are unverified.
 */
export async function agentSessionUpdate(
  client: LinearClient,
  params: { sessionId: string; externalUrl?: string; externalUrlLabel?: string }
): Promise<{ success: boolean }> {
  const mutation = `
    mutation AgentSessionUpdate($input: AgentSessionUpdateInput!) {
      agentSessionUpdate(input: $input) {
        success
      }
    }
  `;
  const variables = {
    input: {
      agentSessionId: params.sessionId,
      // TODO(verify-linear-api): confirm field name(s) for attaching a link
      externalUrl: params.externalUrl,
      externalUrlLabel: params.externalUrlLabel,
    },
  };
  const data = await linearGraphQL<{ agentSessionUpdate: { success: boolean } }>(
    client,
    mutation,
    variables
  );
  return data.agentSessionUpdate;
}

/** Post a plain comment on an issue (used by sweep for expiry notices). */
export async function commentCreate(
  client: LinearClient,
  params: { issueId: string; body: string }
): Promise<{ success: boolean }> {
  const mutation = `
    mutation CommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
      }
    }
  `;
  const variables = { input: { issueId: params.issueId, body: params.body } };
  const data = await linearGraphQL<{ commentCreate: { success: boolean } }>(
    client,
    mutation,
    variables
  );
  return data.commentCreate;
}

// ---------------------------------------------------------------------------
// OAuth (actor=app flow)
// https://linear.app/developers/agents — TODO(verify-linear-api): confirm
// scope list and that `actor=app` is a query param on the authorize URL
// (vs a form field on the token exchange).
// ---------------------------------------------------------------------------

export function buildLinearInstallUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(LINEAR_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  // TODO(verify-linear-api): confirm required scopes for agent apps
  url.searchParams.set("scope", "app:mentionable,read,write");
  url.searchParams.set("actor", "app");
  url.searchParams.set("state", params.state);
  return url.toString();
}

export interface LinearOAuthTokenResponse {
  access_token: string;
  token_type: string;
  scope?: string;
  expires_in?: number; // TODO(verify-linear-api): confirm app-actor tokens are long-lived / non-expiring
}

export async function exchangeLinearOAuthCode(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<LinearOAuthTokenResponse> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    code: params.code,
    grant_type: "authorization_code",
  });
  const res = await fetch(LINEAR_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Linear OAuth token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as LinearOAuthTokenResponse;
}
