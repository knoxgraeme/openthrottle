import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertMigrationNamesMarked,
  migrationDefinitionsFromSource,
} from "./verify-migration-rollback-markers.mjs";

const verifierPath = fileURLToPath(new URL("./verify-migration-rollback-markers.mjs", import.meta.url));
const suffix = " [rollback-compatible:additive/v1]";

function source(...definitions) {
  return [
    "const definitions: DatabaseMigrationDefinition[] = [",
    ...definitions,
    "];",
    "export const databaseMigrations = definitions;",
    "",
  ].join("\n");
}

describe("migration rollback marker verifier", () => {
  it("verifies every protected migration in the complete current source", () => {
    const input = source(
      '  { version: 45, name: "legacy", source: "" },',
      '  { version: 46, name: "legacy-cutover", source: "" },',
      [
        "  {",
        "    version: 47,",
        `    name: "future${suffix}",`,
        "    source: `CREATE TABLE future (id TEXT PRIMARY KEY);`,",
        "  },",
      ].join("\n"),
    );

    expect(migrationDefinitionsFromSource(input)).toEqual([
      { version: 45, name: "legacy" },
      { version: 46, name: "legacy-cutover" },
      { version: 47, name: `future${suffix}` },
    ]);
    expect(assertMigrationNamesMarked(input)).toBe(1);
  });

  it("rejects an unmarked one-line migration definition", () => {
    const input = source(
      '  { version: 46, name: "legacy-cutover", source: "" },',
      '  { version: 47, name: "future-unmarked", source: "" },',
    );

    expect(() => assertMigrationNamesMarked(input)).toThrow(
      /migration definitions at version 47 or later must end their name/
    );
  });

  it.each([
    ["single-quoted", `  { version: 47, name: 'future${suffix}', source: "" },`],
    ["computed", "  { version: 47, name: `future${suffix}`, source: \"\" },"],
    ["concatenated", '  { version: 47, name: "future" + suffix, source: "" },'],
    ["multiline", `  { version: 47, name:\n      \"future${suffix}\", source: \"\" },`],
    ["missing", '  { version: 47, source: "" },'],
    ["computed keys", `  { ["version"]: 47, ["name"]: "future${suffix}", source: "" },`],
    ["reordered", `  { name: "future${suffix}", version: 47, source: "" },`],
    ["shorthand", '  { version, name, source: "" },'],
  ])("fails closed for a %s migration name", (_label, definition) => {
    expect(() => assertMigrationNamesMarked(source(definition))).toThrow(
      /could not statically verify a literal version and double-quoted literal name|may not contain/
    );
  });

  it.each([
    ["spread", `  { version: 47, name: "future${suffix}", source: "" },\n  ...moreDefinitions,`],
    ["helper", "  migration(47),"],
  ])("fails closed for a top-level %s definition", (_label, definition) => {
    expect(() => assertMigrationNamesMarked(source(definition))).toThrow(
      /top-level object literals/
    );
  });

  it.each([
    ["in-object spread override", `  { version: 47, name: "safe${suffix}", ...{ name: "unmarked" }, source: "" },`],
    ["duplicate name override", `  { version: 47, name: "safe${suffix}", name: "unmarked", source: "" },`],
    ["computed name override", `  { version: 47, name: "safe${suffix}", ["name"]: "unmarked", source: "" },`],
    ["getter name override", `  { version: 47, name: "safe${suffix}", get name() { return "unmarked"; }, source: "" },`],
  ])("fails closed for an %s after a valid prefix", (_label, definition) => {
    expect(() => assertMigrationNamesMarked(source(definition))).toThrow(
      /may not contain|duplicate property|non-canonical property/
    );
  });

  it("ignores braces and migration-like text inside strings and comments", () => {
    const input = source([
      "  {",
      "    version: 47,",
      `    name: "future${suffix}",`,
      "    source: `CREATE TABLE text (value TEXT DEFAULT '{ version: 99 }');`,",
      "    up() { /* { version: 100 } */ return \"}\"; },",
      "  },",
    ].join("\n"));

    expect(assertMigrationNamesMarked(input)).toBe(1);
  });

  it("rejects duplicate or out-of-order migration versions", () => {
    expect(() => migrationDefinitionsFromSource(source(
      `  { version: 47, name: "one${suffix}", source: "" },`,
      `  { version: 47, name: "two${suffix}", source: "" },`,
    ))).toThrow(/strictly increasing/);
  });

  it("checks the complete HEAD file when invoked, independent of the triggering diff", () => {
    const directory = mkdtempSync(join(tmpdir(), "ot-migration-marker-head-"));
    const definitions = join(directory, "supervisor/src/persistence/migrations/definitions.ts");
    try {
      mkdirSync(dirname(definitions), { recursive: true });
      writeFileSync(definitions, source(
        '  { version: 46, name: "legacy-cutover", source: "" },',
        '  { version: 47, name: "previously-merged-unmarked", source: "" },',
      ));

      const result = spawnSync(process.execPath, [verifierPath], {
        cwd: directory,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("previously-merged-unmarked");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
