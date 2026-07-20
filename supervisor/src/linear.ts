import { createHmac, timingSafeEqual } from "node:crypto";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_OAUTH_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const HTTP_TIMEOUT_MS = 15_000;

export function verifyLinearSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  webhookSecret: string
): boolean {
  if (!signatureHeader || !/^[a-f\d]{64}$/i.test(signatureHeader)) return false;
  const expected = createHmac("sha256", webhookSecret).update(rawBody).digest();
  const actual = Buffer.from(signatureHeader, "hex");
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

export function isRecentLinearWebhook(
  webhookTimestamp: number,
  maxAgeSeconds: number,
  nowMs = Date.now()
): boolean {
  return (
    Number.isFinite(webhookTimestamp) &&
    Math.abs(nowMs - webhookTimestamp) <= maxAgeSeconds * 1000
  );
}

interface LinearIssueWebhookPayload {
  id: string;
  identifier: string;
  team?: { id?: string; key?: string; name?: string };
  labels?: Array<{ id?: string; name: string }> | { nodes?: Array<{ name: string }> };
}

export interface LinearAgentSessionEventPayload {
  action: "created" | "prompted";
  type: "AgentSessionEvent";
  webhookId: string;
  webhookTimestamp: number;
  organizationId: string;
  oauthClientId?: string;
  appUserId?: string;
  promptContext?: string;
  agentSession: {
    id: string;
    issueId?: string;
    issue?: LinearIssueWebhookPayload;
  };
  agentActivity?: {
    id: string;
    signal?: string;
    content?: { type?: string; body?: string };
    body?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Linear delivers agent-activity control signals (currently `stop`, plus the
// agent->human `auth`/`select` signals) on `agentActivity.signal`. The docs
// describe a string enum, but the wire payload can arrive as an object, so
// accept either shape and reduce it to a lowercase signal name. Unknown shapes
// reduce to `undefined` (handled as an ordinary prompt) rather than rejecting
// the whole webhook — a reject would drop the user's interrupt and make Linear
// retry, then disable, the endpoint.
function normalizeSignal(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    return value === "" ? undefined : value;
  }
  if (isRecord(raw)) {
    const candidate = raw.type ?? raw.name ?? raw.signal ?? raw.value;
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim().toLowerCase();
    }
  }
  return undefined;
}

export function parseLinearWebhook(raw: string): LinearAgentSessionEventPayload {
  const payload: unknown = JSON.parse(raw);
  if (!isRecord(payload)) throw new Error("Linear webhook body must be an object");
  if (payload.type !== "AgentSessionEvent") {
    throw new Error(`Unexpected Linear webhook type: ${String(payload.type)}`);
  }
  if (payload.action !== "created" && payload.action !== "prompted") {
    throw new Error(`Unexpected Linear agent action: ${String(payload.action)}`);
  }
  if (!isRecord(payload.agentSession) || typeof payload.agentSession.id !== "string") {
    throw new Error("Linear webhook is missing agentSession.id");
  }
  if (payload.agentSession.issue !== undefined) {
    if (!isRecord(payload.agentSession.issue)) {
      throw new Error("Linear webhook has invalid agentSession.issue");
    }
    const issue = payload.agentSession.issue;
    if (typeof issue.id !== "string" || issue.id === "") {
      throw new Error("Linear webhook is missing agentSession.issue.id");
    }
    if (
      typeof issue.identifier !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(issue.identifier)
    ) {
      throw new Error("Linear webhook has an unsafe agentSession.issue.identifier");
    }
  }
  if (typeof payload.webhookId !== "string" || typeof payload.webhookTimestamp !== "number") {
    throw new Error("Linear webhook is missing webhookId/webhookTimestamp");
  }
  if (typeof payload.organizationId !== "string") {
    throw new Error("Linear webhook is missing organizationId");
  }
  if (payload.promptContext !== undefined && typeof payload.promptContext !== "string") {
    throw new Error("Linear webhook has invalid promptContext");
  }
  if (payload.action === "prompted") {
    if (!isRecord(payload.agentActivity) || typeof payload.agentActivity.id !== "string") {
      throw new Error("Prompted webhook is missing agentActivity.id");
    }
    const rawSignal = payload.agentActivity.signal;
    if (rawSignal !== undefined && typeof rawSignal !== "string") {
      // Parsing happens before durable storage, so a rejected payload is never
      // saved — log the exact shape once so Linear's wire format can be
      // confirmed from the supervisor logs.
      console.warn("[linear] non-string agentActivity.signal:", JSON.stringify(rawSignal));
    }
    const signal = normalizeSignal(rawSignal);
    // Normalize in place so downstream handlers see a plain lowercase string.
    payload.agentActivity.signal = signal;
    const body = isRecord(payload.agentActivity.content)
      ? payload.agentActivity.content.body
      : payload.agentActivity.body;
    if (signal !== "stop" && (typeof body !== "string" || body.trim() === "")) {
      throw new Error("Prompted webhook is missing agentActivity.body");
    }
  }
  return payload as unknown as LinearAgentSessionEventPayload;
}

export function extractLabelNames(payload: LinearAgentSessionEventPayload): string[] {
  const labels = payload.agentSession.issue?.labels;
  if (Array.isArray(labels)) return labels.map((label) => label.name);
  return labels?.nodes?.map((label) => label.name) ?? [];
}

export interface ResolvedLabel {
  name: string;
  parentName?: string;
}

// The webhook payload carries only each label's leaf name, so a Linear label
// *group* (e.g. a "branch" group containing a "feature/x" child) arrives as the
// bare leaf with no way to know its group. This reads the issue's labels with
// their parent group from Linear, letting grouped labels drive routing.
export async function fetchIssueLabels(
  client: LinearClient,
  issueId: string
): Promise<ResolvedLabel[]> {
  const data = await linearGraphQL<{
    issue?: { labels?: { nodes?: Array<{ name?: string; parent?: { name?: string } | null }> } };
  }>(
    client,
    `query IssueLabels($id: String!) {
      issue(id: $id) {
        labels { nodes { name parent { name } } }
      }
    }`,
    { id: issueId }
  );
  const nodes = data.issue?.labels?.nodes ?? [];
  const resolved: ResolvedLabel[] = [];
  for (const node of nodes) {
    if (typeof node?.name !== "string") continue;
    resolved.push({
      name: node.name,
      parentName: typeof node.parent?.name === "string" ? node.parent.name : undefined,
    });
  }
  return resolved;
}

// Expand resolved labels into the flat strings the label parsers match: each
// leaf name, plus a "<group> › <leaf>" form for grouped labels so a Linear
// label group resolves exactly like a flat "<group> › <leaf>" label.
export function labelMatchNames(labels: ResolvedLabel[]): string[] {
  const names: string[] = [];
  for (const label of labels) {
    names.push(label.name);
    if (label.parentName) names.push(`${label.parentName} › ${label.name}`);
  }
  return names;
}

export interface LinearClient {
  accessToken: string;
  fetch?: typeof fetch;
}

async function linearGraphQL<T>(
  client: LinearClient,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const fetchImpl = client.fetch ?? fetch;
  const response = await fetchImpl(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${client.accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const json = (await response.json()) as { data?: T; errors?: unknown[] };
  if (!response.ok || json.errors?.length) {
    throw new Error(
      `Linear GraphQL error (${response.status}): ${JSON.stringify(json.errors ?? json)}`
    );
  }
  if (!json.data) throw new Error("Linear GraphQL response missing data");
  return json.data;
}

export type AgentActivityInput =
  | {
      id?: string;
      sessionId: string;
      type: "thought" | "elicitation" | "response" | "error";
      body: string;
      ephemeral?: boolean;
    }
  | {
      id?: string;
      sessionId: string;
      type: "action";
      action: string;
      parameter: string;
      result?: string;
      ephemeral?: boolean;
    };

export async function agentActivityCreate(
  client: LinearClient,
  params: AgentActivityInput
): Promise<{ success: boolean; agentActivity?: { id: string } }> {
  const content =
    params.type === "action"
      ? {
          type: params.type,
          action: params.action,
          parameter: params.parameter,
          ...(params.result === undefined ? {} : { result: params.result }),
        }
      : { type: params.type, body: params.body };
  const data = await linearGraphQL<{
    agentActivityCreate: { success: boolean; agentActivity?: { id: string } };
  }>(
    client,
    `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) {
        success
        agentActivity { id }
      }
    }`,
    {
      input: {
        ...(params.id ? { id: params.id } : {}),
        agentSessionId: params.sessionId,
        content,
        ephemeral: params.ephemeral ?? false,
      },
    }
  );
  if (!data.agentActivityCreate.success) {
    throw new Error("Linear agentActivityCreate returned success: false");
  }
  return data.agentActivityCreate;
}

// A session-level plan is an ordered checklist Linear renders in the agent
// session UI; agents replace it in full on each update (Linear has no
// per-item patch). Used to surface "which gate is done / in progress" live.
export type AgentPlanStatus = "pending" | "inProgress" | "completed" | "canceled";
export interface AgentPlanItem {
  content: string;
  status: AgentPlanStatus;
}

export async function agentSessionUpdate(
  client: LinearClient,
  params: {
    sessionId: string;
    externalUrls?: Array<{ label: string; url: string }>;
    addedExternalUrls?: Array<{ label: string; url: string }>;
    plan?: AgentPlanItem[];
  }
): Promise<{ success: boolean }> {
  const data = await linearGraphQL<{ agentSessionUpdate: { success: boolean } }>(
    client,
    `mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
      agentSessionUpdate(id: $id, input: $input) { success }
    }`,
    {
      id: params.sessionId,
      input: {
        ...(params.externalUrls ? { externalUrls: params.externalUrls } : {}),
        ...(params.addedExternalUrls ? { addedExternalUrls: params.addedExternalUrls } : {}),
        ...(params.plan ? { plan: params.plan } : {}),
      },
    }
  );
  if (!data.agentSessionUpdate.success) {
    throw new Error("Linear agentSessionUpdate returned success: false");
  }
  return data.agentSessionUpdate;
}

export async function commentCreate(
  client: LinearClient,
  params: { issueId: string; body: string }
): Promise<{ success: boolean }> {
  const data = await linearGraphQL<{ commentCreate: { success: boolean } }>(
    client,
    `mutation CommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }`,
    { input: { issueId: params.issueId, body: params.body } }
  );
  if (!data.commentCreate.success) {
    throw new Error("Linear commentCreate returned success: false");
  }
  return data.commentCreate;
}

export function buildLinearInstallUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(LINEAR_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "read,write,app:assignable,app:mentionable");
  url.searchParams.set("actor", "app");
  url.searchParams.set("state", params.state);
  return url.toString();
}

export interface LinearOAuthTokenResponse {
  access_token: string;
  token_type: string;
  scope?: string | string[];
  expires_in?: number;
  refresh_token?: string;
}

async function exchangeToken(body: URLSearchParams): Promise<LinearOAuthTokenResponse> {
  const response = await fetch(LINEAR_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Linear OAuth token exchange failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as LinearOAuthTokenResponse;
}

export function exchangeLinearOAuthCode(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<LinearOAuthTokenResponse> {
  return exchangeToken(
    new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      code: params.code,
      grant_type: "authorization_code",
    })
  );
}

export function refreshLinearOAuthToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<LinearOAuthTokenResponse> {
  return exchangeToken(
    new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      refresh_token: params.refreshToken,
      grant_type: "refresh_token",
    })
  );
}
