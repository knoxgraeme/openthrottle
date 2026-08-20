#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const contractsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedRoot = join(contractsRoot, "generated");
const checking = process.argv.slice(2).includes("--check");

if (!checking) rmSync(generatedRoot, { recursive: true, force: true });

function bytesDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function generatedPath(path) {
  const target = resolve(generatedRoot, path);
  if (target !== generatedRoot && !target.startsWith(`${generatedRoot}/`)) {
    throw new Error(`generated path escapes contracts/generated: ${path}`);
  }
  return target;
}

function writeOrCheck(path, bytes) {
  const target = generatedPath(path);
  if (checking) {
    if (!existsSync(target) || !readFileSync(target).equals(bytes)) {
      throw new Error(`generated runtime artifact is stale: ${relative(contractsRoot, target)}`);
    }
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

function generatedFiles(directory = generatedRoot, prefix = "") {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? generatedFiles(join(directory, entry.name), path) : [path];
  });
}

const runtime = await import(pathToFileURL(join(contractsRoot, "dist/result-candidate.js")).href);
const canonical = await import(pathToFileURL(join(contractsRoot, "dist/canonical.js")).href);
const artifacts = new Map();

for (const file of ["canonical.js", "validation.js", "result-candidate.js"]) {
  artifacts.set(`runtime/${file}`, readFileSync(join(contractsRoot, "dist", file)));
}
artifacts.set(
  "runtime/index.js",
  Buffer.from('export * from "./result-candidate.js";\n', "utf8"),
);

for (const rawSchema of runtime.CORE_SEMANTIC_RESULT_SCHEMAS) {
  const semanticSchema = runtime.validateSemanticResultSchema(rawSchema).value;
  const providerSchema = runtime.providerJsonSchemaForResultCandidate(semanticSchema);
  const safeId = semanticSchema.id.replaceAll("/", "--");
  artifacts.set(
    `provider-schemas/${safeId}.schema.json`,
    Buffer.from(`${canonical.canonicalJson(providerSchema)}\n`, "utf8"),
  );
}

for (const [path, bytes] of artifacts) writeOrCheck(path, bytes);

const entries = [...artifacts.entries()]
  .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: bytesDigest(bytes) }))
  .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
const artifactSetContent = {
  schema: "openthrottle.runtime-artifact-set/v1",
  artifacts: entries,
};
const artifactSet = {
  ...artifactSetContent,
  artifact_set_digest: bytesDigest(Buffer.from(canonical.canonicalJson(artifactSetContent), "utf8")),
};
writeOrCheck("artifact-set.json", Buffer.from(`${canonical.canonicalJson(artifactSet)}\n`, "utf8"));

const expectedPaths = [...entries.map((entry) => entry.path), "artifact-set.json"].sort();
const actualPaths = generatedFiles().sort();
if (canonical.canonicalJson(actualPaths) !== canonical.canonicalJson(expectedPaths)) {
  throw new Error("generated runtime artifact directory contains missing or unsealed files");
}

process.stdout.write(`${checking ? "verified" : "generated"} ${entries.length} sealed runtime artifacts\n`);
