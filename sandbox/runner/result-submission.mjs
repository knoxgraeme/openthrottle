import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { link, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RESULT_CANDIDATE_SCHEMA,
  RESULT_CANDIDATE_MAX_BYTES,
  canonicalJson,
  contractValidationIssue,
  digestCanonicalJson,
  providerJsonSchemaForResultCandidate,
  validateAndNormalizeResultCandidate,
  validateSemanticResultSchema,
} from "./generated-result-contracts.mjs";

export const STAGED_RESULT_CANDIDATE_SCHEMA = "openthrottle.staged-result-candidate/v1";
export const REJECTED_RESULT_CANDIDATE_SCHEMA = "openthrottle.rejected-result-candidate/v1";
export const RESULT_SUBMISSION_CHANNEL_SCHEMA = "openthrottle.result-submission-channel/v1";

const PROVIDER_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
const RESULT_TOOL_PATH = fileURLToPath(new URL("../bin/ot-result.mjs", import.meta.url));

const STAGED_KEYS = new Set([
  "schema",
  "semantic_schema_id",
  "original",
  "original_hash",
  "candidate",
  "normalized_hash",
  "transformations",
]);
const REJECTED_KEYS = new Set([
  "schema",
  "raw",
  "raw_hash",
  "original_hash",
  "diagnostics",
]);

export class ResultCandidateValidationError extends Error {
  constructor(diagnostics, cause) {
    super(diagnostics.map(({ path, detail }) => `${path}: ${detail}`).join("; "), { cause });
    this.name = "ResultCandidateValidationError";
    this.diagnostics = diagnostics;
  }
}

export class ResultCandidateConflictError extends Error {
  constructor() {
    super("a different result candidate is already staged for this action");
    this.name = "ResultCandidateConflictError";
  }
}

function exactObject(value, label, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(`${label}.${key}: unknown field`);
  }
  return value;
}

function diagnosticFor(error) {
  const structured = typeof contractValidationIssue === "function"
    ? contractValidationIssue(error)
    : error?.issue;
  if (structured?.path && structured?.detail) return { ...structured };
  const message = error instanceof Error ? error.message : String(error);
  const separator = message.indexOf(": ");
  return separator > 0 ? {
    path: message.slice(0, separator),
    detail: message.slice(separator + 2),
  } : {
    path: "result_candidate",
    detail: message,
  };
}

export function normalizeSubmittedResult(value, semanticSchema) {
  const schema = validateSemanticResultSchema(semanticSchema, {
    source: "semantic_result_schema",
  }).value;
  try {
    const normalized = validateAndNormalizeResultCandidate(value, schema, {
      source: "result_candidate",
    });
    return {
      schema: STAGED_RESULT_CANDIDATE_SCHEMA,
      semantic_schema_id: schema.id,
      original: value,
      original_hash: normalized.original_hash,
      candidate: normalized.value,
      normalized_hash: normalized.normalized_hash,
      transformations: normalized.transformations,
    };
  } catch (error) {
    throw new ResultCandidateValidationError([diagnosticFor(error)], error);
  }
}

export function validateStagedResultCandidate(value, semanticSchema) {
  const input = exactObject(value, "staged_result_candidate", STAGED_KEYS);
  if (input.schema !== STAGED_RESULT_CANDIDATE_SCHEMA) {
    throw new Error(`staged_result_candidate.schema: must be ${STAGED_RESULT_CANDIDATE_SCHEMA}`);
  }
  const expected = normalizeSubmittedResult(input.original, semanticSchema);
  if (input.semantic_schema_id !== expected.semantic_schema_id) {
    throw new Error("staged_result_candidate.semantic_schema_id: does not match the sealed semantic schema");
  }
  if (input.original_hash !== expected.original_hash) {
    throw new Error("staged_result_candidate.original_hash: does not match canonical original bytes");
  }
  if (canonicalJson(input.candidate) !== canonicalJson(expected.candidate)) {
    throw new Error("staged_result_candidate.candidate: does not match normalized candidate bytes");
  }
  if (input.normalized_hash !== expected.normalized_hash) {
    throw new Error("staged_result_candidate.normalized_hash: does not match normalized candidate bytes");
  }
  if (canonicalJson(input.transformations) !== canonicalJson(expected.transformations)) {
    throw new Error("staged_result_candidate.transformations: do not match deterministic normalization");
  }
  return expected;
}

