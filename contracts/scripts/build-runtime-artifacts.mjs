#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const contractsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(contractsRoot, "..");
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
const compilerEnvironment = await import(
  pathToFileURL(join(contractsRoot, "dist/compiler-environment.js")).href
);
const platformCatalog = await import(
  pathToFileURL(join(contractsRoot, "dist/platform-definition-catalog.js")).href
);
const definitionRelease = await import(
  pathToFileURL(join(contractsRoot, "dist/definition-release.js")).href
);
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

function platformDefinitionPaths() {
  const paths = [];
  const visit = (directory) => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`platform definition source must be a real directory: ${relative(repositoryRoot, directory)}`);
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`platform definition source contains a symlink: ${relative(repositoryRoot, absolute)}`);
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) paths.push(relative(repositoryRoot, absolute).replaceAll("\\", "/"));
      else throw new Error(`platform definition source contains a non-file: ${relative(repositoryRoot, absolute)}`);
    }
  };
  for (const category of ["agents", "evals", "pipelines", "skills"]) {
    visit(join(repositoryRoot, ".openthrottle", category, "core"));
  }
  return paths.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

const catalogContent = {
  schema: platformCatalog.PLATFORM_DEFINITION_CATALOG_SCHEMA,
  version: platformCatalog.PLATFORM_DEFINITION_CATALOG_VERSION,
  files: platformDefinitionPaths().map((path) => {
    const bytes = readFileSync(join(repositoryRoot, path));
    return { path, byte_size: bytes.byteLength, sha256: bytesDigest(bytes) };
  }),
};
const definitionCatalog = {
  ...catalogContent,
  catalog_digest: canonical.digestCanonicalJson(catalogContent),
};
platformCatalog.validatePlatformDefinitionCatalog(definitionCatalog);
if (
  definitionCatalog.catalog_digest !==
  definitionRelease.RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST
) {
  throw new Error(
    "source-derived platform catalog differs from the compiled release trust anchor",
  );
}
writeOrCheck(
  "platform-definition-catalog.json",
  Buffer.from(`${canonical.canonicalJson(definitionCatalog)}\n`, "utf8"),
);

const runtimeManifest = JSON.parse(readFileSync(
  join(repositoryRoot, "supervisor/pipelines/runtime-capabilities-v1.json"),
  "utf8",
));
const evaluatorPrimitives = [...compilerEnvironment.CORE_EVALUATOR_PRIMITIVES];
const runtimeCapabilityInputs = {
  runtime_manifest_digest: canonical.digestCanonicalJson(runtimeManifest),
  validator_artifact_set_digest: artifactSet.artifact_set_digest,
};
const environmentContent = {
  schema: compilerEnvironment.COMPILER_ENVIRONMENT_SCHEMA,
  version: compilerEnvironment.COMPILER_ENVIRONMENT_VERSION,
  compiler_version: compilerEnvironment.DEFINITION_COMPILER_VERSION,
  runtime_capability_inputs: runtimeCapabilityInputs,
  runtime_capability_digest: compilerEnvironment.runtimeCapabilityDigest({
    ...runtimeCapabilityInputs,
    evaluator_primitives: evaluatorPrimitives,
  }),
  evaluator_primitives: evaluatorPrimitives,
};
const environment = {
  ...environmentContent,
  environment_digest: canonical.digestCanonicalJson(environmentContent),
};
compilerEnvironment.validateCompilerEnvironmentDescriptor(environment);
if (
  environment.environment_digest !==
  definitionRelease.RELEASE_COMPILER_ENVIRONMENT_DIGEST
) {
  throw new Error(
    "source-derived compiler environment differs from the compiled release trust anchor",
  );
}
writeOrCheck(
  "compiler-environment.json",
  Buffer.from(`${canonical.canonicalJson(environment)}\n`, "utf8"),
);

const expectedPaths = [
  ...entries.map((entry) => entry.path),
  "artifact-set.json",
  "compiler-environment.json",
  "platform-definition-catalog.json",
].sort();
const actualPaths = generatedFiles().sort();
if (canonical.canonicalJson(actualPaths) !== canonical.canonicalJson(expectedPaths)) {
  throw new Error("generated runtime artifact directory contains missing or unsealed files");
}

process.stdout.write(
  `${checking ? "verified" : "generated"} ${entries.length} sealed runtime artifacts and ${definitionCatalog.files.length} platform definitions\n`,
);
