import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const imageRuntimePath = "/opt/openthrottle/generated/runtime";
const repositoryRuntimePath = resolve(
  fileURLToPath(new URL("../../contracts/generated/runtime/", import.meta.url)),
);
const runtimeRoot = existsSync(imageRuntimePath) ? imageRuntimePath : repositoryRuntimePath;

const [candidateRuntime, canonicalRuntime, validationRuntime] = await Promise.all([
  import(pathToFileURL(resolve(runtimeRoot, "result-candidate.js")).href),
  import(pathToFileURL(resolve(runtimeRoot, "canonical.js")).href),
  import(pathToFileURL(resolve(runtimeRoot, "validation.js")).href),
]);

export const {
  CORE_SEMANTIC_RESULT_SCHEMAS,
  RESULT_CANDIDATE_MAX_BYTES,
  RESULT_CANDIDATE_SCHEMA,
  providerJsonSchemaForResultCandidate,
  validateAndNormalizeResultCandidate,
  validateSemanticResultSchema,
} = candidateRuntime;
export const { canonicalJson, digestCanonicalJson } = canonicalRuntime;
export const { contractValidationIssue } = validationRuntime;