export function parseSubmittedResult(raw) {
  if (typeof raw !== "string") throw new Error("result candidate input must be UTF-8 text");
  if (Buffer.byteLength(raw, "utf8") > RESULT_CANDIDATE_MAX_BYTES) {
    throw new Error(`result candidate input exceeds ${RESULT_CANDIDATE_MAX_BYTES} UTF-8 bytes`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ResultCandidateValidationError([{
      path: "result_candidate",
      detail: "must be one complete JSON object",
    }], error);
  }
}

function rawDigest(raw) {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function rejectionEvidence(raw, error) {
  const evidence = candidateDiagnosticEvidence({ raw, error });
  return {
    schema: REJECTED_RESULT_CANDIDATE_SCHEMA,
    raw,
    raw_hash: rawDigest(raw),
    original_hash: evidence.original_hash,
    diagnostics: evidence.diagnostics,
  };
}

export function validateRejectedResultCandidate(value, semanticSchema) {
  const input = exactObject(value, "rejected_result_candidate", REJECTED_KEYS);
  if (input.schema !== REJECTED_RESULT_CANDIDATE_SCHEMA) {
    throw new Error(`rejected_result_candidate.schema: must be ${REJECTED_RESULT_CANDIDATE_SCHEMA}`);
  }
  if (typeof input.raw !== "string" || Buffer.byteLength(input.raw, "utf8") > RESULT_CANDIDATE_MAX_BYTES) {
    throw new Error("rejected_result_candidate.raw: must be bounded UTF-8 text");
  }
  if (input.raw_hash !== rawDigest(input.raw)) {
    throw new Error("rejected_result_candidate.raw_hash: does not match the rejected bytes");
  }
  let failure;
  try {
    const parsed = parseSubmittedResult(input.raw);
    normalizeSubmittedResult(parsed, semanticSchema);
  } catch (error) {
    failure = error;
  }
  if (!failure) throw new Error("rejected_result_candidate.raw: is a valid result candidate");
  const expected = rejectionEvidence(input.raw, failure);
  if (input.original_hash !== expected.original_hash) {
    throw new Error("rejected_result_candidate.original_hash: does not match the rejected candidate");
  }
  if (canonicalJson(input.diagnostics) !== canonicalJson(expected.diagnostics)) {
    throw new Error("rejected_result_candidate.diagnostics: do not match generated validation");
  }
  return expected;
}

export async function writeRejectedResultCandidate({ raw, error, outputPath }) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > RESULT_CANDIDATE_MAX_BYTES) {
    throw new Error(`rejected result candidate exceeds ${RESULT_CANDIDATE_MAX_BYTES} UTF-8 bytes`);
  }
  const evidence = rejectionEvidence(raw, error);
  const path = resolve(outputPath);
  const directoryPath = dirname(path);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${canonicalJson(evidence)}\n`, { mode: 0o600, flag: "wx" });
    const handle = await open(temporaryPath, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    await syncDirectory(directoryPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
  return evidence;
}

export async function readBoundedResultFile(path, maxBytes = RESULT_CANDIDATE_MAX_BYTES) {
  const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("result candidate input must be a regular file");
    if (before.size > maxBytes) throw new Error(`result candidate input exceeds ${maxBytes} UTF-8 bytes`);
    const raw = await handle.readFile("utf8");
    const after = await handle.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("result candidate input changed while it was read");
    }
    return raw;
  } finally {
    await handle.close();
  }
}

export function readBoundedResultFileSync(path, maxBytes = RESULT_CANDIDATE_MAX_BYTES) {
  const descriptor = openSync(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error("result candidate input must be a regular file");
    if (before.size > maxBytes) throw new Error(`result candidate input exceeds ${maxBytes} UTF-8 bytes`);
    const raw = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("result candidate input changed while it was read");
    }
    return raw;
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectorySync(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeImmutableJsonSync(path, value, label) {
  const serialized = `${canonicalJson(value)}\n`;
  try {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o444);
    try {
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    syncDirectorySync(dirname(path));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readBoundedResultFileSync(path);
    if (existing !== serialized) throw new Error(`${label} conflicts with the sealed action channel`);
  }
}

function pathInside(root, child, label) {
  const normalizedRoot = resolve(root);
  const normalizedChild = resolve(child);
  if (normalizedRoot === "/" || (normalizedChild !== normalizedRoot && !normalizedChild.startsWith(`${normalizedRoot}/`))) {
    throw new Error(`${label} escapes the action result root`);
  }
  return normalizedChild;
}

export function materializeResultSubmissionChannel({
  actionDirectory,
  candidateDirectory = actionDirectory,
  semanticSchema,
}) {
  const root = resolve(actionDirectory);
  if (root === "/") throw new Error("result action directory is unsafe");
  const candidateRoot = pathInside(root, candidateDirectory, "result candidate directory");
  mkdirSync(root, { recursive: true, mode: 0o711 });
  mkdirSync(candidateRoot, { recursive: true, mode: 0o700 });
  const schema = validateSemanticResultSchema(semanticSchema, {
    source: "semantic_result_schema",
  }).value;
  const schemaPath = pathInside(root, join(root, "semantic-result.schema.json"), "semantic schema path");
  const providerSchemaPath = pathInside(root, join(root, "provider-result.schema.json"), "provider schema path");
  const candidatePath = pathInside(root, join(candidateRoot, "candidate.json"), "result candidate path");
  const rejectionPath = pathInside(root, join(candidateRoot, "rejected.json"), "result rejection path");
  writeImmutableJsonSync(schemaPath, schema, "semantic result schema");
  writeImmutableJsonSync(
    providerSchemaPath,
    providerJsonSchemaForResultCandidate(schema),
    "provider result schema",
  );
  return {
    schema: RESULT_SUBMISSION_CHANNEL_SCHEMA,
    semantic_schema_id: schema.id,
    semantic_schema: schema,
    schema_path: schemaPath,
    provider_schema_path: providerSchemaPath,
    candidate_path: candidatePath,
    rejection_path: rejectionPath,
  };
}

export function resultSubmissionEnvironment(channel) {
  if (channel?.schema !== RESULT_SUBMISSION_CHANNEL_SCHEMA) {
    throw new Error("result submission channel is invalid");
  }
  return [
    `OT_RESULT_SCHEMA_FILE=${channel.schema_path}`,
    `OT_RESULT_CANDIDATE_FILE=${channel.candidate_path}`,
    `OT_RESULT_REJECTION_FILE=${channel.rejection_path}`,
  ];
}

async function syncDirectory(path) {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readExisting(path, semanticSchema) {
  const raw = await readBoundedResultFile(path, RESULT_CANDIDATE_MAX_BYTES * 2);
  return validateStagedResultCandidate(JSON.parse(raw), semanticSchema);
}

function readExistingSync(path, semanticSchema) {
  const raw = readBoundedResultFileSync(path, RESULT_CANDIDATE_MAX_BYTES * 2);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("staged result candidate is not valid JSON", { cause: error });
  }
  return validateStagedResultCandidate(parsed, semanticSchema);
}

function sameOriginal(left, right) {
  return left.original_hash === right.original_hash &&
    canonicalJson(left.original) === canonicalJson(right.original);
}

export async function stageResultCandidate({ value, semanticSchema, outputPath }) {
  const staged = normalizeSubmittedResult(value, semanticSchema);
  const path = resolve(outputPath);
  const directoryPath = dirname(path);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(`${canonicalJson(staged)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, path);
      await syncDirectory(directoryPath);
      return { staged, replayed: false };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readExisting(path, semanticSchema);
      if (!sameOriginal(existing, staged)) throw new ResultCandidateConflictError();
      return { staged: existing, replayed: true };
    }
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => {});
  }
}

