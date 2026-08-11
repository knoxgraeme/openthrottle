import { canonicalJson, digestNormalized } from "./canonical.js";
import {
  GIT_SUBJECT,
  SHA256,
  arrayAt,
  booleanAt,
  integerAt,
  normalizedContract,
  nullable,
  objectAt,
  stringAt,
  unique,
  type ValidatedContract,
} from "./validation.js";

export const LOOP_RECEIPT_RECOVERY_SCHEMA = "openthrottle.loop-receipt-recovery/v1" as const;
export const EXECUTION_WORK_PRIVATE_ARTIFACT_SCHEMA = "openthrottle.execution-work-private-artifact/v1" as const;
export const MAX_INLINE_RECOVERY_DIFF_BYTES = 48 * 1024;
export const MAX_PRIVATE_RECOVERY_DIFF_BYTES = 8 * 1024 * 1024;
export const MAX_RECOVERY_CHANGED_PATHS = 256;

interface LoopReceiptRecoveryBase {
  schema: typeof LOOP_RECEIPT_RECOVERY_SCHEMA;
  action_id: string;
  attempt_id: string;
  request_hash: string;
  subject: string | null;
}

export interface LoopReceiptRecoveryPreserved extends LoopReceiptRecoveryBase {
  recovery_subject: string | null;
  requires_workspace_preservation: true;
  error: string;
}

export interface LoopReceiptRecoveryPayloadDescriptor {
  file: "recovery.patch.gz";
  bytes: number;
  sha256: string;
}

export interface ExecutionWorkPrivatePayloadDescriptor {
  schema: typeof EXECUTION_WORK_PRIVATE_ARTIFACT_SCHEMA;
  encoding: "gzip+git-diff";
  bytes: number;
  sha256: string;
}

export interface LoopReceiptRecoveryPortable extends LoopReceiptRecoveryBase {
  base_commit: string;
  candidate_commit: string | null;
  candidate_tree: string;
  changed_paths: string[];
  changed_paths_count: number;
  changed_paths_sha256: string;
  changed_paths_truncated: boolean;
  diff_encoding: "git-diff" | "gzip+git-diff";
  diff_base64: string | null;
  diff_bytes: number;
  diff_sha256: string;
  diff_truncated: false;
  diff_payload?: LoopReceiptRecoveryPayloadDescriptor;
  private_payload?: ExecutionWorkPrivatePayloadDescriptor;
  source_manifest_sha256?: string;
}

export type LoopReceiptRecoveryContract = LoopReceiptRecoveryPreserved | LoopReceiptRecoveryPortable;

const BASE_FIELDS = ["schema", "action_id", "attempt_id", "request_hash", "subject"] as const;
const PRESERVED_FIELDS = [...BASE_FIELDS, "recovery_subject", "requires_workspace_preservation", "error"] as const;
const PORTABLE_FIELDS = [
  ...BASE_FIELDS,
  "base_commit", "candidate_commit", "candidate_tree",
  "changed_paths", "changed_paths_count", "changed_paths_sha256", "changed_paths_truncated",
  "diff_encoding", "diff_base64", "diff_bytes", "diff_sha256", "diff_truncated",
  "diff_payload", "private_payload", "source_manifest_sha256",
] as const;

function sha256(value: unknown, path: string): string {
  return stringAt(value, path, { pattern: SHA256 });
}

function gitSubject(value: unknown, path: string): string {
  return stringAt(value, path, { pattern: GIT_SUBJECT });
}

function parseBase(input: Record<string, unknown>, path: string): LoopReceiptRecoveryBase {
  if (input.schema !== LOOP_RECEIPT_RECOVERY_SCHEMA) throw new Error(`${path}.schema: has an invalid value`);
  return {
    schema: LOOP_RECEIPT_RECOVERY_SCHEMA,
    action_id: stringAt(input.action_id, `${path}.action_id`, { max: 160 }),
    attempt_id: stringAt(input.attempt_id, `${path}.attempt_id`, { max: 160 }),
    request_hash: sha256(input.request_hash, `${path}.request_hash`),
    subject: nullable(input.subject, (entry) => gitSubject(entry, `${path}.subject`)),
  };
}

function parsePayloadDescriptor(value: unknown, path: string): LoopReceiptRecoveryPayloadDescriptor {
  const input = objectAt(value, path, ["file", "bytes", "sha256"]);
  if (input.file !== "recovery.patch.gz") throw new Error(`${path}.file: has an invalid value`);
  return {
    file: "recovery.patch.gz",
    bytes: integerAt(input.bytes, `${path}.bytes`, 1, MAX_PRIVATE_RECOVERY_DIFF_BYTES),
    sha256: sha256(input.sha256, `${path}.sha256`),
  };
}

function parsePrivatePayload(value: unknown, path: string): ExecutionWorkPrivatePayloadDescriptor {
  const input = objectAt(value, path, ["schema", "encoding", "bytes", "sha256"]);
  if (input.schema !== EXECUTION_WORK_PRIVATE_ARTIFACT_SCHEMA || input.encoding !== "gzip+git-diff") {
    throw new Error(`${path}: has an invalid schema or encoding`);
  }
  return {
    schema: EXECUTION_WORK_PRIVATE_ARTIFACT_SCHEMA,
    encoding: "gzip+git-diff",
    bytes: integerAt(input.bytes, `${path}.bytes`, 1, MAX_PRIVATE_RECOVERY_DIFF_BYTES),
    sha256: sha256(input.sha256, `${path}.sha256`),
  };
}

