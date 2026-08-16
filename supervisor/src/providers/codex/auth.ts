import type { Config } from "../../app/config.js";
import type { SupervisorStore } from "../../persistence/store.js";
import type { Agent } from "../../pipeline/types.js";

/**
 * Durable Codex subscription auth: the supervisor as sole refresh authority.
 *
 * Codex logs in with an OAuth flow whose refresh token *rotates*: every
 * successful refresh mints a new refresh token and invalidates the previous
 * one. A sandbox that refreshed on its own would therefore spend — and rotate
 * away — the shared subscription account's live refresh token underneath every
 * concurrent run, and the rotated result would die with the ephemeral sandbox.
 *
 * So the refresh token never leaves this process. Mirroring how
 * `linear-auth.ts` handles Linear's rotating OAuth token, the SQLite `settings`
 * store — not the env var — is the source of truth; `CODEX_AUTH_JSON` is a
 * one-time bootstrap seed adopted only into an empty store (or when an operator
 * re-logs-in with a strictly newer `last_refresh`).
 *
 * `getCodexAuthForSeed` is the single boundary to a sandbox. It refreshes a
 * near-expiry token centrally behind one in-flight promise, so concurrent runs
 * coalesce instead of racing to spend the same refresh token, and then hands
 * out an access-token-only copy: `tokens.refresh_token` is the empty string,
 * present because Codex expects the key and useless because it cannot rotate
 * anything. Nothing is ever read back out of a sandbox.
 *
 * That contract only holds if the seeded access token outlives the longest
 * action the sandbox can run, so the preflight refresh triggers on the
 * exact sealed action timeout (or the configured stage timeout when there is
 * no child action) plus a one-hour safety margin, and seeding fails closed when
 * even a refreshed token cannot cover that window (better a visible launch
 * failure than a sandbox that dies mid-action with no way to re-authenticate).
 */
export const SETTINGS_CODEX_AUTH_JSON = "codex_auth_json";

// Public OAuth parameters of the Codex CLI's ChatGPT login. These are fixed,
// non-secret values baked into the open-source Codex client; the client is a
// public PKCE client with no secret.
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_SCOPE = "openid profile email";

// Safety margin on top of the authoritative action/stage timeout: a seeded access token
// must cover the longest action the sandbox can run plus an hour of slack for
// provisioning, bootstrap, and result capture.
const SEED_VALIDITY_MARGIN_MS = 60 * 60 * 1000;

// Refresh preflight band above that hard minimum. Refreshing only once the
// token is already below the minimum would make every launch depend on OpenAI
// being reachable at that instant; refreshing this much earlier leaves a window
// in which a failed refresh is still safe to seed.
const REFRESH_LEEWAY_MS = 15 * 60 * 1000;

// Hard bound on the central refresh exchange. A refresh endpoint that accepts
// the connection but never responds must not hold the shared in-flight refresh
// promise (and therefore every coalesced seed request) open indefinitely — it
// is cancelled and the caller falls back to seeding the stored token.
const REFRESH_TIMEOUT_MS = 10 * 1000;

interface CodexAuthShape {
  tokens?: { refresh_token?: unknown; access_token?: unknown };
  last_refresh?: unknown;
}

