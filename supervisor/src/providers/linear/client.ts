import type { ActivityPublicationInput } from "../../app/ports.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_OAUTH_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const HTTP_TIMEOUT_MS = 15_000;

export interface LinearClient {
  accessToken: string;
  cacheKey?: string;
  fetch?: typeof fetch;
}

type LinearWorkflowStateType =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

interface LinearWorkflowState {
  id: string;
  name: string;
  type: LinearWorkflowStateType | string;
}

export type ControlThreadStateSignal = "started" | "review" | "completed";

const TEAM_WORKFLOW_STATE_CACHE_TTL_MS = 5 * 60 * 1000;

interface LinearWorkflowStateCacheEntry {
  states: LinearWorkflowState[];
  expiresAt: number;
}

const teamStateCache = new Map<string, Map<string, LinearWorkflowStateCacheEntry>>();

export async function linearGraphQL<T>(
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

// One activity payload shape: the provider-neutral application port
// (app/ports.ts ActivityPublicationInput) owns it; this module keeps its
// historical name for Linear-side callers instead of redeclaring the union.
export type AgentActivityInput = ActivityPublicationInput;

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

export interface LinearComment {
  id: string;
  body?: string | null;
  url?: string | null;
  user?: {
    id?: string | null;
    app?: boolean | null;
    isMe?: boolean | null;
  } | null;
}

function isCurrentAppComment(comment: LinearComment): boolean {
  return comment.user?.app === true && comment.user.isMe === true;
}

export async function findCurrentAppCommentById(
  client: LinearClient,
  commentId: string
): Promise<LinearComment | undefined> {
  const data = await linearGraphQL<{ comment?: LinearComment | null }>(
    client,
    `query Comment($id: String!) {
      comment(id: $id) {
        id body url user { id app isMe }
      }
    }`,
    { id: commentId }
  );
  const comment = data.comment ?? undefined;
  return comment && isCurrentAppComment(comment) ? comment : undefined;
}

export async function findIssueCommentByMarker(
  client: LinearClient,
  issueId: string,
  marker: string
): Promise<LinearComment | undefined> {
  type IssueCommentsResponse = {
    issue?: {
      comments?: {
        nodes?: LinearComment[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    };
  };
  let after: string | null = null;
  const seenCursors = new Set<string>();
  while (true) {
    const data: IssueCommentsResponse = await linearGraphQL<IssueCommentsResponse>(
      client,
      `query IssueComments($id: String!, $after: String) {
        issue(id: $id) {
          comments(first: 100, after: $after) {
            nodes { id body url user { id app isMe } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: issueId, after }
    );
    const connection = data.issue?.comments;
    const match = (connection?.nodes ?? []).find(
      (comment) => comment.body?.includes(marker) && isCurrentAppComment(comment)
    );
    if (match) return match;
    const endCursor = connection?.pageInfo?.endCursor ?? null;
    if (!connection?.pageInfo?.hasNextPage || !endCursor || seenCursors.has(endCursor)) break;
    seenCursors.add(endCursor);
    after = endCursor;
  }
  return undefined;
}

export async function commentUpdate(
  client: LinearClient,
  params: { id: string; body: string }
): Promise<{ success: boolean; comment?: { id: string; url?: string | null } }> {
  const data = await linearGraphQL<{
    commentUpdate: { success: boolean; comment?: { id: string; url?: string | null } };
  }>(
    client,
    `mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
      commentUpdate(id: $id, input: $input) {
        success
        comment { id url }
      }
    }`,
    { id: params.id, input: { body: params.body } }
  );
  if (!data.commentUpdate.success) {
    throw new Error("Linear commentUpdate returned success: false");
  }
  return data.commentUpdate;
}

export async function linearFileUpload(
  client: LinearClient,
  params: { filename: string; contentType: string; content: string }
): Promise<{ assetUrl: string }> {
  const size = Buffer.byteLength(params.content, "utf8");
  if (!/^[A-Za-z0-9_.-]{1,180}$/.test(params.filename)) {
    throw new Error("Linear upload filename is unsafe");
  }
  if (params.contentType !== "application/json" || size < 1 || size > 256 * 1024) {
    throw new Error("Linear upload content is invalid");
  }
  const data = await linearGraphQL<{
    fileUpload: {
      success: boolean;
      uploadFile?: {
        uploadUrl?: string;
        assetUrl?: string;
        headers?: Array<{ key?: string; value?: string }>;
      };
    };
  }>(
    client,
    `mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
      fileUpload(contentType: $contentType, filename: $filename, size: $size) {
        success
        uploadFile { uploadUrl assetUrl headers { key value } }
      }
    }`,
    { contentType: params.contentType, filename: params.filename, size }
  );
  const upload = data.fileUpload.uploadFile;
  if (!data.fileUpload.success || !upload?.uploadUrl || !upload.assetUrl) {
    throw new Error("Linear fileUpload returned an incomplete upload target");
  }
  const uploadUrl = new URL(upload.uploadUrl);
  const assetUrl = new URL(upload.assetUrl);
  if (uploadUrl.protocol !== "https:" || assetUrl.protocol !== "https:") {
    throw new Error("Linear fileUpload returned an unsafe URL");
  }
  const headers = new Headers({ "Content-Type": params.contentType });
  for (const header of upload.headers ?? []) {
    if (header.key && header.value) headers.set(header.key, header.value);
  }
  const response = await (client.fetch ?? fetch)(uploadUrl, {
    method: "PUT",
    headers,
    body: params.content,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Linear private upload failed (${response.status})`);
  return { assetUrl: assetUrl.toString() };
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

function workflowCacheFor(client: LinearClient): Map<string, LinearWorkflowStateCacheEntry> {
  const cacheKey = client.cacheKey ?? client.accessToken;
  let cache = teamStateCache.get(cacheKey);
  if (!cache) {
    cache = new Map();
    teamStateCache.set(cacheKey, cache);
  }
  return cache;
}

async function fetchTeamWorkflowStates(
  client: LinearClient,
  teamId: string
): Promise<LinearWorkflowState[]> {
  const teamData = await linearGraphQL<{
    team?: {
      states?: { nodes?: LinearWorkflowState[] };
    } | null;
  }>(
    client,
    `query TeamWorkflowStates($id: String!) {
      team(id: $id) {
        states { nodes { id name type } }
      }
    }`,
    { id: teamId }
  );
  return teamData.team?.states?.nodes ?? [];
}

function stateRank(type: string): number {
  if (type === "triage") return 0;
  if (type === "backlog") return 0;
  if (type === "unstarted") return 1;
  if (type === "started") return 2;
  if (type === "completed") return 3;
  if (type === "canceled") return 4;
  return Number.POSITIVE_INFINITY;
}

async function issueWorkflowSnapshot(
  client: LinearClient,
  issueId: string,
  options: { refreshStates?: boolean } = {}
): Promise<{
  issue: { id: string; state?: LinearWorkflowState | null; team?: { id?: string | null } | null };
  states: LinearWorkflowState[];
  fromCache: boolean;
}> {
  const issueData = await linearGraphQL<{
    issue?: {
      id: string;
      state?: LinearWorkflowState | null;
      team?: { id?: string | null } | null;
    } | null;
  }>(
    client,
    `query IssueWorkflowState($id: String!) {
      issue(id: $id) {
        id
        state { id name type }
        team { id }
      }
    }`,
    { id: issueId }
  );
  const issue = issueData.issue;
  const teamId = issue?.team?.id;
  if (!issue || !teamId) throw new Error("Linear issue workflow snapshot is incomplete");
  const cache = workflowCacheFor(client);
  if (options.refreshStates) cache.delete(teamId);
  const cached = cache.get(teamId);
  if (cached && cached.expiresAt > Date.now()) {
    return { issue, states: cached.states, fromCache: true };
  }
  const states = await fetchTeamWorkflowStates(client, teamId);
  cache.set(teamId, {
    states,
    expiresAt: Date.now() + TEAM_WORKFLOW_STATE_CACHE_TTL_MS,
  });
  return { issue, states, fromCache: false };
}

function targetStateFor(
  signal: ControlThreadStateSignal,
  states: LinearWorkflowState[]
): LinearWorkflowState | undefined {
  if (signal === "started") return states.find((state) => state.type === "started");
  if (signal === "review") {
    return states.find((state) =>
      state.type === "started" && state.name.trim().toLowerCase() === "in review"
    ) ?? states.find((state) => state.type === "started");
  }
  return states.find((state) => state.type === "completed");
}

function shouldMoveIssueState(
  signal: ControlThreadStateSignal,
  current: LinearWorkflowState,
  target: LinearWorkflowState,
  states: LinearWorkflowState[]
): boolean {
  if (current.id === target.id) return false;
  if (current.type === "canceled" || current.type === "completed") return false;
  if (signal === "started") {
    return stateRank(current.type) < stateRank("started");
  }
  const currentRank = stateRank(current.type);
  const targetRank = stateRank(target.type);
  if (currentRank > targetRank) return false;
  if (currentRank < targetRank) return true;
  if (current.type !== "started" || target.type !== "started") return false;
  const currentIndex = states.findIndex((state) => state.id === current.id);
  const targetIndex = states.findIndex((state) => state.id === target.id);
  if (currentIndex < 0 || targetIndex < 0) return false;
  return currentIndex < targetIndex;
}

function skippedIssueState(current: LinearWorkflowState | null | undefined): {
  success: true;
  skipped: true;
  state?: { id: string; name: string };
} {
  return {
    success: true,
    skipped: true,
    state: current ? { id: current.id, name: current.name } : undefined,
  };
}

function staleWorkflowStateError(error: unknown): boolean {
  return /\binvalid\b|not[ _-]?found|missing|does not exist|could not find/i.test(String(error));
}

async function updateIssueState(
  client: LinearClient,
  issueId: string,
  target: LinearWorkflowState
): Promise<{ success: true; state: { id: string; name: string } }> {
  const data = await linearGraphQL<{
    issueUpdate: {
      success: boolean;
      issue?: { id: string; state?: { id: string; name: string } | null };
    };
  }>(
    client,
    `mutation IssueStateUpdate($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
        issue { id state { id name } }
      }
    }`,
    { id: issueId, stateId: target.id }
  );
  if (!data.issueUpdate.success) {
    throw new Error("Linear issueUpdate returned success: false");
  }
  return {
    success: true,
    state: data.issueUpdate.issue?.state
      ? { id: data.issueUpdate.issue.state.id, name: data.issueUpdate.issue.state.name }
      : { id: target.id, name: target.name },
  };
}

function issueStatePlan(
  signal: ControlThreadStateSignal,
  snapshot: Awaited<ReturnType<typeof issueWorkflowSnapshot>>
): { target: LinearWorkflowState } | { skipped: ReturnType<typeof skippedIssueState> } {
  const current = snapshot.issue.state;
  const target = targetStateFor(signal, snapshot.states);
  if (!current || !target || !shouldMoveIssueState(signal, current, target, snapshot.states)) {
    return { skipped: skippedIssueState(current) };
  }
  return { target };
}

export async function issueStateUpdate(
  client: LinearClient,
  params: { issueId: string; signal: ControlThreadStateSignal }
): Promise<{ success: boolean; skipped?: boolean; state?: { id: string; name: string } }> {
  const snapshot = await issueWorkflowSnapshot(client, params.issueId);
  let plan = issueStatePlan(params.signal, snapshot);
  if ("skipped" in plan) {
    if (!snapshot.fromCache) return plan.skipped;
    const refreshed = await issueWorkflowSnapshot(client, params.issueId, { refreshStates: true });
    plan = issueStatePlan(params.signal, refreshed);
    return "skipped" in plan ? plan.skipped : updateIssueState(client, params.issueId, plan.target);
  }
  try {
    return await updateIssueState(client, params.issueId, plan.target);
  } catch (error) {
    if (!snapshot.fromCache || !staleWorkflowStateError(error)) throw error;
    const refreshed = await issueWorkflowSnapshot(client, params.issueId, { refreshStates: true });
    const refreshedPlan = issueStatePlan(params.signal, refreshed);
    if ("skipped" in refreshedPlan) return refreshedPlan.skipped;
    if (refreshedPlan.target.id === plan.target.id) throw error;
    return updateIssueState(client, params.issueId, refreshedPlan.target);
  }
}

export async function commentCreate(
  client: LinearClient,
  params: { issueId: string; body: string; id?: string }
): Promise<{ success: boolean; comment?: { id: string; url?: string | null } }> {
  const data = await linearGraphQL<{ commentCreate: { success: boolean; comment?: { id: string; url?: string | null } } }>(
    client,
    `mutation CommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment { id url }
      }
    }`,
    { input: { ...(params.id ? { id: params.id } : {}), issueId: params.issueId, body: params.body } }
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
