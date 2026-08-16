import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../../app/config.js";
import { createSupervisorStore, type SupervisorStore } from "../../persistence/store.js";
import { openDb } from "../../persistence/database.js";
import {
  CodexSeedTokenError,
  SETTINGS_CODEX_AUTH_JSON,
  codexRefreshToken,
  createCredentialMaterializer,
  getCodexAuthForSeed,
  refreshCodexAuthJson,
  resolveStoredCodexAuthJson,
} from "./auth.js";

// A seeded token must outlive `taskTimeout` plus a one-hour margin, and the
// preflight refresh fires 15 minutes above that minimum. With a 300s timeout:
// minimum = 3_900s, refresh threshold = 4_800s.
const TASK_TIMEOUT_SECONDS = 300;
const SEED_MINIMUM_SECONDS = TASK_TIMEOUT_SECONDS + 3600;
const REFRESH_THRESHOLD_SECONDS = SEED_MINIMUM_SECONDS + 900;

function cfgWith(codexAuthJson: string | undefined): Config {
  return { codexAuthJson, taskTimeout: TASK_TIMEOUT_SECONDS } as unknown as Config;
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

// Access tokens placed in each of the three bands seeding cares about: clear of
// the preflight entirely, inside the preflight band but still covering a whole
// action, and short of the minimum a seeded token must have.
const aboveRefreshBand = () => jwtExpiringIn(REFRESH_THRESHOLD_SECONDS + 60);
const insideRefreshBand = () => jwtExpiringIn(SEED_MINIMUM_SECONDS + 60);
const belowSeedMinimum = () => jwtExpiringIn(120);

/** The access-token-only copy seeding must produce from a stored blob. */
function seededForm(storedBlob: string): unknown {
  const stored = JSON.parse(storedBlob);
  return { ...stored, tokens: { ...stored.tokens, refresh_token: "" } };
}

describe("Codex durable auth", () => {
  let db: Database.Database;
  let store: SupervisorStore;

  beforeEach(() => {
    db = openDb(":memory:");
    store = createSupervisorStore(db);
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

      const request = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(new Headers(request.headers).get("content-type")).toBe(
        "application/x-www-form-urlencoded"
      );
      expect(Object.fromEntries(new URLSearchParams(String(request.body)))).toEqual({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: "rt-0",
        scope: "openid profile email",
      });
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
    it.each([
      ["an array root", "[]"],
      ["an array token container", JSON.stringify({ tokens: [] })],
      ["a missing access token", JSON.stringify({ tokens: { refresh_token: "" } })],
      ["a non-JWT access token", JSON.stringify({ tokens: { access_token: "opaque", refresh_token: "" } })],
    ])("fails closed for %s", async (_label, blob) => {
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, blob);

      const error = await getCodexAuthForSeed(cfgWith(undefined), store).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CodexSeedTokenError);
      expect((error as CodexSeedTokenError).reason).toBe("unreadable");
    });

    it("uses the action timeout when it exceeds the supervisor default", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
      vi.stubGlobal("fetch", fetchMock);
      const sixHours = 6 * 60 * 60;
      const twelveHoursMs = 12 * 60 * 60 * 1000;
      store.setSetting(
        SETTINGS_CODEX_AUTH_JSON,
        authBlob("rt-0", "2026-07-01T00:00:00Z", jwtExpiringIn(sixHours))
      );

      const error = await getCodexAuthForSeed(cfgWith(undefined), store, twelveHoursMs)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CodexSeedTokenError);
      expect((error as CodexSeedTokenError).reason).toBe("expiring");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("uses a supplied shorter action timeout instead of the supervisor default", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
      vi.stubGlobal("fetch", fetchMock);
      const thirtySecondsMs = 30 * 1000;
      const token = authBlob(
        "rt-0",
        "2026-07-01T00:00:00Z",
        jwtExpiringIn(60 * 60 + 60)
      );
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, token);

      const seeded = await getCodexAuthForSeed(cfgWith(undefined), store, thirtySecondsMs);
      expect(seeded).toBeDefined();
      expect(JSON.parse(seeded!)).toEqual(seededForm(token));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("seeds an access-token-only copy and leaves the stored blob intact", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const fresh = authBlob("rt-secret-live", "2026-07-01T00:00:00Z", aboveRefreshBand());
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, fresh);

      const seeded = await getCodexAuthForSeed(cfgWith(undefined), store);
      expect(seeded).toBeDefined();
      expect(seeded).not.toContain("rt-secret-live");

      // access_token, id_token, account_id and last_refresh byte-identical to
      // the stored blob; refresh_token present (a missing key would not equal
      // the empty string) and empty.
      const parsed = JSON.parse(seeded!);
      expect(parsed).toEqual(seededForm(fresh));
      expect(Object.prototype.hasOwnProperty.call(parsed.tokens, "refresh_token")).toBe(true);

      // The store keeps the real refresh token, untouched.
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(fresh);
      expect(codexRefreshToken(store.getSetting(SETTINGS_CODEX_AUTH_JSON))).toBe("rt-secret-live");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("preserves auth_mode in the seeded copy", async () => {
      vi.stubGlobal("fetch", vi.fn());
      const stored = JSON.stringify({
        tokens: {
          access_token: aboveRefreshBand(),
          refresh_token: "rt-0",
          account_id: "acct",
          auth_mode: "chatgpt",
        },
      });
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, stored);

      const parsed = JSON.parse((await getCodexAuthForSeed(cfgWith(undefined), store))!);
      expect(parsed.tokens.auth_mode).toBe("chatgpt");
      expect(parsed.tokens.refresh_token).toBe("");
    });

    it("refreshes a token inside the leeway window centrally and persists the rotation", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ access_token: aboveRefreshBand(), refresh_token: "rt-1" }),
      }));
      vi.stubGlobal("fetch", fetchMock);
      store.setSetting(
        SETTINGS_CODEX_AUTH_JSON,
        // Above the hard minimum but inside the preflight band: the old fixed
        // 15-minute leeway would not have refreshed this at all.
        authBlob("rt-0", "2026-07-01T00:00:00Z", insideRefreshBand())
      );

      const seeded = await getCodexAuthForSeed(cfgWith(undefined), store);
      // The rotation lands in the store; only the seeded copy is stripped.
      expect(codexRefreshToken(store.getSetting(SETTINGS_CODEX_AUTH_JSON))).toBe("rt-1");
      expect(JSON.parse(seeded!).tokens.refresh_token).toBe("");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("coalesces concurrent seeds onto a single refresh", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ access_token: aboveRefreshBand(), refresh_token: "rt-1" }),
      }));
      vi.stubGlobal("fetch", fetchMock);
      store.setSetting(
        SETTINGS_CODEX_AUTH_JSON,
        authBlob("rt-0", "2026-07-01T00:00:00Z", belowSeedMinimum())
      );

      const [a, b] = await Promise.all([
        getCodexAuthForSeed(cfgWith(undefined), store),
        getCodexAuthForSeed(cfgWith(undefined), store),
      ]);
      expect(a).toBe(b);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("still seeds when the refresh fails but the stored token covers the whole action", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
      vi.stubGlobal("fetch", fetchMock);
      const stale = authBlob("rt-0", "2026-07-01T00:00:00Z", insideRefreshBand());
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, stale);

      const seeded = await getCodexAuthForSeed(cfgWith(undefined), store);
      expect(JSON.parse(seeded!).tokens.refresh_token).toBe("");
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(stale);
      expect(warn).toHaveBeenCalled();
    });

    it("fails closed when the refresh fails and the token cannot cover the task timeout", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
      vi.stubGlobal("fetch", fetchMock);
      const stale = authBlob("rt-0", "2026-07-01T00:00:00Z", belowSeedMinimum());
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, stale);

      const error = await getCodexAuthForSeed(cfgWith(undefined), store).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CodexSeedTokenError);
      expect((error as CodexSeedTokenError).reason).toBe("expiring");
      // The message names the remaining validity (120s, or 119s once the test
      // itself has burned a millisecond) and the required minimum.
      expect((error as Error).message).toMatch(/(119|120)s of validity left/);
      expect((error as Error).message).toContain(`${SEED_MINIMUM_SECONDS}s required`);
      expect((error as Error).message).not.toContain("rt-0");
      // The near-expiry blob stays stored for the next attempt; nothing is seeded.
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(stale);
      expect((error as CodexSeedTokenError).statusCode).toBe(401);
      expect((error as CodexSeedTokenError).retryable).toBe(false);
    });

    it("falls back on a transport failure and logs no token content (finding #3)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi.fn(async () => {
        throw new Error("boom refresh_token=rt-secret-2");
      });
      vi.stubGlobal("fetch", fetchMock);
      const stale = authBlob("rt-secret-2", "2026-07-01T00:00:00Z", insideRefreshBand());
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, stale);

      const seeded = await getCodexAuthForSeed(cfgWith(undefined), store);
      expect(seeded).not.toContain("rt-secret-2");
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(stale);
      // The one warning emitted must carry only the sanitized reason.
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toContain("rt-secret-2");
      expect(logged).toContain("Codex token refresh request failed");
    });

    it("refuses to seed a blob whose refresh token cannot be located", async () => {
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, "not json");
      const error = await getCodexAuthForSeed(cfgWith(undefined), store).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CodexSeedTokenError);
      expect((error as CodexSeedTokenError).reason).toBe("unreadable");
    });

    it("returns undefined when no token is stored at all", async () => {
      expect(await getCodexAuthForSeed(cfgWith(undefined), store)).toBeUndefined();
    });
  });

  describe("createCredentialMaterializer", () => {
    function fullCfg(overrides: Partial<Config> = {}): Config {
      return {
        githubToken: "gh-write-token",
        githubReadToken: "gh-read-token",
        claudeCodeOauthToken: "claude-token",
        kimiCodeApiKey: "kimi-key",
        codexAuthJson: undefined,
        taskTimeout: TASK_TIMEOUT_SECONDS,
        ...overrides,
      } as unknown as Config;
    }

    function seedTicket(agent: "claude" | "codex" | "opencode") {
      store.upsert({
        ticket_id: "issue-1",
        ticket_reference: "OT-1",
        session_id: "session-1",
        sandbox_id: "sandbox-1",
        branch: "ot/ot-1",
        agent,
        repo: "owner/repo",
        pr_url: null,
        state: "active",
      });
    }

    it("uses the ticket's own agent when no per-action override is passed", async () => {
      seedTicket("claude");
      const materialize = createCredentialMaterializer(fullCfg(), store);

      const { env } = await materialize({ providerResourceId: "sandbox-1" }, ["model.invoke"]);
      expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "claude-token" });
    });

    it("selects the requesting action's own agent credential when it overrides the ticket's default agent", async () => {
      // A graph worker can run a Codex action inside an otherwise-Claude
      // ticket. Without the override, the materializer would hand this
      // action CLAUDE_CODE_OAUTH_TOKEN -- a credential it cannot authenticate
      // with, and one it has no business receiving.
      seedTicket("claude");
      const codexAuth = authBlob("rt-secret-live", "2026-07-01T00:00:00Z", aboveRefreshBand());
      store.setSetting(SETTINGS_CODEX_AUTH_JSON, codexAuth);
      const materialize = createCredentialMaterializer(fullCfg(), store);

      const ticketAgentEnv = await materialize({ providerResourceId: "sandbox-1" }, ["model.invoke"]);
      expect(ticketAgentEnv.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "claude-token" });

      const actionAgentEnv = await materialize(
        { providerResourceId: "sandbox-1" },
        ["model.invoke"],
        "codex"
      );
      // The sandbox is handed an access-token-only copy, never the live
      // refresh token the store still holds.
      expect(Object.keys(actionAgentEnv.env)).toEqual(["CODEX_AUTH_JSON"]);
      expect(actionAgentEnv.env.CODEX_AUTH_JSON).not.toContain("rt-secret-live");
      expect(JSON.parse(actionAgentEnv.env.CODEX_AUTH_JSON)).toEqual(seededForm(codexAuth));
      expect(store.getSetting(SETTINGS_CODEX_AUTH_JSON)).toBe(codexAuth);
    });

    it("surfaces a token that cannot cover the task timeout as a launch failure", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));
      seedTicket("codex");
      store.setSetting(
        SETTINGS_CODEX_AUTH_JSON,
        authBlob("rt-0", "2026-07-01T00:00:00Z", belowSeedMinimum())
      );
      const materialize = createCredentialMaterializer(fullCfg(), store);

      await expect(
        materialize({ providerResourceId: "sandbox-1" }, ["model.invoke"])
      ).rejects.toBeInstanceOf(CodexSeedTokenError);
    });

    it("throws when the overriding agent has no available credential, rather than silently falling back", async () => {
      seedTicket("claude");
      const materialize = createCredentialMaterializer(fullCfg({ kimiCodeApiKey: undefined }), store);

      await expect(
        materialize({ providerResourceId: "sandbox-1" }, ["model.invoke"], "opencode")
      ).rejects.toThrow(/model credential for opencode is unavailable/);
    });
  });
});
