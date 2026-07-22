import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { createTicketStore, openDb, type TicketStore } from "./db.js";
import {
  SETTINGS_CODEX_AUTH_JSON,
  captureCodexAuthJson,
  codexRefreshToken,
  getCodexAuthForSeed,
  refreshCodexAuthJson,
  resolveStoredCodexAuthJson,
} from "./codex-auth.js";

function cfgWith(codexAuthJson: string | undefined): Config {
  return { codexAuthJson } as unknown as Config;
}

/** A JWT whose `exp` is `secondsFromNow` from now (unsigned; only exp matters). */
function jwtExpiringIn(secondsFromNow: number): string {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `header.${payload}.sig`;
}

function authBlob(
  refresh: string,
  lastRefresh?: string,
  accessToken = "access"
): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "id",
      access_token: accessToken,
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  describe("resolveStoredCodexAuthJson", () => {
    it("bootstraps the settings store from the env seed on first use", () => {
      const seed = authBlob("rt-0", "2026-07-01T00:00:00Z");
      expect(resolveStoredCodexAuthJson(cfgWith(seed), store)).toBe(seed);
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(seed);
    });

    it("keeps the stored token and never replays the frozen env seed", () => {
      const rotated = authBlob("rt-1", "2026-07-02T00:00:00Z");
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, rotated);
      const staleSeed = authBlob("rt-0", "2026-07-01T00:00:00Z");

      expect(resolveStoredCodexAuthJson(cfgWith(staleSeed), store)).toBe(rotated);
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(rotated);
    });

    it("adopts a re-logged-in env seed with a strictly newer last_refresh", () => {
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, authBlob("rt-0", "2026-07-01T00:00:00Z"));
      const relogin = authBlob("rt-9", "2026-07-05T00:00:00Z");

      expect(resolveStoredCodexAuthJson(cfgWith(relogin), store)).toBe(relogin);
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(relogin);
    });

    it("returns undefined when neither env nor store has a token", () => {
      expect(resolveStoredCodexAuthJson(cfgWith(undefined), store)).toBeUndefined();
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

  describe("refreshCodexAuthJson", () => {
    it("merges the rotated tokens back into the blob and stamps last_refresh", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          access_token: "access-2",
          id_token: "id-2",
          refresh_token: "rt-1",
        }),
      })) as unknown as typeof fetch;

      const result = await refreshCodexAuthJson(
        authBlob("rt-0", "2026-07-01T00:00:00Z"),
        "2026-07-02T12:00:00Z",
        fetchMock
      );
      const parsed = JSON.parse(result!);
      expect(parsed.tokens.access_token).toBe("access-2");
      expect(parsed.tokens.refresh_token).toBe("rt-1");
      expect(parsed.tokens.account_id).toBe("acct"); // preserved
      expect(parsed.last_refresh).toBe("2026-07-02T12:00:00Z");

      const body = JSON.parse((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt-0" });
    });

    it("throws on a non-2xx response so the caller can fall back", async () => {
      const fetchMock = vi.fn(async () => ({ ok: false, status: 400 })) as unknown as typeof fetch;
      await expect(
        refreshCodexAuthJson(authBlob("rt-0"), "2026-07-02T00:00:00Z", fetchMock)
      ).rejects.toThrow(/status 400/);
    });

    it("cancels a hung refresh within the bound and leaks no token content (finding #3)", async () => {
      // A refresh endpoint that accepts the connection but never responds, and
      // ignores the abort signal — the bound must still fire.
      const neverResolves = vi.fn(
        () => new Promise<Response>(() => {})
      ) as unknown as typeof fetch;
      const blob = authBlob("rt-secret-0", "2026-07-01T00:00:00Z");
      const start = Date.now();
      const err = await refreshCodexAuthJson(
        blob,
        "2026-07-02T00:00:00Z",
        neverResolves,
        20
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/timed out after 20ms/);
      expect((err as Error).message).not.toContain("rt-secret-0");
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it("keeps the timeout active while the response body is being read (finding #3)", async () => {
      const bodyNeverResolves = vi.fn(async () => ({
        ok: true,
        json: () => new Promise<never>(() => {}),
      })) as unknown as typeof fetch;
      const start = Date.now();
      const err = await refreshCodexAuthJson(
        authBlob("rt-secret-body"),
        "2026-07-02T00:00:00Z",
        bodyNeverResolves,
        20
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/timed out after 20ms/);
      expect((err as Error).message).not.toContain("rt-secret-body");
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it("sanitizes response-body parsing failures (finding #3)", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new Error("invalid response containing rt-secret-body-error");
        },
      })) as unknown as typeof fetch;
      const err = await refreshCodexAuthJson(
        authBlob("rt-secret-body-error"),
        "2026-07-02T00:00:00Z",
        fetchMock
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("Codex token refresh response was invalid");
      expect((err as Error).message).not.toContain("rt-secret-body-error");
    });

    it("rethrows a sanitized error carrying no request content on transport failure (finding #3)", async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error("ECONNRESET while sending refresh_token=rt-secret-1");
      }) as unknown as typeof fetch;
      const err = await refreshCodexAuthJson(
        authBlob("rt-secret-1"),
        "2026-07-02T00:00:00Z",
        fetchMock
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("Codex token refresh request failed");
      expect((err as Error).message).not.toContain("rt-secret-1");
    });
  });

  describe("getCodexAuthForSeed", () => {
    it("seeds the stored token unchanged when it is not near expiry", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const fresh = authBlob("rt-0", "2026-07-01T00:00:00Z", jwtExpiringIn(3600));
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, fresh);

      expect(await getCodexAuthForSeed(cfgWith(undefined), store)).toBe(fresh);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refreshes a near-expiry token centrally and persists the rotation", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ access_token: jwtExpiringIn(3600), refresh_token: "rt-1" }),
      }));
      vi.stubGlobal("fetch", fetchMock);
      store.setSetting(
        SETTINGS_CODEX_AUTH_JSON,
        authBlob("rt-0", "2026-07-01T00:00:00Z", jwtExpiringIn(60))
      );

      const seeded = await getCodexAuthForSeed(cfgWith(undefined), store);
      expect(codexRefreshToken(seeded)).toBe("rt-1");
      expect(codexRefreshToken(store.getSetting(SETTINGS_CODEX_AUTH_JSON))).toBe("rt-1");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("coalesces concurrent seeds onto a single refresh", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ access_token: jwtExpiringIn(3600), refresh_token: "rt-1" }),
      }));
      vi.stubGlobal("fetch", fetchMock);
      store.setSetting(
        SETTINGS_CODEX_AUTH_JSON,
        authBlob("rt-0", "2026-07-01T00:00:00Z", jwtExpiringIn(60))
      );

      const [a, b] = await Promise.all([
        getCodexAuthForSeed(cfgWith(undefined), store),
        getCodexAuthForSeed(cfgWith(undefined), store),
      ]);
      expect(a).toBe(b);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to the stored token when the refresh fails", async () => {
      const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
      vi.stubGlobal("fetch", fetchMock);
      const stale = authBlob("rt-0", "2026-07-01T00:00:00Z", jwtExpiringIn(60));
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, stale);

      expect(await getCodexAuthForSeed(cfgWith(undefined), store)).toBe(stale);
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(stale);
    });

    it("falls back on a transport failure and logs no token content (finding #3)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi.fn(async () => {
        throw new Error("boom refresh_token=rt-secret-2");
      });
      vi.stubGlobal("fetch", fetchMock);
      const stale = authBlob("rt-secret-2", "2026-07-01T00:00:00Z", jwtExpiringIn(60));
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, stale);

      expect(await getCodexAuthForSeed(cfgWith(undefined), store)).toBe(stale);
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(stale);
      // The one warning emitted must carry only the sanitized reason.
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toContain("rt-secret-2");
      expect(logged).toContain("Codex token refresh request failed");
    });
  });
});
