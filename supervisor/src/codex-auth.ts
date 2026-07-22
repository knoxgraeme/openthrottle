import type { Config } from "./config.js";
import type { TicketStore } from "./db.js";

/**
 * Durable Codex subscription auth.
 *
 * Codex logs in with an OAuth flow whose refresh token *rotates*: every
 * successful refresh mints a new refresh token and invalidates the previous
 * one. That token is refreshed inside the ephemeral Daytona sandbox and written
 * back to `~/.codex/auth.json`, which is destroyed with the sandbox. Reseeding
 * the frozen `CODEX_AUTH_JSON` env snapshot on the next run therefore replays a
 * spent refresh token and OpenAI answers "refresh token was already used".
 *
 * The fix mirrors how `linear-auth.ts` handles Linear's rotating OAuth token:
 * the SQLite `settings` store — not the env var — is the source of truth. The
 * env var is a one-time bootstrap seed; the supervisor reads the rotated token
 * back out of each sandbox (see `captureCodexAuthJson`) so the next run seeds
 * the live token.
 *
 * `getCodexAuthForSeed` additionally refreshes a near-expiry token centrally,
 * behind a single in-flight promise, before seeding a sandbox. Concurrent runs
 * share one shared subscription account, so serializing the supervisor's own
 * refresh keeps two runs from racing to spend the same refresh token, and hands
 * each run the freshest possible token so it need not refresh mid-run. (Two
 * long runs that both outlive the access token can still race inside their
 * sandboxes — one shared account plus rotation cannot be made fully concurrent
 * without per-run credentials, e.g. an API key.)
 */
export const SETTINGS_CODEX_AUTH_JSON = "codex_auth_json";

// Public OAuth parameters of the Codex CLI's ChatGPT login. These are fixed,
// non-secret values baked into the open-source Codex client; the client is a
// public PKCE client with no secret.
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_SCOPE = "openid profile email";

// Refresh preflight when the seeded access token would expire within this
// window, so a fresh sandbox never starts on an already-spent token (which
// would force an immediate — and, across concurrent runs, racing — refresh).
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
    return value && typeof value === "object" ? (value as CodexAuthShape) : undefined;
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
export function resolveStoredCodexAuthJson(cfg: Config, store: TicketStore): string | undefined {
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

/**
 * Persist a refresh token that Codex rotated inside the sandbox so the next run
 * seeds the live token instead of the spent one. Best-effort: ignores blobs
 * with no refresh token, an unchanged token, or an older `last_refresh` than we
 * already hold. Returns whether the store was updated.
 */
export function captureCodexAuthJson(store: TicketStore, blob: string): boolean {
  const refreshToken = codexRefreshToken(blob);
  if (!refreshToken) return false;
  const stored = store.getSetting(SETTINGS_CODEX_AUTH_JSON);
  if (stored) {
    if (codexRefreshToken(stored) === refreshToken) return false;
    const incomingTs = codexLastRefreshMs(blob);
    const storedTs = codexLastRefreshMs(stored);
    if (incomingTs !== undefined && storedTs !== undefined && incomingTs < storedTs) {
      return false;
    }
  }
  store.setSetting(SETTINGS_CODEX_AUTH_JSON, blob);
  return true;
}

/** Decode a JWT's `exp` claim (epoch ms) without verifying the signature. */
function jwtExpiryMs(token: unknown): number | undefined {
  if (typeof token !== "string") return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the blob's access token is expired or within the refresh leeway. When
 * the expiry cannot be read we treat the token as fresh so we never refresh
 * blindly on every run.
 */
function codexAccessTokenNearExpiry(blob: string, nowMs: number): boolean {
  const expMs = jwtExpiryMs(parseCodexAuth(blob)?.tokens?.access_token);
  return expMs !== undefined && expMs - nowMs < REFRESH_LEEWAY_MS;
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
const refreshInFlight = new WeakMap<TicketStore, Promise<string | undefined>>();

/**
 * Resolve the Codex auth blob to seed into a sandbox, refreshing a near-expiry
 * token centrally first. Best-effort: any refresh failure falls back to seeding
 * the stored token unchanged, so seeding never blocks on OpenAI availability.
 */
export async function getCodexAuthForSeed(
  cfg: Config,
  store: TicketStore
): Promise<string | undefined> {
  const current = resolveStoredCodexAuthJson(cfg, store);
  if (!current || !codexAccessTokenNearExpiry(current, Date.now())) return current;

  const pending = refreshInFlight.get(store);
  if (pending) return pending;

  const inflight = (async () => {
    try {
      const refreshed = await refreshCodexAuthJson(current, new Date().toISOString());
      if (!refreshed) return current;
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, refreshed);
      return refreshed;
    } catch (error) {
      // Log only the sanitized message (never the error object/stack, which
      // could carry request context) so no token material reaches logs.
      const reason = error instanceof Error ? error.message : "unknown error";
      console.warn(`[codex-auth] preflight refresh failed; seeding the stored token: ${reason}`);
      return current;
    } finally {
      refreshInFlight.delete(store);
    }
  })();
  refreshInFlight.set(store, inflight);
  return inflight;
}
