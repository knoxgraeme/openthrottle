import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { createTicketStore, openDb, type TicketStore } from "./db.js";
import {
  SETTINGS_CODEX_AUTH_JSON,
  captureCodexAuthJson,
  codexRefreshToken,
  resolveCodexAuthJson,
} from "./codex-auth.js";

function cfgWith(codexAuthJson: string | undefined): Config {
  return { codexAuthJson } as unknown as Config;
}

function authBlob(refresh: string, lastRefresh?: string): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "id",
      access_token: "access",
      refresh_token: refresh,
      account_id: "acct",
    },
    ...(lastRefresh ? { last_refresh: lastRefresh } : {}),
  });
}

describe("Codex durable auth", () => {
  let db: Database.Database;
  let store: TicketStore;

  beforeEach(() => {
    db = openDb(":memory:");
    store = createTicketStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("codexRefreshToken", () => {
    it("extracts the nested refresh token", () => {
      expect(codexRefreshToken(authBlob("rt-1"))).toBe("rt-1");
    });

    it("returns undefined for blobs without a refresh token or invalid JSON", () => {
      expect(codexRefreshToken("{}")).toBeUndefined();
      expect(codexRefreshToken('{"tokens":{"refresh_token":""}}')).toBeUndefined();
      expect(codexRefreshToken("not json")).toBeUndefined();
      expect(codexRefreshToken(undefined)).toBeUndefined();
    });
  });

  describe("resolveCodexAuthJson", () => {
    it("bootstraps the settings store from the env seed on first use", () => {
      const seed = authBlob("rt-0", "2026-07-01T00:00:00Z");
      expect(resolveCodexAuthJson(cfgWith(seed), store)).toBe(seed);
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(seed);
    });

    it("keeps the stored token and never replays the frozen env seed", () => {
      const rotated = authBlob("rt-1", "2026-07-02T00:00:00Z");
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, rotated);
      const staleSeed = authBlob("rt-0", "2026-07-01T00:00:00Z");

      expect(resolveCodexAuthJson(cfgWith(staleSeed), store)).toBe(rotated);
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(rotated);
    });

    it("adopts a re-logged-in env seed with a strictly newer last_refresh", () => {
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, authBlob("rt-0", "2026-07-01T00:00:00Z"));
      const relogin = authBlob("rt-9", "2026-07-05T00:00:00Z");

      expect(resolveCodexAuthJson(cfgWith(relogin), store)).toBe(relogin);
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(relogin);
    });

    it("returns undefined when neither env nor store has a token", () => {
      expect(resolveCodexAuthJson(cfgWith(undefined), store)).toBeUndefined();
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBeUndefined();
    });
  });

  describe("captureCodexAuthJson", () => {
    it("persists a token Codex rotated inside the sandbox", () => {
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, authBlob("rt-0", "2026-07-01T00:00:00Z"));
      const rotated = authBlob("rt-1", "2026-07-02T00:00:00Z");

      expect(captureCodexAuthJson(store, rotated)).toBe(true);
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(rotated);
    });

    it("ignores an unchanged refresh token", () => {
      const current = authBlob("rt-0", "2026-07-01T00:00:00Z");
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, current);

      expect(captureCodexAuthJson(store, authBlob("rt-0", "2026-07-03T00:00:00Z"))).toBe(false);
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(current);
    });

    it("ignores a blob without a usable refresh token", () => {
      const current = authBlob("rt-0", "2026-07-01T00:00:00Z");
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, current);

      expect(captureCodexAuthJson(store, "{}")).toBe(false);
      expect(captureCodexAuthJson(store, "not json")).toBe(false);
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(current);
    });

    it("ignores a stale rotation older than the stored token", () => {
      const current = authBlob("rt-2", "2026-07-04T00:00:00Z");
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, current);

      expect(captureCodexAuthJson(store, authBlob("rt-1", "2026-07-02T00:00:00Z"))).toBe(false);
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(current);
    });

    it("captures into an empty store", () => {
      const rotated = authBlob("rt-1", "2026-07-02T00:00:00Z");
      expect(captureCodexAuthJson(store, rotated)).toBe(true);
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(rotated);
    });
  });
});
