import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson } from "./kernel-json.mjs";

export const SESSION_ARTIFACT_DESCRIPTOR_SCHEMA =
  "openthrottle.session-artifact-descriptor/v1";
export const OTEL_SESSION_TRANSCRIPT_PAYLOAD_SCHEMA =
  "openthrottle.otel-session-transcript/v1";
export const COMPOSED_PROMPT_PAYLOAD_SCHEMA =
  "openthrottle.composed-prompt/v1";
export const SESSION_NATIVE_LOG_MAX_BYTES = 16 * 1024 * 1024;
export const SESSION_PROMPT_MAX_BYTES = 4 * 1024 * 1024;
export const SESSION_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

const PROMPT_FILE = "composed-prompt.txt";
const WORK_LOG_FILE = "native-work.log";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function syncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function immutableBytes(path, bytes, label, maximumBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
    throw new Error(`${label} is outside its byte bound`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o400,
    );
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    syncDirectory(dirname(path));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!readFileSync(path).equals(bytes)) {
      throw new Error(`${label} conflicts with immutable session evidence`);
    }
  }
  return path;
}

export function sessionCaptureDirectory(actionDirectory) {
  return join(actionDirectory, "session-evidence");
}

export function captureComposedPrompt(actionDirectory, promptBytes) {
  return immutableBytes(
    join(sessionCaptureDirectory(actionDirectory), PROMPT_FILE),
    Buffer.from(promptBytes),
    "composed prompt bytes",
    SESSION_PROMPT_MAX_BYTES,
  );
}

export function captureNativeSessionLog(actionDirectory, phase, leaseId, nativeLogBytes) {
  if (phase !== "work" && phase !== "result_correction") {
    throw new Error("native session log phase is invalid");
  }
  if (typeof leaseId !== "string" || !SAFE_ID.test(leaseId)) {
    throw new Error("native session log lease identity is invalid");
  }
  const file = phase === "work" ? WORK_LOG_FILE : `native-correction-${leaseId}.log`;
  return immutableBytes(
    join(sessionCaptureDirectory(actionDirectory), file),
    Buffer.from(nativeLogBytes),
    "native session log",
    SESSION_NATIVE_LOG_MAX_BYTES,
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function otelValue(value) {
  if (Buffer.isBuffer(value)) return { bytesValue: value.toString("base64") };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return { intValue: String(value) };
  }
  return { stringValue: String(value) };
}

function attribute(key, value) {
  return { key, value: otelValue(value) };
}

function unixNano(timestamp) {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw new Error("session evidence timestamp is invalid");
  return String(BigInt(milliseconds) * 1_000_000n);
}

function classifiedKind(candidates) {
  const kinds = candidates.filter((candidate) => typeof candidate === "string");
  const tool = kinds.find((kind) => /(?:tool|command|mcp|function)/i.test(kind));
  if (tool) return { category: "tool", name: tool };
  const turn = kinds.find((kind) => /(?:turn|step|message|assistant|result)/i.test(kind));
  return turn ? { category: "turn", name: turn } : null;
}

function eventKinds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const primary = classifiedKind([
    value.type,
    value.subtype,
    value.item?.type,
    value.content_block?.type,
    value.part?.type,
  ]);
  const blocks = [value.content, value.message?.content, value.item?.content]
    .flatMap((candidate) => Array.isArray(candidate) ? candidate : []);
  const nested = blocks.map((block) => classifiedKind([
    block?.type,
    block?.name,
  ])).filter((kind) => kind !== null && kind.category === "tool");
  return [...new Map([
    ...(primary === null ? [] : [primary]),
    ...nested,
  ].map((kind) => [`${kind.category}:${kind.name}`, kind])).values()];
}

function structuralSpans({ traceId, rootSpanId, logs, timeUnixNano, engine }) {
  const spans = [];
  let eventOrdinal = 0;
  for (const log of logs) {
    const lines = log.bytes.toString("utf8").split("\n");
    for (const [lineIndex, raw] of lines.entries()) {
      if (raw.length === 0) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      for (const kind of eventKinds(parsed)) {
        const spanId = sha256(Buffer.from(
          `${traceId}\0${log.phase}\0${lineIndex}\0${eventOrdinal}`,
          "utf8",
        )).slice(0, 16);
        spans.push({
          traceId,
          spanId,
          parentSpanId: rootSpanId,
          name: `${engine}.${kind.category}.${kind.name}`.slice(0, 256),
          kind: 1,
          startTimeUnixNano: timeUnixNano,
          endTimeUnixNano: timeUnixNano,
          attributes: [
            attribute("openthrottle.session.phase", log.phase),
            attribute("openthrottle.native_log.line", lineIndex + 1),
          ],
          events: [{
            name: "openthrottle.native_log.event",
            timeUnixNano,
            attributes: [attribute("event.name", String(parsed.type ?? kind.name))],
          }],
          status: { code: 1 },
        });
        eventOrdinal += 1;
      }
    }
  }
  return spans;
}

