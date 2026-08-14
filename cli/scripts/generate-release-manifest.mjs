#!/usr/bin/env node
// Generates cli/release-manifest.json for a release build. The manifest pins
// the supervisor and sandbox images by digest plus the runtime capability
// descriptor those images were built against; `npm run build` then copies it
// into dist/ (copy-planning-skills.mjs). The file is generated per release and
// is never committed.
//
// Usage:
//   node scripts/generate-release-manifest.mjs \
//     --supervisor-image <ref@sha256:...> --sandbox-image <ref@sha256:...> \
//     [--snapshot-name <name>] [--release-id <id>]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packagePath = resolve(here, "../package.json");
const descriptorPath = resolve(here, "../../supervisor/pipelines/runtime-capabilities-v1.json");
const outputPath = resolve(here, "../release-manifest.json");

// Matches the supervisor's admission defaults (DAYTONA_SANDBOX_MEMORY_GIB=8 in
// supervisor/src/app/config.ts) and keeps per-sandbox disk small relative to
// the runtime provider's org-wide disk quota.
const recommendedResources = { cpu: 2, memoryMb: 8192, diskGb: 10 };

function parseArgs(argv) {
  const flags = {
    "--supervisor-image": "supervisorImage",
    "--sandbox-image": "sandboxImage",
    "--snapshot-name": "snapshotName",
    "--release-id": "releaseId",
  };
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = flags[argv[index]];
    const value = argv[index + 1];
    if (!key) throw new Error(`unknown argument: ${argv[index]}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`${argv[index]} requires a value`);
    if (options[key] !== undefined) throw new Error(`${argv[index]} was provided twice`);
    options[key] = value;
  }
  if (!options.supervisorImage || !options.sandboxImage) {
    throw new Error(
      "usage: generate-release-manifest.mjs --supervisor-image <ref@sha256:...> --sandbox-image <ref@sha256:...> [--snapshot-name <name>] [--release-id <id>]"
    );
  }
  return options;
}

// Key-sorted canonical JSON, byte-identical to contracts/src/canonical.ts, so
// the digest equals the supervisor's own descriptor digest
// (digestNormalized(canonicalJson(descriptor)); the same value is recorded as
// bare hex under runtime.digest in supervisor/pipelines/v12-deploy-proof.json).
// Inlined so this script runs before any npm ci, like copy-planning-skills.mjs.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// Minimal duplicate of the checks in cli/src/onboarding/release-manifest.ts so
// the generated file always passes loadReleaseManifest.
function validateGeneratedManifest(manifest) {
  for (const [label, image] of [
    ["supervisor image", manifest.supervisorImage],
    ["sandbox image", manifest.sandboxImage],
  ]) {
    if (!/^[^@\s]+@sha256:[a-f0-9]{64}$/i.test(image)) {
      throw new Error(`${label} must be a digest-pinned image reference`);
    }
  }
  if (manifest.schema !== "openthrottle.release-manifest/v1") throw new Error("unsupported release manifest schema");
  if (!manifest.cliVersion || !manifest.releaseId) throw new Error("release manifest identity is incomplete");
  if (!manifest.runtime.release) throw new Error("release manifest runtime.release is required");
  if (!/^sha256:[a-f0-9]{64}$/i.test(manifest.runtime.descriptorDigest)) {
    throw new Error("release manifest runtime.descriptorDigest must be a sha256:<hex> digest");
  }
  if (manifest.runtime.snapshotName !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.runtime.snapshotName)) {
    throw new Error("runtime snapshot name must be 1-128 characters of letters, numbers, dots, dashes, and underscores");
  }
  for (const key of ["cpu", "memoryMb", "diskGb"]) {
    const entry = manifest.recommendedResources[key];
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0) {
      throw new Error(`release manifest recommendedResources.${key} must be a positive number`);
    }
  }
}

const options = parseArgs(process.argv.slice(2));

const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
if (typeof packageJson.version !== "string" || !packageJson.version) {
  throw new Error("cli/package.json does not declare a version");
}
const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
if (typeof descriptor.release !== "string" || !descriptor.release) {
  throw new Error("runtime capability descriptor does not declare a release");
}
const descriptorDigest = `sha256:${createHash("sha256").update(canonicalJson(descriptor), "utf8").digest("hex")}`;

const manifest = {
  schema: "openthrottle.release-manifest/v1",
  cliVersion: packageJson.version,
  releaseId: options.releaseId ?? packageJson.version,
  supervisorImage: options.supervisorImage,
  sandboxImage: options.sandboxImage,
  runtime: {
    release: descriptor.release,
    descriptorDigest,
    ...(options.snapshotName !== undefined ? { snapshotName: options.snapshotName } : {}),
  },
  recommendedResources,
};

validateGeneratedManifest(manifest);
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outputPath} (release ${manifest.releaseId}, runtime ${manifest.runtime.release})`);
