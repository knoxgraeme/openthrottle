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
 */
export const SETTINGS_CODEX_AUTH_JSON = "codex_auth_json";

interface CodexAuthShape {
  tokens?: { refresh_token?: unknown };
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
export function resolveCodexAuthJson(cfg: Config, store: TicketStore): string | undefined {
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
