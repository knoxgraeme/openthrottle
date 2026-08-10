import { canonicalJson, digestNormalized } from "./canonical.js";

export interface ValidatedContract<T> {
  value: T;
  normalized: string;
  digest: string;
}

export function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
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
  options: { max: number; keyPattern?: RegExp } = { max: 64 }
): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  const input = value as Record<string, unknown>;
  const output: Record<string, T> = {};
  let count = 0;
  for (const [key, entry] of Object.entries(input)) {
    count += 1;
    if (count > options.max) fail(path, `must contain at most ${options.max} entries`);
    if (options.keyPattern && !options.keyPattern.test(key)) fail(`${path}.${key}`, "has an invalid key");
    output[key] = parse(entry, `${path}.${key}`, key);
  }
  return output;
}

export function normalizedContract<T>(value: T): ValidatedContract<T> {
  const normalized = canonicalJson(value);
  return { value, normalized, digest: digestNormalized(normalized) };
}

export const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export const SKILL_REFERENCE = /^(?:builtin:\/\/[a-z][a-z0-9]*(?:[._/@-][a-z0-9]+)*@\d+|repo:\/\/[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)$/;
// Producer evidence binds the exact pinned repository skill (owner/repo@commit#path)
// admission resolved, not the authoring-time short name graph.ts validates with
// SKILL_REFERENCE above. Path segments reject "." and ".." to match the
// traversal-safe pinning contract enforced at admission (manifest.ts) and by the
// sandbox executor (sandbox/runner/artifacts.mjs).
export const PRODUCER_SKILL_REFERENCE = /^(?:builtin:\/\/[a-z][a-z0-9]*(?:[._/@-][a-z0-9]+)*@\d+|repo:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}#(?:(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+\/)*(?!\.{1,2}$)[A-Za-z0-9._-]+)$/;
export const SHA256 = /^[a-f0-9]{64}$/;
export const GIT_SUBJECT = /^[a-f0-9]{40,64}$/;
// Keep evidence-query timestamps byte-compatible with the persistence read
// surfaces. Date.parse alone accepts ambiguous values such as `0`, `2026`,
// and locale-shaped dates, while equivalent offset timestamps must normalize
// to the same bytes before citation results are compared.
const ISO_8601_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;

export function normalizeIso8601Timestamp(value: string): string | null {
  if (!ISO_8601_TIMESTAMP.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}
// Matches sandbox/runner/artifacts.mjs's NATIVE_SESSION_ID and
// native-session-package.mjs's PACKAGE_PATH_ID, since a native session id
// is later used to build a filesystem path.
export const NATIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