export function buildOtelSessionTranscript({ request, nativeSessionId, logs, capturedAt }) {
  if (!Array.isArray(logs) || logs.length < 1) {
    throw new Error("semantic session evidence requires at least one native log");
  }
  const traceId = sha256(Buffer.from([
    request.pipeline_run_id,
    request.attempt_id,
    request.request_hash,
  ].join("\0"), "utf8")).slice(0, 32);
  const rootSpanId = sha256(Buffer.from(`${traceId}\0root`, "utf8")).slice(0, 16);
  const timeUnixNano = unixNano(capturedAt);
  const root = {
    traceId,
    spanId: rootSpanId,
    name: `openthrottle.attempt.${request.stage_id}`.slice(0, 256),
    kind: 1,
    startTimeUnixNano: timeUnixNano,
    endTimeUnixNano: timeUnixNano,
    attributes: [
      attribute("openthrottle.pipeline_run.id", request.pipeline_run_id),
      attribute("openthrottle.attempt.id", request.attempt_id),
      attribute("openthrottle.stage.id", request.stage_id),
      attribute("openthrottle.request.hash", request.request_hash),
      attribute("openthrottle.definition_bundle.hash", request.definition_bundle_hash),
      attribute("openthrottle.native_session.id", nativeSessionId),
      attribute("gen_ai.system", request.action?.engine ?? request.engine),
    ],
    events: logs.map((log) => ({
      name: "openthrottle.native_log.raw",
      timeUnixNano,
      attributes: [
        attribute("openthrottle.session.phase", log.phase),
        attribute("openthrottle.native_log.bytes", log.bytes.byteLength),
        attribute("openthrottle.native_log.content", log.bytes),
      ],
    })),
    status: { code: 1 },
  };
  return {
    resourceSpans: [{
      resource: { attributes: [
        attribute("service.name", "openthrottle-sandbox"),
        attribute("service.namespace", "openthrottle"),
      ] },
      scopeSpans: [{
        scope: { name: "openthrottle.session-transcript", version: "1" },
        spans: [
          root,
          ...structuralSpans({
            traceId,
            rootSpanId,
            logs,
            timeUnixNano,
            engine: request.action?.engine ?? request.engine,
          }),
        ],
      }],
    }],
  };
}

function artifactDescriptor(bytes, options) {
  const digest = sha256(bytes);
  return {
    schema: SESSION_ARTIFACT_DESCRIPTOR_SCHEMA,
    file: `${options.prefix}-${digest}.${options.extension}`,
    sha256: digest,
    bytes: bytes.byteLength,
    encoding: "utf-8",
    media_type: options.mediaType,
    payload_schema: options.payloadSchema,
  };
}

function stageArtifact(bytes, artifactDirectory, options) {
  const descriptor = artifactDescriptor(bytes, options);
  immutableBytes(
    join(artifactDirectory, descriptor.file),
    bytes,
    `${options.prefix} artifact`,
    SESSION_ARTIFACT_MAX_BYTES,
  );
  return descriptor;
}

function stageForTransport(descriptor, artifactDirectory, resultPath) {
  const source = join(resolve(artifactDirectory), descriptor.file);
  const target = join(resolve(dirname(resultPath)), descriptor.file);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (source !== target && !existsSync(target)) {
    copyFileSync(source, target, constants.COPYFILE_EXCL);
  }
  if (statSync(target).size !== descriptor.bytes) {
    throw new Error("transport session artifact size mismatch");
  }
}

function capturedLogs(actionDirectory) {
  const directory = sessionCaptureDirectory(actionDirectory);
  const files = readdirSync(directory).filter((file) =>
    file === WORK_LOG_FILE || /^native-correction-[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\.log$/.test(file));
  if (!files.includes(WORK_LOG_FILE)) {
    throw new Error("semantic result is missing its launched work session log");
  }
  return files.sort((left, right) => {
    if (left === WORK_LOG_FILE) return -1;
    if (right === WORK_LOG_FILE) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  }).map((file) => ({
    phase: file === WORK_LOG_FILE ? "work" : "result_correction",
    bytes: readFileSync(join(directory, file)),
  }));
}

export function stageSessionEvidence({
  request,
  nativeSessionId,
  actionDirectory,
  artifactDirectory,
  resultPath,
  capturedAt,
}) {
  const promptBytes = readFileSync(join(sessionCaptureDirectory(actionDirectory), PROMPT_FILE));
  const transcriptBytes = Buffer.from(`${canonicalJson(buildOtelSessionTranscript({
    request,
    nativeSessionId,
    logs: capturedLogs(actionDirectory),
    capturedAt,
  }))}\n`, "utf8");
  const transcript = stageArtifact(transcriptBytes, artifactDirectory, {
    prefix: "transcript",
    extension: "json",
    mediaType: "application/json",
    payloadSchema: OTEL_SESSION_TRANSCRIPT_PAYLOAD_SCHEMA,
  });
  const prompt_context = stageArtifact(promptBytes, artifactDirectory, {
    prefix: "prompt",
    extension: "txt",
    mediaType: "text/plain",
    payloadSchema: COMPOSED_PROMPT_PAYLOAD_SCHEMA,
  });
  stageForTransport(transcript, artifactDirectory, resultPath);
  stageForTransport(prompt_context, artifactDirectory, resultPath);
  return { transcript, prompt_context };
}
