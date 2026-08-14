import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  addedMigrationDefinitionCountFromDiff,
  addedMigrationNamesFromDiff,
  assertAddedMigrationNamesMarked,
  migrationDiffBase,
} from "./verify-migration-rollback-markers.mjs";

const verifierPath = fileURLToPath(new URL("./verify-migration-rollback-markers.mjs", import.meta.url));

function git(directory, args) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

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
    expect(addedMigrationDefinitionCountFromDiff(diff)).toBe(1);
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

  it.each([
    ["single-quoted", "+    name: 'future [rollback-compatible:additive/v1]',"],
    ["computed", "+    name: `future${ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX}`,"],
    ["concatenated", "+    name: \"future\" + ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX,"],
    ["multiline", "+    name:\n+      \"future [rollback-compatible:additive/v1]\","],
    ["missing", "+    source: `CREATE TABLE future (id TEXT PRIMARY KEY);`,"],
  ])("fails closed for a %s migration name", (_label, nameLine) => {
    const diff = [
      "+    version: 47,",
      nameLine,
      "+    source: `CREATE TABLE future (id TEXT PRIMARY KEY);`,",
    ].join("\n");

    expect(() => assertAddedMigrationNamesMarked(diff)).toThrow(
      /could not statically verify exactly one double-quoted literal name/
    );
  });

  it("uses the predecessor for a default-branch manual dispatch", () => {
    expect(migrationDiffBase({
      MIGRATION_EVENT_NAME: "workflow_dispatch",
      MIGRATION_REF_NAME: "main",
      MIGRATION_DEFAULT_BRANCH: "main",
    })).toBe("HEAD^");
    expect(migrationDiffBase({
      MIGRATION_EVENT_NAME: "workflow_dispatch",
      MIGRATION_REF_NAME: "release-test",
      MIGRATION_DEFAULT_BRANCH: "main",
    })).toBe("origin/main");
    expect(migrationDiffBase({
      MIGRATION_DIFF_BASE: "abc123",
      MIGRATION_EVENT_NAME: "push",
    })).toBe("abc123");
  });

  it("rejects an unmarked migration in a default-branch workflow dispatch", () => {
    const directory = mkdtempSync(join(tmpdir(), "ot-migration-marker-dispatch-"));
    const definitions = join(
      directory,
      "supervisor/src/persistence/migrations/definitions.ts"
    );
    try {
      mkdirSync(dirname(definitions), { recursive: true });
      git(directory, ["init", "-q"]);
      git(directory, ["config", "user.name", "OpenThrottle Test"]);
      git(directory, ["config", "user.email", "test@openthrottle.local"]);
      writeFileSync(definitions, "export const definitions = [];\n");
      git(directory, ["add", "."]);
      git(directory, ["commit", "-qm", "base"]);
      writeFileSync(definitions, [
        "export const definitions = [",
        "  {",
        "    version: 47,",
        "    name: \"future-unmarked\",",
        "    source: `CREATE TABLE future_unmarked (id TEXT PRIMARY KEY);`,",
        "  },",
        "];",
        "",
      ].join("\n"));
      git(directory, ["add", "."]);
      git(directory, ["commit", "-qm", "add unmarked migration"]);

      const result = spawnSync(process.execPath, [verifierPath], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          MIGRATION_DIFF_BASE: "",
          MIGRATION_EVENT_NAME: "workflow_dispatch",
          MIGRATION_REF_NAME: "main",
          MIGRATION_DEFAULT_BRANCH: "main",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("new migration definitions must end their name");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
