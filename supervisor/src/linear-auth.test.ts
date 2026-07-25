import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "./app/config.js";
import { createSupervisorStore } from "./persistence/store.js";
import { openDb } from "./persistence/database.js";
import { createLinearClientProvider, createLinearOAuthStateStore } from "./linear-auth.js";

let db: Database.Database | undefined;
afterEach(() => {
  vi.unstubAllGlobals();
  db?.close();
});

describe("Linear OAuth state and refresh", () => {
  it("consumes states once and expires them", () => {
    const states = createLinearOAuthStateStore(() => "state", 100);
    expect(states.issue(1_000)).toBe("state");
    expect(states.consume("state", 1_050)).toBe(true);
    expect(states.consume("state", 1_050)).toBe(false);
    states.issue(2_000);
    expect(states.consume("state", 2_101)).toBe(false);
  });

  it("refreshes an expired token once for concurrent consumers", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    store.setSetting("linear_access_token", "expired");
    store.setSetting("linear_refresh_token", "refresh");
    store.setSetting("linear_token_expires_at", "2020-01-01T00:00:00.000Z");
    const fetchMock = vi.fn(async () =>
      Response.json({
        access_token: "fresh",
        token_type: "Bearer",
        refresh_token: "refresh-2",
        expires_in: 86_400,
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createLinearClientProvider(
      { linearClientId: "client", linearClientSecret: "secret" } as Config,
      store
    );

    const [first, second] = await Promise.all([provider(), provider()]);

    expect(first?.accessToken).toBe("fresh");
    expect(second?.accessToken).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.getSetting("linear_access_token")).toBe("fresh");
    expect(store.getSetting("linear_refresh_token")).toBe("refresh-2");
  });
});
