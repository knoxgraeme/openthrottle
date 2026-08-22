import { createHash } from "node:crypto";
import type {
  KernelLinearSessionStartPort,
  KernelLinearSessionStartRequest,
} from "../../app/kernel-linear-session.js";
import { readStreamUpToByteLimit } from "../../shared/bounded-stream.js";

const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const ACTIVITY_ID_NAMESPACE = "openthrottle.linear-agent-session-start/v1";
const INITIAL_THOUGHT = "Spinning up a workspace…";
const DEFAULT_DEADLINE_MS = 7_000;
const TOKEN_REFRESH_WINDOW_MS = 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_IDENTITY_BYTES = 1_000;
const MAX_CREDENTIAL_BYTES = 4_096;
const MIN_FINAL_RECONCILIATION_MS = 100;
const MAX_FINAL_RECONCILIATION_MS = 1_000;

interface CachedToken {
  value: string;
  expiresAt: number;
}

interface AgentActivityNode {
  id: string;
  agentSession: { id: string };
}

class LinearRemoteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LinearRemoteError";
  }
}

class LinearActivityIdentityConflictError extends Error {
  constructor() {
    super("Linear session start activity identity conflict");
    this.name = "LinearActivityIdentityConflictError";
  }
}

export interface LinearSessionStartProviderOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
  deadlineMs?: number;
  oauthTokenUrl?: string;
  graphqlUrl?: string;
}

function bounded(value: string, name: string, maxBytes: number): string {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${name} must be nonempty and at most ${maxBytes} bytes`);
  }
  return value;
}

function validateOptions(options: LinearSessionStartProviderOptions): void {
  bounded(options.clientId, "Linear client ID", MAX_CREDENTIAL_BYTES);
  bounded(options.clientSecret, "Linear client secret", MAX_CREDENTIAL_BYTES);
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 250 || deadlineMs > 10_000) {
    throw new Error("Linear session start deadline must be between 250 and 10000 milliseconds");
  }
  for (const [name, raw] of [
    ["Linear OAuth token URL", options.oauthTokenUrl ?? LINEAR_OAUTH_TOKEN_URL],
    ["Linear API URL", options.graphqlUrl ?? LINEAR_GRAPHQL_URL],
  ] as const) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${name} must be an absolute HTTPS URL`);
    }
    if (url.protocol !== "https:" && options.fetch === undefined) {
      throw new Error(`${name} must be an absolute HTTPS URL`);
    }
  }
}

function validateRequest(
  input: Readonly<KernelLinearSessionStartRequest>,
): KernelLinearSessionStartRequest {
  return {
    inbox_event_id: bounded(input.inbox_event_id, "inbox event ID", MAX_IDENTITY_BYTES),
    webhook_id: bounded(input.webhook_id, "Linear webhook ID", MAX_IDENTITY_BYTES),
    session_id: bounded(input.session_id, "Linear session ID", MAX_IDENTITY_BYTES),
  };
}

