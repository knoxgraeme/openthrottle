import { canonicalJson, digestNormalized } from "./canonical.js";

export interface ValidatedContract<T> {
  value: T;
  normalized: string;
  digest: string;
}

export type JsonValue = null | boolean | string | number | JsonValue[] | { [key: string]: JsonValue };

export interface JsonValueOptions {
  maxDepth?: number;
  maxEntries?: number;
  maxKeyLength?: number;
  rejectCarriageReturns?: boolean;
}

export interface ContractValidationIssue {
  path: string;
  detail: string;
}

export class ContractValidationError extends Error {
  readonly issue: Readonly<ContractValidationIssue>;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "ContractValidationError";
    this.issue = Object.freeze({ path, detail });
  }
}

export function contractValidationIssue(error: unknown): ContractValidationIssue | undefined {
  if (!(error instanceof ContractValidationError)) return undefined;
  return { ...error.issue };
}

export function fail(path: string, message: string): never {
  throw new ContractValidationError(path, message);
}

export function objectAt(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, "unknown field");
  }
  return record;
}

export function stringAt(value: unknown, path: string, options: { max?: number; pattern?: RegExp } = {}): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
  const max = options.max ?? 512;
  if (value.length > max) fail(path, `must be at most ${max} characters`);
  if (options.pattern && !options.pattern.test(value)) fail(path, "has an invalid format");
  return value;
}

export function integerAt(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(path, `must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

export function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

export function enumAt<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(path, `must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function arrayAt<T>(
  value: unknown,
  path: string,
  parse: (entry: unknown, path: string) => T,
  options: { min?: number; max: number }
): T[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length < (options.min ?? 0) || value.length > options.max) {
    fail(path, `must contain between ${options.min ?? 0} and ${options.max} entries`);
  }
  return value.map((entry, index) => parse(entry, `${path}[${index}]`));
}

export function unique<T extends string>(values: readonly T[], path: string): T[] {
  if (new Set(values).size !== values.length) fail(path, "must not contain duplicates");
  return [...values];
}

export function optional<T>(value: unknown, parse: (entry: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value);
}

export function nullable<T>(value: unknown, parse: (entry: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

export function recordAt<T>(
  value: unknown,
  path: string,
  parse: (entry: unknown, path: string, key: string) => T,
  options: { max: number; keyMax?: number; keyPattern?: RegExp } = { max: 64 }
): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  const input = value as Record<string, unknown>;
  const output: Record<string, T> = {};
  let count = 0;
  for (const [key, entry] of Object.entries(input)) {
    count += 1;
    if (count > options.max) fail(path, `must contain at most ${options.max} entries`);
    if (options.keyMax !== undefined && key.length > options.keyMax) {
      fail(`${path}.${key}`, `key must contain at most ${options.keyMax} characters`);
    }
    if (options.keyPattern && !options.keyPattern.test(key)) fail(`${path}.${key}`, "has an invalid key");
    output[key] = parse(entry, `${path}.${key}`, key);
  }
  return output;
}

export function jsonValueAt(
  value: unknown,
  path: string,
  options: JsonValueOptions = {},
  depth = 0,
): JsonValue {
  const maxDepth = options.maxDepth ?? 16;
  const maxEntries = options.maxEntries ?? 1_024;
  const maxKeyLength = options.maxKeyLength ?? 200;
  if (depth > maxDepth) fail(path, `exceeds the maximum JSON depth of ${maxDepth}`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (options.rejectCarriageReturns && value.includes("\r")) fail(path, "must use LF line endings");
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > maxEntries) fail(path, `must contain at most ${maxEntries} entries`);
    return value.map((entry, index) => jsonValueAt(entry, `${path}[${index}]`, options, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > maxEntries) fail(path, `must contain at most ${maxEntries} fields`);
    return Object.fromEntries(entries.map(([key, entry]) => {
      if (!key || key.length > maxKeyLength) fail(`${path}.${key}`, "has an invalid key");
      return [key, jsonValueAt(entry, `${path}.${key}`, options, depth + 1)];
    }));
  }
  fail(path, "must be a JSON value");
}

export function normalizedContract<T>(value: T): ValidatedContract<T> {
  const normalized = canonicalJson(value);
  return { value, normalized, digest: digestNormalized(normalized) };
}

export const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export const SHA256 = /^[a-f0-9]{64}$/;
export const GIT_SUBJECT = /^[a-f0-9]{40,64}$/;
// Date.parse alone accepts ambiguous values such as `0`, `2026`, and
// locale-shaped dates, so contract timestamps use an explicit grammar and
// calendar check.
const ISO_8601_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):?(\d{2}))$/;

export function normalizeIso8601Timestamp(value: string): string | null {
  const match = ISO_8601_TIMESTAMP.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth[month - 1]! ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}
// Records and checkpoints preserve the producer's valid timestamp spelling
// because those exact bytes participate in immutable contract digests.
export function timestampAt(
  value: unknown,
  path: string,
  options: { normalize?: boolean } = {}
): string {
  const result = stringAt(value, path, { max: 64 });
  const normalized = normalizeIso8601Timestamp(result);
  if (!normalized) fail(path, "must be an ISO-8601 timestamp");
  return options.normalize === false ? result : normalized;
}

export function parseIdentifierList(
  value: unknown,
  path: string,
  options: { min?: number; max: number }
): string[] {
  return unique(arrayAt(value, path, (entry, entryPath) => {
    return stringAt(entry, entryPath, { pattern: IDENTIFIER });
  }, options), path);
}

export function parsePlanCommand(value: unknown, path: string): { name: string; unit: string | null } {
  const input = objectAt(value, path, ["name", "unit"]);
  if (input.unit === undefined) fail(`${path}.unit`, "is required");
  return {
    name: stringAt(input.name, `${path}.name`, { max: 80, pattern: COMMAND_NAME_PATTERN }),
    unit: input.unit === null
      ? null
      : stringAt(input.unit, `${path}.unit`, { pattern: IDENTIFIER }),
  };
}

// Depth-first cycle detection over a dependency graph whose nodes carry
// `{ id, depends_on }`. Callers must have verified that every dependency
// references a known unit before walking.
export function assertAcyclicDependencies(
  units: ReadonlyArray<{ id: string; depends_on: readonly string[] }>,
  path: string
): void {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) fail(`${path}.${id}.depends_on`, "creates a cycle");
    visiting.add(id);
    for (const dependency of byId.get(id)!.depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const unit of units) visit(unit.id);
}

// Native session IDs become bounded filesystem path components in the sandbox.
export const NATIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