function parseCodexAuth(blob: string | undefined): CodexAuthShape | undefined {
  if (!blob) return undefined;
  try {
    const value: unknown = JSON.parse(blob);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as CodexAuthShape)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The refresh token embedded in a Codex `auth.json` blob, if present. */
export function codexRefreshToken(blob: string | undefined): string | undefined {
  const token = parseCodexAuth(blob)?.tokens?.refresh_token;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

/** The `last_refresh` timestamp (epoch ms) of a Codex `auth.json` blob. */
function codexLastRefreshMs(blob: string | undefined): number | undefined {
  const value = parseCodexAuth(blob)?.last_refresh;
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Resolve the Codex auth blob to seed into a fresh sandbox.
 *
 * The stored token wins over the frozen env seed once anything has been
 * persisted — replaying the env snapshot is exactly what triggers the reuse
 * error. The env seed is adopted only to bootstrap an empty store, or when an
 * operator re-logs-in and supplies a strictly newer `last_refresh` (recovering
 * a lineage that has been fully spent).
 */
export function resolveStoredCodexAuthJson(cfg: Config, store: SupervisorStore): string | undefined {
  const stored = store.getSetting(SETTINGS_CODEX_AUTH_JSON);
  const seed = cfg.codexAuthJson;
  if (!stored) {
    if (seed) store.setSetting(SETTINGS_CODEX_AUTH_JSON, seed);
    return seed;
  }
  if (seed && seed !== stored) {
    const seedTs = codexLastRefreshMs(seed);
    const storedTs = codexLastRefreshMs(stored);
    if (seedTs !== undefined && (storedTs === undefined || seedTs > storedTs)) {
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, seed);
      return seed;
    }
  }
  return stored;
}

/** Decode a JWT's `exp` claim (epoch ms) without verifying the signature. */
function jwtExpiryMs(token: unknown): number | undefined {
  if (typeof token !== "string") return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return undefined;
    const exp = (claims as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remaining validity of the blob's access token, from its `exp` claim. Returns
 * undefined when the expiry cannot be read. A brokered sandbox cannot refresh,
 * so callers must never treat an unreadable expiry as evidence of freshness.
 */
function codexAccessTokenRemainingMs(blob: string, nowMs: number): number | undefined {
  const expMs = jwtExpiryMs(parseCodexAuth(blob)?.tokens?.access_token);
  return expMs === undefined ? undefined : expMs - nowMs;
}

/**
 * Validity a seeded access token must still have: the exact sealed child-action
 * timeout when supplied, otherwise the configured stage timeout, plus the
 * safety margin. `taskTimeout` is validated at config load (1..86_400 seconds);
 * the guards also keep malformed injected values from collapsing the minimum
 * to NaN.
 */
function seedMinimumValidityMs(cfg: Config, actionTimeoutMs?: number): number {
  const taskTimeoutSeconds = Number.isFinite(cfg.taskTimeout) ? Math.max(0, cfg.taskTimeout) : 0;
  const configuredTimeoutMs = taskTimeoutSeconds * 1000;
  const requiredTimeoutMs = Number.isFinite(actionTimeoutMs)
    ? Math.max(0, actionTimeoutMs ?? 0)
    : configuredTimeoutMs;
  return requiredTimeoutMs + SEED_VALIDITY_MARGIN_MS;
}

/** Raised when no blob safe to seed into a sandbox could be produced. */
export class CodexSeedTokenError extends Error {
  readonly reason: "expiring" | "unreadable";
  readonly code = "CODEX_SEED_TOKEN_UNSAFE";
  readonly statusCode = 401;
  readonly retryable = false;

  constructor(reason: "expiring" | "unreadable", message: string) {
    super(message);
    this.name = "CodexSeedTokenError";
    this.reason = reason;
  }
}

interface CodexRefreshResponse {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
}

/**
 * Exchange the blob's refresh token for a fresh access/id token (and, with
 * rotation, a new refresh token) and merge the result back into the blob.
 * Throws on a network or non-2xx error so the caller can fall back to seeding
 * the stored token. Returns undefined when the blob has no refresh token.
 */
export async function refreshCodexAuthJson(
  currentBlob: string,
  nowIso: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = REFRESH_TIMEOUT_MS
): Promise<string | undefined> {
  const refreshToken = codexRefreshToken(currentBlob);
  if (!refreshToken) return undefined;

  // Bound the exchange with an AbortController. The `signal` cancels a real
  // fetch's socket; the abort-driven race additionally rejects even a stub (or
  // a pathological runtime) that ignores the signal, so the timeout is
  // observable regardless of the fetch implementation.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortRejection = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error(`Codex token refresh timed out after ${timeoutMs}ms`)),
      { once: true }
    );
  });

  let response: Response;
  let refreshed: CodexRefreshResponse;
  try {
    try {
      response = await Promise.race([
        fetchImpl(CODEX_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: CODEX_OAUTH_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            scope: CODEX_OAUTH_SCOPE,
          }),
          signal: controller.signal,
        }),
        abortRejection,
      ]);
    } catch {
      // Sanitize: never let a transport error carry request body/token content
      // into logs. The timeout keeps its own explicit message.
      if (controller.signal.aborted) {
        throw new Error(`Codex token refresh timed out after ${timeoutMs}ms`);
      }
      throw new Error("Codex token refresh request failed");
    }
    if (!response.ok) {
      throw new Error(`Codex token refresh failed with status ${response.status}`);
    }
    try {
      // Keep the same deadline active through response-body consumption. Fetch
      // resolves when headers arrive, while `json()` may still block on a slow
      // or truncated body; both phases are one bounded exchange.
      refreshed = (await Promise.race([
        response.json(),
        abortRejection,
      ])) as CodexRefreshResponse;
    } catch {
      if (controller.signal.aborted) {
        throw new Error(`Codex token refresh timed out after ${timeoutMs}ms`);
      }
      throw new Error("Codex token refresh response was invalid");
    }
  } finally {
    clearTimeout(timer);
  }
  if (!refreshed.access_token && !refreshed.refresh_token) {
    throw new Error("Codex token refresh returned no tokens");
  }

  const base = (parseCodexAuth(currentBlob) ?? {}) as Record<string, unknown>;
  const tokens = {
    ...((base.tokens as Record<string, unknown> | undefined) ?? {}),
    ...(refreshed.access_token ? { access_token: refreshed.access_token } : {}),
    ...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
    ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
  };
  return JSON.stringify({ ...base, tokens, last_refresh: nowIso });
}

