import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderEvidence, ProviderId, ReleaseManifest } from "./contracts.js";
import { assertProviderId } from "./contracts.js";

export const PROFILE_SCHEMA = "openthrottle.profile/v1";

export interface OnboardingProfile {
  schema: typeof PROFILE_SCHEMA;
  name: string;
  providers: {
    hosting: ProviderId;
    runtime: ProviderId;
  };
  release?: Pick<ReleaseManifest, "releaseId" | "cliVersion">;
  resources: Record<string, string>;
  evidence: Record<string, ProviderEvidence>;
  updatedAt: string;
}

export interface ProfileStore {
  load(name: string): Promise<OnboardingProfile | undefined>;
  save(profile: OnboardingProfile): Promise<void>;
}

export function defaultProfileRoot(env = process.env): string {
  return env.OT_PROFILE_DIR?.trim() || join(homedir(), ".openthrottle", "profiles");
}

export function assertProfileName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    throw new Error("profile name must contain only letters, numbers, dots, dashes, and underscores");
  }
}

export function createProfile(input: {
  name?: string;
  hostingProvider: ProviderId;
  runtimeProvider: ProviderId;
  now?: Date;
}): OnboardingProfile {
  const name = input.name ?? "default";
  assertProfileName(name);
  assertProviderId(input.hostingProvider, "hosting provider ID");
  assertProviderId(input.runtimeProvider, "runtime provider ID");
  return {
    schema: PROFILE_SCHEMA,
    name,
    providers: {
      hosting: input.hostingProvider,
      runtime: input.runtimeProvider,
    },
    resources: {},
    evidence: {},
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
}

// Resource pins provider adapters record on the profile so a resumed setup can
// find the same external resources it created or adopted.
export const RESOURCE_KEYS = ["daytona_snapshot", "fly_app", "fly_org", "fly_region"] as const;

export type ResourceKey = (typeof RESOURCE_KEYS)[number];

export type ResourcePatch = Partial<Record<ResourceKey, string>>;

export function withResources(profile: OnboardingProfile, patch: ResourcePatch, now = new Date()): OnboardingProfile {
  const resources = { ...profile.resources };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!value.trim()) throw new Error(`profile resource ${key} must be a non-empty string`);
    resources[key] = value;
  }
  return validateProfile({ ...profile, resources, updatedAt: now.toISOString() });
}

export function validateProfile(value: unknown, expectedName?: string): OnboardingProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("profile must be a JSON object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "schema",
    "name",
    "providers",
    "release",
    "resources",
    "evidence",
    "updatedAt",
  ]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`profile has unknown field ${unknown}`);
  if (input.schema !== PROFILE_SCHEMA) throw new Error("unsupported profile schema");
  if (typeof input.name !== "string") throw new Error("profile name is required");
  assertProfileName(input.name);
  if (expectedName && input.name !== expectedName) throw new Error("profile file name does not match profile name");
  if (!input.providers || typeof input.providers !== "object" || Array.isArray(input.providers)) {
    throw new Error("profile providers are required");
  }
  const providers = input.providers as Record<string, unknown>;
  if (typeof providers.hosting !== "string" || typeof providers.runtime !== "string") {
    throw new Error("profile providers must include hosting and runtime IDs");
  }
  assertProviderId(providers.hosting, "hosting provider ID");
  assertProviderId(providers.runtime, "runtime provider ID");
  const resources = validateStringRecord(input.resources, "resources");
  const evidence = validateEvidenceRecord(input.evidence);
  let release: OnboardingProfile["release"];
  if (input.release !== undefined) {
    if (!input.release || typeof input.release !== "object" || Array.isArray(input.release)) {
      throw new Error("profile release must be an object");
    }
    const releaseInput = input.release as Record<string, unknown>;
    if (typeof releaseInput.releaseId !== "string" || typeof releaseInput.cliVersion !== "string") {
      throw new Error("profile release identity is incomplete");
    }
    release = { releaseId: releaseInput.releaseId, cliVersion: releaseInput.cliVersion };
  }
  if (typeof input.updatedAt !== "string" || Number.isNaN(Date.parse(input.updatedAt))) {
    throw new Error("profile updatedAt must be an ISO timestamp");
  }
  return {
    schema: PROFILE_SCHEMA,
    name: input.name,
    providers: { hosting: providers.hosting, runtime: providers.runtime },
    release,
    resources,
    evidence,
    updatedAt: input.updatedAt,
  };
}

function validateStringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`profile ${label} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key) || typeof entry !== "string") {
      throw new Error(`profile ${label} contains an invalid entry`);
    }
    result[key] = entry;
  }
  return result;
}

function validateEvidenceRecord(value: unknown): Record<string, ProviderEvidence> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("profile evidence must be an object");
  }
  const result: Record<string, ProviderEvidence> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) throw new Error("profile evidence key is invalid");
    result[key] = validateEvidence(entry);
  }
  return result;
}

export function validateEvidence(value: unknown): ProviderEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("profile evidence entry must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.status !== "ready" && input.status !== "needs_action" && input.status !== "error") {
    throw new Error("profile evidence status is invalid");
  }
  if (
    input.owner !== "operator" &&
    input.owner !== "hosting_provider" &&
    input.owner !== "runtime_provider" &&
    input.owner !== "supervisor" &&
    input.owner !== "cli"
  ) {
    throw new Error("profile evidence owner is invalid");
  }
  if (typeof input.summary !== "string" || input.summary.length > 500) {
    throw new Error("profile evidence summary is invalid");
  }
  if (typeof input.observedAt !== "string" || Number.isNaN(Date.parse(input.observedAt))) {
    throw new Error("profile evidence observedAt must be an ISO timestamp");
  }
  return {
    status: input.status,
    owner: input.owner,
    summary: input.summary,
    recoveryAction: typeof input.recoveryAction === "string" ? input.recoveryAction : undefined,
    resourceRef: typeof input.resourceRef === "string" ? input.resourceRef : undefined,
    releaseId: typeof input.releaseId === "string" ? input.releaseId : undefined,
    observedAt: input.observedAt,
  };
}

export class FileProfileStore implements ProfileStore {
  constructor(private readonly root = defaultProfileRoot()) {}

  async load(name = "default"): Promise<OnboardingProfile | undefined> {
    assertProfileName(name);
    const path = this.pathFor(name);
    try {
      return validateProfile(JSON.parse(readFileSync(path, "utf8")) as unknown, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(profile: OnboardingProfile): Promise<void> {
    const validated = validateProfile(profile);
    const path = this.pathFor(validated.name);
    atomicWriteJson(path, validated);
  }

  pathFor(name: string): string {
    assertProfileName(name);
    return join(this.root, `${name}.json`);
  }
}

export function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  let completed = false;
  let closed = false;
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    closeSync(fd);
    closed = true;
    renameSync(tmp, path);
    completed = true;
  } finally {
    if (!closed) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort cleanup; the original write error is more useful.
      }
    }
    if (!completed) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort cleanup; the original write error is more useful.
      }
    }
  }
}
