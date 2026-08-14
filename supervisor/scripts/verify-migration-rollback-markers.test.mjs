import { describe, expect, it } from "vitest";
import {
  addedMigrationNamesFromDiff,
  assertAddedMigrationNamesMarked,
} from "./verify-migration-rollback-markers.mjs";

describe("migration rollback marker verifier", () => {
  it("extracts added migration definition names from a definitions diff", () => {
    const diff = [
      "diff --git a/supervisor/src/persistence/migrations/definitions.ts b/supervisor/src/persistence/migrations/definitions.ts",
      "+++ b/supervisor/src/persistence/migrations/definitions.ts",
      "+    version: 46,",
      "+    name: \"future-additive [rollback-compatible:additive/v1]\",",
      "+    source: `CREATE TABLE future_additive (id TEXT PRIMARY KEY);`,",
    ].join("\n");

    expect(addedMigrationNamesFromDiff(diff)).toEqual([
      "future-additive [rollback-compatible:additive/v1]",
    ]);
    expect(assertAddedMigrationNamesMarked(diff)).toBe(1);
  });

  it("rejects added migration definition names without the rollback marker", () => {
    const diff = [
      "+    version: 46,",
      "+    name: \"future-unmarked\",",
      "+    source: `CREATE TABLE future_unmarked (id TEXT PRIMARY KEY);`,",
    ].join("\n");

    expect(() => assertAddedMigrationNamesMarked(diff)).toThrow(
      /new migration definitions must end their name/
    );
  });
});
