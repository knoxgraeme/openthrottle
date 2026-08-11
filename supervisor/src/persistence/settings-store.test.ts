import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./database.js";
import { createSupervisorStore, type SupervisorStore } from "./store.js";

describe("settings store", () => {
  let db: ReturnType<typeof openDb>;
  let store: SupervisorStore;

  beforeEach(() => {
    db = openDb(":memory:");
    store = createSupervisorStore(db);
  });

  afterEach(() => db.close());

  it("persists operator settings", () => {
    store.setSetting("catalog-digest", "abc123");
    expect(store.getSetting("catalog-digest")).toBe("abc123");
  });

  it("commits a coherent setting projection atomically", () => {
    db.exec(`
      CREATE TRIGGER reject_incomplete_projection
      BEFORE INSERT ON settings
      WHEN NEW.key = 'projection:reject'
      BEGIN
        SELECT RAISE(ABORT, 'projection rejected');
      END
    `);

    expect(() => store.setSettings([
      { key: "projection:head", value: "head-b" },
      { key: "projection:reject", value: "authoritative" },
      { key: "projection:observed-at", value: "2026-01-01T00:00:00.000Z" },
    ])).toThrow("projection rejected");
    expect(store.listSettings("projection:")).toEqual([]);

    store.setSettings([
      { key: "projection:head", value: "head-b" },
      { key: "projection:source", value: "authoritative" },
      { key: "projection:observed-at", value: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(store.listSettings("projection:")).toEqual([
      { key: "projection:head", value: "head-b" },
      { key: "projection:observed-at", value: "2026-01-01T00:00:00.000Z" },
      { key: "projection:source", value: "authoritative" },
    ]);
  });
});
