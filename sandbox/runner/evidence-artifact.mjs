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
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalJson } from "./generated-result-contracts.mjs";

export const EVIDENCE_ARTIFACT_DESCRIPTOR_SCHEMA =
  "openthrottle.evidence-artifact-descriptor/v1";
export const ATTEMPT_FORENSICS_SCHEMA = "openthrottle.attempt-forensics/v1";
export const INVALID_RESULT_EVIDENCE_SCHEMA =
  "openthrottle.invalid-result-evidence/v1";

const MAX_EVIDENCE_BYTES = 1024 * 1024;

function syncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function immutableBytes(path, bytes, label, mode = 0o400) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    syncDirectory(dirname(path));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!readFileSync(path).equals(bytes)) throw new Error(`${label} conflicts with immutable evidence`);
  }
}

export function stageJsonEvidenceArtifact({ value, directory, descriptorPath = null }) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_EVIDENCE_BYTES) {
    throw new Error("evidence artifact exceeds its byte bound");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = `evidence-${sha256}.json`;
  const root = resolve(directory);
  const artifactPath = join(root, file);
  immutableBytes(artifactPath, bytes, "evidence artifact");
  const descriptor = {
    schema: EVIDENCE_ARTIFACT_DESCRIPTOR_SCHEMA,
    file,
    sha256,
    bytes: bytes.byteLength,
    media_type: "application/json",
    payload_schema: value.schema,
  };
  if (descriptorPath !== null) {
    const exactDescriptorPath = resolve(descriptorPath);
    if (dirname(exactDescriptorPath) !== root || basename(exactDescriptorPath) !== "forensics.json") {
      throw new Error("forensics descriptor must use its dedicated result path");
    }
    immutableBytes(
      exactDescriptorPath,
      Buffer.from(`${canonicalJson(descriptor)}\n`, "utf8"),
      "forensics descriptor",
    );
  }
  return descriptor;
}

export function stageEvidenceArtifactForTransport(descriptor, sourceDirectory, resultPath) {
  const targetDirectory = dirname(resultPath);
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  const source = join(sourceDirectory, descriptor.file);
  const target = join(targetDirectory, descriptor.file);
  if (resolve(source) !== resolve(target)) {
    if (!existsSync(target)) copyFileSync(source, target, constants.COPYFILE_EXCL);
    if (statSync(target).size !== descriptor.bytes) {
      throw new Error("transport evidence artifact size mismatch");
    }
  }
}
