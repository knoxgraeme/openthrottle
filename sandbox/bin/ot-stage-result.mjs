#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentJson, validateSemanticProposal, validateStandardReceipt } from "../runner/artifacts.mjs";

export function parseProposalInput(raw, { receipt = false } = {}) {
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("stage result input exceeds 64 KiB");
  // The `--file` argument names a file the model wrote, so it is agent-authored
  // JSON and gets the same one-fence tolerance as the loop receipt (OPE-101).
  const parsed = parseAgentJson(raw);
  return receipt ? validateStandardReceipt(parsed) : validateSemanticProposal(parsed);
}

export async function writeProposal(proposal, outputPath, { receipt = false } = {}) {
  const normalized = receipt ? validateStandardReceipt(proposal) : validateSemanticProposal(proposal);
  const path = resolve(outputPath);
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(normalized)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return path;
}

async function main() {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf("--file");
  const outputIndex = args.indexOf("--output");
  const receipt = args.includes("--receipt");
  const output = outputIndex >= 0
    ? args[outputIndex + 1]
    : process.env.OT_STAGE_PROPOSAL_FILE ?? "/home/agent/.ot/stage/proposal.json";
  if (!output) throw new Error("proposal output path is missing");
  const raw = fileIndex >= 0
    ? await readFile(resolve(args[fileIndex + 1]), "utf8")
    : args.find((arg, index) => index !== outputIndex && index !== outputIndex + 1);
  if (!raw) throw new Error("Usage: ot-stage-result [--receipt] [--file proposal.json | '<proposal-json>'] [--output path]");
  await writeProposal(parseProposalInput(raw, { receipt }), output, { receipt });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]))) {
  main().catch((error) => {
    console.error(`ot-stage-result: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
