#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFINITIONS_PATH = "supervisor/src/persistence/migrations/definitions.ts";
const ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX = " [rollback-compatible:additive/v1]";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function diffBase() {
  const requested = process.env.MIGRATION_DIFF_BASE?.trim();
  if (requested && !/^0+$/.test(requested)) return requested;
  return "HEAD^";
}

export function addedMigrationNamesFromDiff(diff) {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.match(/^\+\s*name:\s*"([^"]+)",?\s*$/)?.[1])
    .filter((name) => name !== undefined);
}

export function unmarkedMigrationNames(names) {
  return names.filter((name) => !name.endsWith(ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX));
}

export function assertAddedMigrationNamesMarked(diff) {
  const addedMigrationNames = addedMigrationNamesFromDiff(diff);
  const unmarked = unmarkedMigrationNames(addedMigrationNames);
  if (unmarked.length > 0) {
    throw new Error(
      `new migration definitions must end their name with ${JSON.stringify(ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX)}: ` +
        unmarked.join(", ")
    );
  }
  return addedMigrationNames.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const diff = git([
    "diff",
    "--unified=0",
    "--no-ext-diff",
    "--no-color",
    diffBase(),
    "HEAD",
    "--",
    DEFINITIONS_PATH,
  ]);
  const count = assertAddedMigrationNamesMarked(diff);
  process.stdout.write(`verified ${count} added migration definition marker(s)\n`);
}
