#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ResultCandidateValidationError,
  loadSemanticResultSchema,
  parseSubmittedResult,
  readBoundedResultFile,
  stageResultCandidate,
  writeRejectedResultCandidate,
} from "../runner/result-submission.mjs";

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export async function submitResult(args, env = process.env) {
  if (args[0] !== "submit") {
    throw new Error("Usage: ot-result submit --file <candidate.json>");
  }
  const file = option(args, "--file");
  if (!file) throw new Error("Usage: ot-result submit --file <candidate.json>");
  const known = new Set(["submit", "--file", file]);
  const unknown = args.find((arg) => !known.has(arg));
  if (unknown) throw new Error(`unknown argument ${unknown}`);
  const schemaPath = env.OT_RESULT_SCHEMA_FILE;
  const outputPath = env.OT_RESULT_CANDIDATE_FILE;
  const rejectionPath = env.OT_RESULT_REJECTION_FILE;
  if (!schemaPath || !outputPath) throw new Error("result submission is not enabled for this action");

  const [raw, semanticSchema] = await Promise.all([
    readBoundedResultFile(file),
    loadSemanticResultSchema(schemaPath),
  ]);
  let result;
  try {
    const value = parseSubmittedResult(raw);
    result = await stageResultCandidate({ value, semanticSchema, outputPath });
  } catch (error) {
    if (rejectionPath && error instanceof ResultCandidateValidationError) {
      await writeRejectedResultCandidate({ raw, error, outputPath: rejectionPath });
    }
    throw error;
  }
  return {
    accepted: true,
    replayed: result.replayed,
    original_hash: result.staged.original_hash,
    normalized_hash: result.staged.normalized_hash,
    transformations: result.staged.transformations,
  };
}

async function main() {
  try {
    process.stdout.write(`${JSON.stringify(await submitResult(process.argv.slice(2)))}\n`);
  } catch (error) {
    const body = error instanceof ResultCandidateValidationError
      ? { accepted: false, diagnostics: error.diagnostics }
      : { accepted: false, error: error instanceof Error ? error.message : String(error) };
    process.stderr.write(`${JSON.stringify(body)}\n`);
    process.exitCode = error instanceof ResultCandidateValidationError ? 2 : 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]))) {
  await main();
}