// One in-flight refresh per store (i.e. per supervisor process, one shared
// account): concurrent seed requests coalesce onto the same promise so they
// never spend the same refresh token twice.
const refreshInFlight = new WeakMap<SupervisorStore, Promise<string>>();

/**
 * The single boundary between the stored blob and a sandbox. The seeded copy
 * keeps every other field verbatim but carries an empty `tokens.refresh_token`
 * — present (Codex expects the key) and useless (it cannot rotate the shared
 * account's live token away from a concurrent run). The stored blob is never
 * touched here.
 */
function stripRefreshTokenForSeed(blob: string): string {
  const parsed = parseCodexAuth(blob) as Record<string, unknown> | undefined;
  if (!parsed) {
    // Unparseable: the refresh token cannot be located, let alone removed, so
    // there is no copy we can prove is safe to hand a sandbox.
    throw new CodexSeedTokenError(
      "unreadable",
      "Codex auth blob is not a JSON object; refusing to seed a sandbox with a blob whose refresh token cannot be stripped"
    );
  }
  if (!parsed.tokens || typeof parsed.tokens !== "object" || Array.isArray(parsed.tokens)) {
    throw new CodexSeedTokenError(
      "unreadable",
      "Codex auth token container is not a JSON object; refusing to seed a sandbox"
    );
  }
  const tokens = parsed.tokens as Record<string, unknown>;
  if (typeof tokens.account_id !== "string" || tokens.account_id.length === 0) {
    throw new CodexSeedTokenError(
      "unreadable",
      "Codex auth account_id is missing; refusing to seed a sandbox that cannot preserve the account reload gate"
    );
  }
  return JSON.stringify({ ...parsed, tokens: { ...tokens, refresh_token: "" } });
}

/**
 * Resolve the Codex auth blob to seed into a sandbox: refresh centrally when
 * the access token cannot comfortably outlive a whole action, then hand back an
 * access-token-only copy.
 *
 * A failed refresh is tolerated only while the stored token still covers the
 * task timeout plus the safety margin; below that it throws, because the
 * sandbox has no refresh token of its own and would die mid-action.
 */
