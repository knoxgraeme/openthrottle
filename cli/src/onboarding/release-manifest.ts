import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReleaseManifest } from "./contracts.js";
import { assertDigestPinnedImage, assertSnapshotName } from "./contracts.js";

export const RELEASE_MANIFEST_SCHEMA = "openthrottle.release-manifest/v1";

export type ReleaseManifestLoadResult =
  | { status: "pinned"; manifest: ReleaseManifest; source: string }
  | { status: "unpinned"; reason: string };

export interface LoadReleaseManifestOptions {
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
}

// The release workflow generates release-manifest.json next to package.json
// and the build copies it into dist/, so at runtime it sits one level above
// this compiled module (dist/onboarding/release-manifest.js).
export function resolveBundledReleaseManifestPath(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..", "release-manifest.json");
}

function installedCliVersion(moduleUrl = import.meta.url): string {
  const packagePath = join(dirname(fileURLToPath(moduleUrl)), "..", "..", "package.json");
  const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || !parsed.version) {
    throw new Error("CLI package.json does not declare a version");
  }
  return parsed.version;
}

export function validateReleaseManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release manifest must be a JSON object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "schema",
    "cliVersion",
    "releaseId",
    "supervisorImage",
    "sandboxImage",
    "runtime",
    "recommendedResources",
  ]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`release manifest has unknown field ${unknown}`);
  if (input.schema !== RELEASE_MANIFEST_SCHEMA) throw new Error("unsupported release manifest schema");
  if (typeof input.cliVersion !== "string" || !input.cliVersion) {
    throw new Error("release manifest cliVersion is required");
  }
  if (typeof input.releaseId !== "string" || !input.releaseId) {
    throw new Error("release manifest releaseId is required");
  }
  if (typeof input.supervisorImage !== "string" || typeof input.sandboxImage !== "string") {
    throw new Error("release manifest image references must be strings");
  }
  assertDigestPinnedImage(input.supervisorImage, "supervisor image");
  assertDigestPinnedImage(input.sandboxImage, "sandbox image");
  if (!input.runtime || typeof input.runtime !== "object" || Array.isArray(input.runtime)) {
    throw new Error("release manifest runtime must be an object");
  }
  const runtime = input.runtime as Record<string, unknown>;
  const runtimeUnknown = Object.keys(runtime).find(
    (key) => !["release", "descriptorDigest", "snapshotName"].includes(key)
  );
  if (runtimeUnknown) throw new Error(`release manifest runtime has unknown field ${runtimeUnknown}`);
  if (typeof runtime.release !== "string" || !runtime.release) {
    throw new Error("release manifest runtime.release is required");
  }
  if (typeof runtime.descriptorDigest !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(runtime.descriptorDigest)) {
    throw new Error("release manifest runtime.descriptorDigest must be a sha256:<hex> digest");
  }
  let snapshotName: string | undefined;
  if (runtime.snapshotName !== undefined) {
    if (typeof runtime.snapshotName !== "string") {
      throw new Error("release manifest runtime.snapshotName must be a string");
    }
    assertSnapshotName(runtime.snapshotName, "runtime snapshot name");
    snapshotName = runtime.snapshotName;
  }
  if (
    !input.recommendedResources ||
    typeof input.recommendedResources !== "object" ||
    Array.isArray(input.recommendedResources)
  ) {
    throw new Error("release manifest recommendedResources must be an object");
  }
  const resources = input.recommendedResources as Record<string, unknown>;
  const resourcesUnknown = Object.keys(resources).find((key) => !["cpu", "memoryMb", "diskGb"].includes(key));
  if (resourcesUnknown) throw new Error(`release manifest recommendedResources has unknown field ${resourcesUnknown}`);
  for (const key of ["cpu", "memoryMb", "diskGb"] as const) {
    const entry = resources[key];
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0) {
      throw new Error(`release manifest recommendedResources.${key} must be a positive number`);
    }
  }
  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    cliVersion: input.cliVersion,
    releaseId: input.releaseId,
    supervisorImage: input.supervisorImage,
    sandboxImage: input.sandboxImage,
    runtime: {
      release: runtime.release,
      descriptorDigest: runtime.descriptorDigest,
      ...(snapshotName !== undefined ? { snapshotName } : {}),
    },
    recommendedResources: {
      cpu: resources.cpu as number,
      memoryMb: resources.memoryMb as number,
      diskGb: resources.diskGb as number,
    },
  };
}

export function loadReleaseManifest(options: LoadReleaseManifestOptions = {}): ReleaseManifestLoadResult {
  const env = options.env ?? process.env;
  const override = env.OT_RELEASE_MANIFEST?.trim();
  const source = override || resolveBundledReleaseManifestPath(options.moduleUrl);
  let raw: string;
  try {
    raw = readFileSync(source, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (override) throw new Error(`OT_RELEASE_MANIFEST points at a missing file: ${source}`);
      return {
        status: "unpinned",
        reason: "no release manifest is bundled with this install and OT_RELEASE_MANIFEST is not set",
      };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`release manifest at ${source} is not valid JSON`);
  }
  const manifest = validateReleaseManifest(parsed);
  const cliVersion = installedCliVersion(options.moduleUrl);
  if (manifest.cliVersion !== cliVersion) {
    throw new Error(
      `release manifest cliVersion ${manifest.cliVersion} does not match installed CLI version ${cliVersion}; ` +
        "reinstall the openthrottle CLI or regenerate the manifest"
    );
  }
  return { status: "pinned", manifest, source };
}