export async function loadSemanticResultSchema(path) {
  const raw = await readBoundedResultFile(path);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("sealed semantic result schema is not valid JSON", { cause: error });
  }
  return validateSemanticResultSchema(parsed, { source: "semantic_result_schema" }).value;
}

export function inspectResultSubmissionChannel(channel) {
  if (channel?.schema !== RESULT_SUBMISSION_CHANNEL_SCHEMA) {
    throw new Error("result submission channel is invalid");
  }
  const semanticSchema = validateSemanticResultSchema(channel.semantic_schema, {
    source: "semantic_result_schema",
  }).value;
  if (existsSync(channel.candidate_path)) {
    return {
      status: "valid",
      staged: readExistingSync(channel.candidate_path, semanticSchema),
    };
  }
  if (existsSync(channel.rejection_path)) {
    const raw = readBoundedResultFileSync(channel.rejection_path, RESULT_CANDIDATE_MAX_BYTES * 2);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error("rejected result candidate evidence is not valid JSON", { cause: error });
    }
    const rejected = validateRejectedResultCandidate(parsed, semanticSchema);
    return {
      status: "invalid",
      original_hash: rejected.original_hash,
      diagnostics: rejected.diagnostics,
      rejected,
    };
  }
  return {
    status: "missing",
    diagnostics: [{
      path: "result_candidate",
      detail: "no result candidate was submitted",
    }],
  };
}

