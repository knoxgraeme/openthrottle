#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFINITIONS_PATH = "supervisor/src/persistence/migrations/definitions.ts";
const DEFINITIONS_DECLARATION = "const definitions: DatabaseMigrationDefinition[] = [";
const ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX = " [rollback-compatible:additive/v1]";
const ROLLBACK_MARKER_REQUIRED_FROM_VERSION = 47;

function topLevelMigrationObjects(source) {
  const declaration = source.indexOf(DEFINITIONS_DECLARATION);
  if (declaration < 0) {
    throw new Error("could not locate the database migration definitions array");
  }
  const arrayStart = declaration + DEFINITIONS_DECLARATION.length - 1;
  const objects = [];
  let arrayDepth = 0;
  let braceDepth = 0;
  let objectStart = -1;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = arrayStart; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (
      arrayDepth === 1 &&
      braceDepth === 0 &&
      character !== "{" &&
      character !== "]" &&
      !/[\s,]/.test(character)
    ) {
      throw new Error("database migration definitions must be top-level object literals");
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") {
      arrayDepth += 1;
      continue;
    }
    if (character === "]") {
      arrayDepth -= 1;
      if (arrayDepth === 0) {
        if (braceDepth !== 0 || objectStart >= 0) {
          throw new Error("could not statically parse the database migration definitions array");
        }
        return objects;
      }
      continue;
    }
    if (arrayDepth === 1 && character === "{") {
      if (braceDepth === 0) objectStart = index;
      braceDepth += 1;
      continue;
    }
    if (arrayDepth === 1 && character === "}") {
      braceDepth -= 1;
      if (braceDepth < 0 || objectStart < 0) {
        throw new Error("could not statically parse the database migration definitions array");
      }
      if (braceDepth === 0) {
        objects.push(source.slice(objectStart, index + 1));
        objectStart = -1;
      }
    }
  }
  throw new Error("could not statically parse the database migration definitions array");
}

export function migrationDefinitionsFromSource(source) {
  const definitions = topLevelMigrationObjects(source).map((object, index) => {
    const match = object.match(
      /^\s*\{\s*version\s*:\s*(\d+)\s*,\s*name[ \t]*:[ \t]*"((?:[^"\\]|\\.)*)"[ \t]*,/s
    );
    if (!match) {
      throw new Error(
        `could not statically verify a literal version and double-quoted literal name for migration definition ${index + 1}`
      );
    }
    return { version: Number(match[1]), name: JSON.parse(`"${match[2]}"`) };
  });
  if (definitions.length === 0) throw new Error("database migration definitions array is empty");
  for (let index = 0; index < definitions.length; index += 1) {
    const previous = definitions[index - 1];
    if (!Number.isSafeInteger(definitions[index].version) || definitions[index].version < 1) {
      throw new Error(`migration definition ${index + 1} has an invalid version`);
    }
    if (previous && definitions[index].version <= previous.version) {
      throw new Error("database migration definition versions must be strictly increasing");
    }
  }
  return definitions;
}

export function unmarkedMigrationNames(names) {
  return names.filter((name) => !name.endsWith(ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX));
}

export function assertMigrationNamesMarked(source) {
  const protectedDefinitions = migrationDefinitionsFromSource(source).filter(
    ({ version }) => version >= ROLLBACK_MARKER_REQUIRED_FROM_VERSION
  );
  const unmarked = unmarkedMigrationNames(protectedDefinitions.map(({ name }) => name));
  if (unmarked.length > 0) {
    throw new Error(
      `migration definitions at version ${ROLLBACK_MARKER_REQUIRED_FROM_VERSION} or later must end their name with ` +
        `${JSON.stringify(ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX)}: ${unmarked.join(", ")}`
    );
  }
  return protectedDefinitions.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const count = assertMigrationNamesMarked(readFileSync(DEFINITIONS_PATH, "utf8"));
  process.stdout.write(`verified ${count} rollback-compatible migration definition marker(s)\n`);
}
