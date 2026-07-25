import type { Config } from "./app/config.js";
import type { SupervisorStore } from "./persistence/store.js";
import {
  refreshLinearOAuthToken,
  type LinearClient,
  type LinearOAuthTokenResponse,
} from "./linear.js";

const SETTINGS_LINEAR_ACCESS_TOKEN = "linear_access_token";
const SETTINGS_LINEAR_REFRESH_TOKEN = "linear_refresh_token";
const SETTINGS_LINEAR_TOKEN_EXPIRES_AT = "linear_token_expires_at";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function persistLinearToken(store: SupervisorStore, token: LinearOAuthTokenResponse): void {
  store.setSetting(SETTINGS_LINEAR_ACCESS_TOKEN, token.access_token);
  if (token.refresh_token) store.setSetting(SETTINGS_LINEAR_REFRESH_TOKEN, token.refresh_token);
  if (token.expires_in) {
    store.setSetting(
      SETTINGS_LINEAR_TOKEN_EXPIRES_AT,
      new Date(Date.now() + token.expires_in * 1000).toISOString()
    );
  }
}

export function createLinearClientProvider(
  cfg: Config,
  store: SupervisorStore
): () => Promise<LinearClient | undefined> {
  let refreshInFlight: Promise<LinearClient | undefined> | undefined;
  return async (): Promise<LinearClient | undefined> => {
    const accessToken = store.getSetting(SETTINGS_LINEAR_ACCESS_TOKEN);
    if (!accessToken) return undefined;
    const expiresAt = Date.parse(store.getSetting(SETTINGS_LINEAR_TOKEN_EXPIRES_AT) ?? "");
    if (Number.isNaN(expiresAt) || expiresAt - Date.now() > 5 * 60 * 1000) {
      return { accessToken };
    }
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const refreshToken = store.getSetting(SETTINGS_LINEAR_REFRESH_TOKEN);
      if (!refreshToken) {
        console.error("[linear] OAuth access token expired and no refresh token is stored");
        return undefined;
      }
      const token = await refreshLinearOAuthToken({
        clientId: cfg.linearClientId,
        clientSecret: cfg.linearClientSecret,
        refreshToken,
      });
      persistLinearToken(store, token);
      return { accessToken: token.access_token };
    })().finally(() => {
      refreshInFlight = undefined;
    });
    return refreshInFlight;
  };
}

export interface LinearOAuthStateStore {
  issue(now?: number): string;
  consume(state: string | undefined, now?: number): boolean;
}

export function createLinearOAuthStateStore(
  randomState: () => string,
  ttlMs = OAUTH_STATE_TTL_MS
): LinearOAuthStateStore {
  const pending = new Map<string, number>();
  const prune = (now: number) => {
    for (const [state, expiry] of pending) {
      if (expiry < now) pending.delete(state);
    }
  };
  return {
    issue(now = Date.now()) {
      prune(now);
      const state = randomState();
      pending.set(state, now + ttlMs);
      return state;
    },
    consume(state, now = Date.now()) {
      prune(now);
      if (!state || !pending.has(state)) return false;
      pending.delete(state);
      return true;
    },
  };
}