function deterministicActivityId(input: KernelLinearSessionStartRequest): string {
  const digest = createHash("sha256")
    .update(ACTIVITY_ID_NAMESPACE, "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify([
      input.inbox_event_id,
      input.webhook_id,
      input.session_id,
    ]), "utf8")
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function boundedJson(response: Response, boundary: string): Promise<unknown> {
  if (response.body === null) {
    throw new Error(`${boundary} returned an invalid response body`);
  }
  let read: Awaited<ReturnType<typeof readStreamUpToByteLimit>>;
  try {
    read = await readStreamUpToByteLimit(response.body, MAX_RESPONSE_BYTES);
  } catch {
    throw new Error(`${boundary} returned an invalid response body`);
  }
  if (read.exceeded) {
    throw new Error(`${boundary} response exceeded its size bound`);
  }
  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${boundary} returned invalid JSON`);
  }
}

function finalReconciliationBudget(deadlineMs: number): number {
  return Math.min(
    MAX_FINAL_RECONCILIATION_MS,
    Math.max(MIN_FINAL_RECONCILIATION_MS, Math.floor(deadlineMs / 4)),
  );
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactActivity(value: unknown): AgentActivityNode | undefined {
  const activity = object(value);
  const session = object(activity?.agentSession);
  return typeof activity?.id === "string" && typeof session?.id === "string"
    ? { id: activity.id, agentSession: { id: session.id } }
    : undefined;
}

export function createLinearSessionStartProvider(
  options: LinearSessionStartProviderOptions,
): KernelLinearSessionStartPort {
  validateOptions(options);
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const oauthTokenUrl = options.oauthTokenUrl ?? LINEAR_OAUTH_TOKEN_URL;
  const graphqlUrl = options.graphqlUrl ?? LINEAR_GRAPHQL_URL;
  let cachedToken: CachedToken | undefined;

  async function accessToken(signal: AbortSignal): Promise<string> {
    if (cachedToken && cachedToken.expiresAt - now() > TOKEN_REFRESH_WINDOW_MS) {
      return cachedToken.value;
    }
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope: "read,write",
    });
    const response = await fetchImpl(oauthTokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`, "utf8").toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal,
    });
    if (!response.ok) {
      throw new LinearRemoteError(`Linear OAuth token request failed (${response.status})`, response.status);
    }
    const payload = object(await boundedJson(response, "Linear OAuth token endpoint"));
    const token = payload?.access_token;
    const tokenType = payload?.token_type;
    const expiresIn = payload?.expires_in;
    if (
      typeof token !== "string" || token.length === 0 ||
      Buffer.byteLength(token, "utf8") > MAX_CREDENTIAL_BYTES ||
      tokenType !== "Bearer" ||
      typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) ||
      expiresIn < 1 || expiresIn > 31_536_000
    ) {
      throw new Error("Linear OAuth token endpoint returned an invalid token response");
    }
    cachedToken = { value: token, expiresAt: now() + expiresIn * 1_000 };
    return token;
  }

  async function linearApi<T>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal,
    mayRefresh = true,
  ): Promise<T> {
    const token = await accessToken(signal);
    const response = await fetchImpl(graphqlUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal,
    });
    if (response.status === 401 && mayRefresh) {
      if (cachedToken?.value === token) cachedToken = undefined;
      return linearApi<T>(operation, query, variables, signal, false);
    }
    if (!response.ok) {
      throw new LinearRemoteError(`Linear API ${operation} failed (${response.status})`, response.status);
    }
    const envelope = object(await boundedJson(response, `Linear API ${operation}`));
    if (Array.isArray(envelope?.errors) && envelope.errors.length > 0) {
      throw new LinearRemoteError(`Linear API ${operation} returned errors`, response.status);
    }
    if (!("data" in (envelope ?? {})) || envelope?.data === null || envelope?.data === undefined) {
      throw new Error(`Linear API ${operation} response is missing data`);
    }
    return envelope.data as T;
  }

  async function reconcile(
    activityId: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<"found" | "not_found"> {
    const data = await linearApi<{
      agentActivities?: { nodes?: unknown[] };
    }>(
      "AgentActivityById",
      `query AgentActivityById($id: ID!) {
        agentActivities(first: 2, filter: { id: { eq: $id } }) {
          nodes { id agentSession { id } }
        }
      }`,
      { id: activityId },
      signal,
    );
    const nodes = data.agentActivities?.nodes;
    if (!Array.isArray(nodes)) {
      throw new Error("Linear API AgentActivityById response has an invalid shape");
    }
    if (nodes.length === 0) return "not_found";
    if (nodes.length !== 1) throw new LinearActivityIdentityConflictError();
    const activity = exactActivity(nodes[0]);
    if (activity?.id !== activityId || activity.agentSession.id !== sessionId) {
      throw new LinearActivityIdentityConflictError();
    }
    return "found";
  }

  async function createActivity(
    activityId: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const data = await linearApi<{
      agentActivityCreate?: { success?: boolean; agentActivity?: unknown };
    }>(
      "AgentActivityCreate",
      `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) {
          success
          agentActivity { id agentSession { id } }
        }
      }`,
      {
        input: {
          id: activityId,
          agentSessionId: sessionId,
          content: { type: "thought", body: INITIAL_THOUGHT },
          ephemeral: true,
        },
      },
      signal,
    );
    const result = data.agentActivityCreate;
    const activity = exactActivity(result?.agentActivity);
    if (
      result?.success !== true ||
      activity?.id !== activityId ||
      activity.agentSession.id !== sessionId
    ) {
      throw new LinearActivityIdentityConflictError();
    }
  }

  return {
    async ensureStarted(rawInput): Promise<void> {
      const input = validateRequest(rawInput);
      const activityId = deterministicActivityId(input);
      const totalSignal = AbortSignal.timeout(deadlineMs);
      const finalBudgetMs = finalReconciliationBudget(deadlineMs);
      const mutationSignal = AbortSignal.any([
        totalSignal,
        AbortSignal.timeout(deadlineMs - finalBudgetMs),
      ]);
      if (await reconcile(activityId, input.session_id, mutationSignal) === "found") return;

      try {
        await createActivity(activityId, input.session_id, mutationSignal);
        return;
      } catch {
        // A deterministic provider-native ID makes a final read authoritative
        // after timeouts, concurrent creates, or a lost mutation response.
      }

      const finalSignal = AbortSignal.any([
        totalSignal,
        AbortSignal.timeout(finalBudgetMs),
      ]);
      try {
        if (await reconcile(activityId, input.session_id, finalSignal) === "found") return;
      } catch (error) {
        if (error instanceof LinearActivityIdentityConflictError) throw error;
      }
      throw new Error("Linear session start mutation could not be reconciled");
    },
  };
}
