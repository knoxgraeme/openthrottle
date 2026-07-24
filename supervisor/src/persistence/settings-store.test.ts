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
});
