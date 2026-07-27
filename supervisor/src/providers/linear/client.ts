const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_OAUTH_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const HTTP_TIMEOUT_MS = 15_000;

export interface LinearClient {
  accessToken: string;
  fetch?: typeof fetch;
}

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