export function parseLoopReceiptRecoveryContract(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<LoopReceiptRecoveryContract> {
  const path = options.source ?? "loop_receipt_recovery";
  const initial = objectAt(value, path, [...new Set([...PRESERVED_FIELDS, ...PORTABLE_FIELDS])]);
  if (initial.requires_workspace_preservation === true) {
    const input = objectAt(value, path, PRESERVED_FIELDS);
    return normalizedContract({
      ...parseBase(input, path),
      recovery_subject: nullable(input.recovery_subject, (entry) => gitSubject(entry, `${path}.recovery_subject`)),
      requires_workspace_preservation: true,
      error: stringAt(input.error, `${path}.error`, { max: 1_000 }),
    });
  }

  const input = objectAt(value, path, PORTABLE_FIELDS);
  const changedPaths = unique(arrayAt(
    input.changed_paths,
    `${path}.changed_paths`,
    (entry, entryPath) => stringAt(entry, entryPath, { max: 4_096 }),
    { max: MAX_RECOVERY_CHANGED_PATHS }
  ), `${path}.changed_paths`);
  if (Buffer.byteLength(canonicalJson(changedPaths), "utf8") > 16 * 1024) {
    throw new Error(`${path}.changed_paths: exceeds 16 KiB`);
  }
  const changedPathsCount = integerAt(input.changed_paths_count, `${path}.changed_paths_count`, changedPaths.length, 1_000_000);
  const changedPathsTruncated = booleanAt(input.changed_paths_truncated, `${path}.changed_paths_truncated`);
  const changedPathsHash = sha256(input.changed_paths_sha256, `${path}.changed_paths_sha256`);
  if (!changedPathsTruncated &&
      (changedPathsCount !== changedPaths.length || changedPathsHash !== digestNormalized(canonicalJson(changedPaths)))) {
    throw new Error(`${path}.changed_paths: does not match its count or digest`);
  }
  const diffBytes = integerAt(input.diff_bytes, `${path}.diff_bytes`, 0, MAX_PRIVATE_RECOVERY_DIFF_BYTES);
  const diffHash = sha256(input.diff_sha256, `${path}.diff_sha256`);
  if (input.diff_truncated !== false) throw new Error(`${path}.diff_truncated: must be false`);
  const diffEncoding = input.diff_encoding;
  let diffBase64: string | null;
  let diffPayload: LoopReceiptRecoveryPayloadDescriptor | undefined;
  let privatePayload: ExecutionWorkPrivatePayloadDescriptor | undefined;
  let sourceManifestSha256: string | undefined;
  if (diffEncoding === "git-diff") {
    if (typeof input.diff_base64 !== "string" ||
        input.diff_base64.length > Math.ceil(MAX_INLINE_RECOVERY_DIFF_BYTES / 3) * 4) {
      throw new Error(`${path}.diff_base64: must be bounded base64 text`);
    }
    diffBase64 = input.diff_base64;
    if (diffBytes > MAX_INLINE_RECOVERY_DIFF_BYTES || input.diff_payload !== undefined ||
        input.private_payload !== undefined || input.source_manifest_sha256 !== undefined) {
      throw new Error(`${path}: has an invalid inline recovery payload`);
    }
    const decoded = Buffer.from(diffBase64, "base64");
    if (decoded.toString("base64") !== diffBase64 || decoded.byteLength !== diffBytes ||
        digestNormalized(decoded) !== diffHash) {
      throw new Error(`${path}.diff_base64: does not match its byte or digest fence`);
    }
  } else if (diffEncoding === "gzip+git-diff") {
    if (input.diff_base64 !== null || diffBytes <= MAX_INLINE_RECOVERY_DIFF_BYTES) {
      throw new Error(`${path}: has an invalid external recovery payload`);
    }
    diffBase64 = null;
    if (input.diff_payload !== undefined && input.private_payload !== undefined) {
      throw new Error(`${path}: cannot name both sandbox and persisted recovery payloads`);
    }
    if (input.diff_payload !== undefined) {
      diffPayload = parsePayloadDescriptor(input.diff_payload, `${path}.diff_payload`);
      if (input.source_manifest_sha256 !== undefined) throw new Error(`${path}.source_manifest_sha256: is not valid before persistence`);
    } else {
      privatePayload = parsePrivatePayload(input.private_payload, `${path}.private_payload`);
      sourceManifestSha256 = sha256(input.source_manifest_sha256, `${path}.source_manifest_sha256`);
    }
  } else {
    throw new Error(`${path}.diff_encoding: has an invalid value`);
  }
  return normalizedContract({
    ...parseBase(input, path),
    base_commit: gitSubject(input.base_commit, `${path}.base_commit`),
    candidate_commit: nullable(input.candidate_commit, (entry) => gitSubject(entry, `${path}.candidate_commit`)),
    candidate_tree: gitSubject(input.candidate_tree, `${path}.candidate_tree`),
    changed_paths: changedPaths,
    changed_paths_count: changedPathsCount,
    changed_paths_sha256: changedPathsHash,
    changed_paths_truncated: changedPathsTruncated,
    diff_encoding: diffEncoding,
    diff_base64: diffBase64,
    diff_bytes: diffBytes,
    diff_sha256: diffHash,
    diff_truncated: false,
    ...(diffPayload ? { diff_payload: diffPayload } : {}),
    ...(privatePayload ? { private_payload: privatePayload } : {}),
    ...(sourceManifestSha256 ? { source_manifest_sha256: sourceManifestSha256 } : {}),
  });
}

export function validateLoopReceiptRecoveryContract(value: unknown): LoopReceiptRecoveryContract {
  return parseLoopReceiptRecoveryContract(value).value;
}
