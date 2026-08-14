#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFINITIONS_PATH = "supervisor/src/persistence/migrations/definitions.ts";
const DEFINITIONS_DECLARATION = "const definitions: DatabaseMigrationDefinition[] = [";
const ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX = " [rollback-compatible:additive/v1]";
const ROLLBACK_MARKER_REQUIRED_FROM_VERSION = 47;

function definitionsArrayStart(source) {
  const starts = [];
  let braceDepth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
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
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") braceDepth += 1;
    else if (character === "}") braceDepth -= 1;
    if (braceDepth === 0 && source.startsWith(DEFINITIONS_DECLARATION, index)) {
      starts.push(index + DEFINITIONS_DECLARATION.length - 1);
      index += DEFINITIONS_DECLARATION.length - 1;
    }
  }
  if (starts.length !== 1) {
    throw new Error(`expected exactly one top-level database migration definitions array, found ${starts.length}`);
  }
  return starts[0];
}

function topLevelMigrationObjects(source) {
  const arrayStart = definitionsArrayStart(source);
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

function assertCanonicalMigrationProperties(object, definitionIndex) {
  const allowedProperties = new Set(["version", "name", "source", "mode", "up"]);
  const properties = new Set();
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let expectingProperty = false;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < object.length; index += 1) {
    const character = object[index];
    const next = object[index + 1];
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
    if (character === '"' || character === "'" || character === "`") {
      if (braceDepth === 1 && expectingProperty) {
        throw new Error(`migration definition ${definitionIndex} property keys must be identifiers`);
      }
      quote = character;
      continue;
    }
    if (character === "{") {
      braceDepth += 1;
      if (braceDepth === 1) expectingProperty = true;
      continue;
    }
    if (character === "}") {
      if (braceDepth === 1) return;
      braceDepth -= 1;
      continue;
    }
    if (braceDepth !== 1) continue;

    if (expectingProperty) {
      if (/[\s,]/.test(character)) continue;
      if (object.startsWith("...", index)) {
        throw new Error(`migration definition ${definitionIndex} may not contain object spreads`);
      }
      if (character === "[") {
        throw new Error(`migration definition ${definitionIndex} may not contain computed properties`);
      }
      const property = object.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0];
      if (!property || property === "get" || property === "set") {
        throw new Error(`migration definition ${definitionIndex} has a non-canonical property`);
      }
      let delimiterIndex = index + property.length;
      while (/\s/.test(object[delimiterIndex] ?? "")) delimiterIndex += 1;
      const delimiter = object[delimiterIndex];
      if (delimiter !== ":" && delimiter !== "(") {
        throw new Error(`migration definition ${definitionIndex} may not contain shorthand properties`);
      }
      if (!allowedProperties.has(property)) {
        throw new Error(`migration definition ${definitionIndex} has unknown property ${property}`);
      }
      if (properties.has(property)) {
        throw new Error(`migration definition ${definitionIndex} has duplicate property ${property}`);
      }
      properties.add(property);
      expectingProperty = false;
      index = delimiterIndex - 1;
      continue;
    }

    if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth -= 1;
    else if (character === "(") parenthesisDepth += 1;
    else if (character === ")") parenthesisDepth -= 1;
    else if (character === "," && bracketDepth === 0 && parenthesisDepth === 0) {
      expectingProperty = true;
    }
  }
  throw new Error(`could not statically parse migration definition ${definitionIndex}`);
}

export function migrationDefinitionsFromSource(source) {
  const definitions = topLevelMigrationObjects(source).map((object, index) => {
    assertCanonicalMigrationProperties(object, index + 1);
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