function providerEventSources(event, engine) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return [];
  if (engine === "claude" && event.type === "result") {
    if (event.structured_output !== undefined && event.structured_output !== null) {
      return [event.structured_output];
    }
    return event.result === undefined ? [] : [event.result];
  }
  if (engine === "codex" && event.type === "item.completed" && event.item?.type === "agent_message") {
    return typeof event.item.text === "string" ? [event.item.text] : [];
  }
  if (engine === "opencode" && event.type === "text" && typeof event.part?.text === "string") {
    return [event.part.text];
  }
  return [];
}

function parsedProviderSource(source) {
  if (source && typeof source === "object" && !Array.isArray(source)) return source;
  if (typeof source !== "string" || !source.trim()) return null;
  try {
    return JSON.parse(source.trim());
  } catch {
    return null;
  }
}

function isResultCandidateAttempt(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    value.schema === RESULT_CANDIDATE_SCHEMA;
}

export function extractProviderResultCandidate(raw, engine) {
  if (!["claude", "codex", "opencode"].includes(engine)) {
    throw new Error(`unsupported result provider ${engine}`);
  }
  if (typeof raw !== "string") throw new Error("provider result output must be UTF-8 text");
  if (Buffer.byteLength(raw, "utf8") > PROVIDER_OUTPUT_MAX_BYTES) {
    throw new Error(`provider result output exceeds ${PROVIDER_OUTPUT_MAX_BYTES} UTF-8 bytes`);
  }
  const sources = [];
  const whole = parsedProviderSource(raw);
  if (isResultCandidateAttempt(whole)) sources.push(whole);
  for (const line of raw.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    sources.push(...providerEventSources(event, engine));
  }
  const candidates = [];
  for (const source of sources) {
    const parsed = parsedProviderSource(source);
    if (isResultCandidateAttempt(parsed)) candidates.push(parsed);
  }
  const unique = new Map(candidates.map((candidate) => [canonicalJson(candidate), candidate]));
  if (unique.size > 1) {
    return {
      status: "invalid",
      original_hash: null,
      diagnostics: [{
        path: "result_candidate",
        detail: "provider emitted conflicting final result candidates",
      }],
    };
  }
  if (unique.size === 1) {
    const value = [...unique.values()][0];
    return { status: "candidate", value, raw: canonicalJson(value) };
  }
  if (sources.length > 0) {
    const last = sources[sources.length - 1];
    const lastRaw = typeof last === "string" ? last : canonicalJson(last);
    return {
      status: "invalid",
      original_hash: null,
      raw: lastRaw,
      diagnostics: [{
        path: "result_candidate",
        detail: "provider final output must be one complete result-candidate JSON object",
      }],
    };
  }
  return {
    status: "missing",
    diagnostics: [{
      path: "result_candidate",
      detail: "provider did not emit a final result candidate",
    }],
  };
}

