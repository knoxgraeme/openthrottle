#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFINITIONS_PATH = "supervisor/src/persistence/migrations/definitions.ts";
const ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX = " [rollback-compatible:additive/v1]";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

export function migrationDiffBase(env = process.env) {
  const requested = env.MIGRATION_DIFF_BASE?.trim();
  if (requested && !/^0+$/.test(requested)) return requested;
  const eventName = env.MIGRATION_EVENT_NAME?.trim();
  const refName = env.MIGRATION_REF_NAME?.trim();
  const defaultBranch = env.MIGRATION_DEFAULT_BRANCH?.trim();
  if (
    eventName === "workflow_dispatch" &&
    refName &&
    defaultBranch &&
    refName !== defaultBranch
  ) {
    return `origin/${defaultBranch}`;
  }
  return "HEAD^";
}

function addedLines(diff) {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

export function addedMigrationDefinitionCountFromDiff(diff) {
  return addedLines(diff).filter((line) => /^\s*version\s*:/.test(line)).length;
}

export function addedMigrationNamesFromDiff(diff) {
  return addedLines(diff)
    .map((line) => line.match(/^\s*name:\s*"([^"]+)",?\s*$/)?.[1])
    .filter((name) => name !== undefined);
}

export function unmarkedMigrationNames(names) {
  return names.filter((name) => !name.endsWith(ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX));
}

export function assertAddedMigrationNamesMarked(diff) {
  const addedMigrationDefinitions = addedMigrationDefinitionCountFromDiff(diff);
  const addedMigrationNames = addedMigrationNamesFromDiff(diff);
  if (addedMigrationDefinitions !== addedMigrationNames.length) {
    throw new Error(
      "could not statically verify exactly one double-quoted literal name for every added migration definition"
    );
  }
  const unmarked = unmarkedMigrationNames(addedMigrationNames);
  if (unmarked.length > 0) {
    throw new Error(
      `new migration definitions must end their name with ${JSON.stringify(ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX)}: ` +
        unmarked.join(", ")
    );
  }
  return addedMigrationDefinitions;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const diff = git([
    "diff",
    "--unified=0",
    "--no-ext-diff",
    "--no-color",
    migrationDiffBase(),
    "HEAD",
    "--",
    DEFINITIONS_PATH,
  ]);
  const count = assertAddedMigrationNamesMarked(diff);
  process.stdout.write(`verified ${count} added migration definition marker(s)\n`);
}