export async function getCodexAuthForSeed(
  cfg: Config,
  store: SupervisorStore,
  actionTimeoutMs?: number
): Promise<string | undefined> {
  const current = resolveStoredCodexAuthJson(cfg, store);
  if (!current) return undefined;

  const minimumMs = seedMinimumValidityMs(cfg, actionTimeoutMs);
  const remainingMs = codexAccessTokenRemainingMs(current, Date.now());
  if (remainingMs !== undefined && remainingMs >= minimumMs + REFRESH_LEEWAY_MS) {
    return stripRefreshTokenForSeed(current);
  }

  let inflight = refreshInFlight.get(store);
  if (!inflight) {
    inflight = (async () => {
      try {
        const refreshed = await refreshCodexAuthJson(current, new Date().toISOString());
        if (!refreshed) return current;
        store.setSetting(SETTINGS_CODEX_AUTH_JSON, refreshed);
        return refreshed;
      } catch (error) {
        // Log only the sanitized message (never the error object/stack, which
        // could carry request context) so no token material reaches logs.
        const reason = error instanceof Error ? error.message : "unknown error";
        console.warn(`[codex-auth] preflight refresh failed; falling back to the stored token: ${reason}`);
        return current;
      } finally {
        refreshInFlight.delete(store);
      }
    })();
    refreshInFlight.set(store, inflight);
  }

  const seedable = await inflight;
  const seedableRemainingMs = codexAccessTokenRemainingMs(seedable, Date.now());
  if (seedableRemainingMs === undefined) {
    throw new CodexSeedTokenError(
      "unreadable",
      "Codex access token expiry is missing or unreadable; refusing to seed a sandbox that cannot refresh"
    );
  }
  if (seedableRemainingMs < minimumMs) {
    throw new CodexSeedTokenError(
      "expiring",
      `Codex access token has ${Math.floor(seedableRemainingMs / 1000)}s of validity left, ` +
        `below the ${Math.floor(minimumMs / 1000)}s required to cover the authoritative action timeout ` +
        `timeout plus the ${SEED_VALIDITY_MARGIN_MS / 1000}s safety margin; refusing to seed a sandbox ` +
        "that would lose authentication mid-action"
    );
  }
  return stripRefreshTokenForSeed(seedable);
}

export function createCredentialMaterializer(cfg: Config, store: SupervisorStore) {
  return async (
    resource: { providerResourceId: string },
    scopes: readonly string[],
    agentOverride?: Agent,
    actionTimeoutMs?: number
  ): Promise<{ env: Record<string, string> }> => {
    const ticket = store.getBySandboxId(resource.providerResourceId);
    if (!ticket) throw new Error(`runtime resource ${resource.providerResourceId} has no ticket binding`);
    // A loop action may declare its own engine independent of the ticket's
    // default (e.g. a Codex action inside a Claude ticket); the caller passes
    // that action-scoped agent explicitly so the right concrete secret is
    // selected instead of always defaulting to the ticket's own agent.
    const agent = agentOverride ?? ticket.agent;
    const requested = new Set(scopes);
    const env: Record<string, string> = {};
    if (requested.has("repo.write")) {
      env.GITHUB_TOKEN = cfg.githubToken;
    } else if (requested.has("repo.read") || requested.has("provider.read")) {
      env.GITHUB_TOKEN = cfg.githubReadToken;
    }
    if (requested.has("model.invoke")) {
      const claudeCredential = cfg.claudeCodeOauthToken;
      const openCodeCredential = cfg.kimiCodeApiKey;
      if (agent === "claude" && claudeCredential) {
        env.CLAUDE_CODE_OAUTH_TOKEN = claudeCredential;
      } else if (agent === "codex") {
        const codexCredential = await getCodexAuthForSeed(cfg, store, actionTimeoutMs);
        if (!codexCredential) throw new Error("model credential for codex is unavailable");
        env.CODEX_AUTH_JSON = codexCredential;
      } else if (agent === "opencode" && openCodeCredential) {
        env.KIMI_CODE_API_KEY = openCodeCredential;
      } else {
        throw new Error(`model credential for ${agent} is unavailable`);
      }
    }
    return { env };
  };
}
