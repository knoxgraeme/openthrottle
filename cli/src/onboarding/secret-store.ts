import { closeSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProfileSecretStore } from "./contracts.js";
import { assertProfileName, atomicWriteJson } from "./profile-store.js";

export const SECRET_SCHEMA = "openthrottle.local-secrets/v1";

export interface SecretStoreOptions {
  root?: string;
  allowedKeys: readonly string[];
  env?: NodeJS.ProcessEnv;
}

interface SecretDocument {
  schema: typeof SECRET_SCHEMA;
  profile: string;
  secrets: Record<string, string>;
}

export function defaultSecretRoot(env = process.env): string {
  return env.OT_SECRET_DIR?.trim() || join(homedir(), ".openthrottle", "secrets");
}

export function envNameForSecret(profileName: string, key: string): string {
  assertProfileName(profileName);
  const suffix = encodeEnvSegment(key);
  if (profileName === "default") return `OT_${suffix}`;
  return `OT_PROFILE_${encodeEnvSegment(profileName)}_${suffix}`;
}

function encodeEnvSegment(value: string): string {
  return [...value]
    .map((char) => {
      if (/^[A-Za-z0-9]$/.test(char)) return char.toUpperCase();
      if (char === ".") return "_DOT_";
      if (char === "-") return "_DASH_";
      if (char === "_") return "_UNDERSCORE_";
      throw new Error("env override segment contains unsupported characters");
    })
    .join("");
}

export class LocalFileSecretStore implements ProfileSecretStore {
  private readonly root: string;
  private readonly allowedKeys: Set<string>;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: SecretStoreOptions) {
    this.root = options.root ?? defaultSecretRoot(options.env);
    this.allowedKeys = new Set(options.allowedKeys);
    this.env = options.env ?? process.env;
  }

  async get(profileName: string, key: string): Promise<string | undefined> {
    this.assertAllowed(key);
    assertProfileName(profileName);
    const override =
      this.env[envNameForSecret(profileName, key)] ??
      (profileName === "default" ? this.env[`OT_${key.toUpperCase()}`] : undefined);
    if (override?.trim()) return override.trim();
    const document = this.read(profileName);
    return document.secrets[key];
  }

  async set(profileName: string, key: string, value: string): Promise<void> {
    this.assertAllowed(key);
    assertProfileName(profileName);
    const path = this.pathFor(profileName);
    const document = this.read(profileName);
    document.secrets[key] = value;
    atomicWriteJson(path, document);
  }

  pathFor(profileName: string): string {
    assertProfileName(profileName);
    return join(this.root, `${profileName}.json`);
  }

  private assertAllowed(key: string): void {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key)) throw new Error("secret key is invalid");
    if (!this.allowedKeys.has(key)) throw new Error(`secret ${key} is not allowed in the local store`);
  }

  private read(profileName: string): SecretDocument {
    assertProfileName(profileName);
    const path = this.pathFor(profileName);
    try {
      assertRestrictiveFile(path);
      const input = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return validateSecretDocument(input, profileName, this.allowedKeys);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schema: SECRET_SCHEMA, profile: profileName, secrets: {} };
      }
      throw error;
    }
  }
}

export function assertRestrictiveFile(path: string): void {
  assertRestrictiveMode(statSync(path).mode, "local secret store", path);
}

export function readRestrictiveFile(path: string, label = "local secret store"): string {
  const descriptor = openSync(path, "r");
  try {
    assertRestrictiveMode(fstatSync(descriptor).mode, label, path);
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function assertRestrictiveMode(rawMode: number, label: string, path: string): void {
  const mode = rawMode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`refusing to read ${label} at ${path} with permissions ${mode.toString(8)}`);
  }
}

function validateSecretDocument(input: unknown, profileName: string, allowedKeys: Set<string>): SecretDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("secret store must be a JSON object");
  }
  const value = input as Record<string, unknown>;
  if (value.schema !== SECRET_SCHEMA) throw new Error("unsupported secret store schema");
  if (value.profile !== profileName) throw new Error("secret store profile mismatch");
  if (!value.secrets || typeof value.secrets !== "object" || Array.isArray(value.secrets)) {
    throw new Error("secret store secrets must be an object");
  }
  const secrets: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.secrets as Record<string, unknown>)) {
    if (!allowedKeys.has(key)) throw new Error(`secret ${key} is not allowed in the local store`);
    if (typeof entry !== "string") throw new Error(`secret ${key} must be a string`);
    secrets[key] = entry;
  }
  return { schema: SECRET_SCHEMA, profile: profileName, secrets };
}