function parsedToolOutput(raw) {
  try {
    const parsed = JSON.parse(String(raw).trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function submitRawThroughResultToolSync(raw, channel) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ot-provider-result-"));
  const inputPath = join(temporaryDirectory, "candidate.json");
  try {
    writeFileSync(inputPath, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const result = spawnSync(process.execPath, [RESULT_TOOL_PATH, "submit", "--file", inputPath], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
        OT_RESULT_SCHEMA_FILE: channel.schema_path,
        OT_RESULT_CANDIDATE_FILE: channel.candidate_path,
        OT_RESULT_REJECTION_FILE: channel.rejection_path,
      },
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error?.message ?? "",
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function submitProviderResultCandidate({ raw, engine, channel }) {
  const extracted = extractProviderResultCandidate(raw, engine);
  if (extracted.status === "missing") {
    const submitted = inspectResultSubmissionChannel(channel);
    return submitted.status === "missing" ? extracted : submitted;
  }
  if (extracted.status === "invalid" && extracted.raw === undefined) return extracted;
  const tool = submitRawThroughResultToolSync(extracted.raw, channel);
  if (tool.status === 0) {
    const submitted = inspectResultSubmissionChannel(channel);
    if (submitted.status !== "valid") throw new Error("result tool accepted a candidate without staging it");
    return submitted;
  }
  if (tool.status === 2) {
    const submitted = inspectResultSubmissionChannel(channel);
    // A successful explicit ot-result submission already won the action CAS.
    // Some providers still append malformed or narrative final text after the
    // tool call. That later invalid value cannot revoke the sealed candidate;
    // a different valid candidate still reaches the conflict path below.
    if (submitted.status === "valid") return submitted;
    if (submitted.status === "invalid") return submitted;
    const body = parsedToolOutput(tool.stderr);
    return {
      status: "invalid",
      original_hash: null,
      diagnostics: Array.isArray(body.diagnostics) ? body.diagnostics : extracted.diagnostics,
    };
  }
  const body = parsedToolOutput(tool.stderr);
  if (typeof body.error === "string" && /different result candidate|already staged/.test(body.error)) {
    return {
      status: "invalid",
      original_hash: digestCanonicalJson(extracted.value),
      raw: extracted.raw,
      diagnostics: [{ path: "result_candidate", detail: body.error }],
    };
  }
  throw new Error(
    `provider result submission failed (${tool.signal ?? tool.status ?? "no status"}): ` +
    `${typeof body.error === "string" ? body.error : tool.stderr.trim() || "unknown error"}`,
  );
}

export function candidateDiagnosticEvidence({ raw, error }) {
  const diagnostics = error instanceof ResultCandidateValidationError
    ? error.diagnostics
    : [diagnosticFor(error)];
  let originalHash = null;
  try {
    originalHash = digestCanonicalJson(JSON.parse(raw));
  } catch {
    // Non-JSON output has no canonical candidate hash. The caller may retain
    // a separately bounded raw-output digest in its executor evidence.
  }
  return { original_hash: originalHash, diagnostics };
}
