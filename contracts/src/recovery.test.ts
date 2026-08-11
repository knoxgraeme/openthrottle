import { describe, expect, it } from "vitest";
import { canonicalJson, digestNormalized } from "./canonical.js";
import {
  EXECUTION_WORK_PRIVATE_ARTIFACT_SCHEMA,
  LOOP_RECEIPT_RECOVERY_SCHEMA,
  MAX_RECOVERY_CHANGED_PATHS_CANONICAL_BYTES,
  parseLoopReceiptRecoveryContract,
} from "./recovery.js";

const base = {
  schema: LOOP_RECEIPT_RECOVERY_SCHEMA,
  action_id: "action-1",
  attempt_id: "attempt-1",
  request_hash: "a".repeat(64),
  subject: "b".repeat(40),
};

describe("loop receipt recovery contract", () => {
  it("validates inline recovery bytes, paths, and digests", () => {
    const diff = Buffer.from("small patch");
    const value = {
      ...base,
      base_commit: "c".repeat(40),
      candidate_commit: "d".repeat(40),
      candidate_tree: "e".repeat(40),
      changed_paths: ["src/example.ts"],
      changed_paths_count: 1,
      changed_paths_sha256: digestNormalized(canonicalJson(["src/example.ts"])),
      changed_paths_truncated: false,
      diff_encoding: "git-diff",
      diff_base64: diff.toString("base64"),
      diff_bytes: diff.byteLength,
      diff_sha256: digestNormalized(diff),
      diff_truncated: false,
    };

    expect(parseLoopReceiptRecoveryContract(value).value).toEqual(value);
    expect(() => parseLoopReceiptRecoveryContract({ ...value, diff_bytes: diff.byteLength + 1 }))
      .toThrow(/byte or digest fence/);
  });

  it("accepts a reversible Git-quoted path longer than 4,096 characters", () => {
    const component = "\\377".repeat(240);
    const quotedPath = `"${Array.from({ length: 5 }, () => component).join("/")}"`;
    const paths = [quotedPath];
    const diff = Buffer.from("small patch");
    const value = {
      ...base,
      base_commit: "c".repeat(40),
      candidate_commit: "d".repeat(40),
      candidate_tree: "e".repeat(40),
      changed_paths: paths,
      changed_paths_count: 1,
      changed_paths_sha256: digestNormalized(canonicalJson(paths)),
      changed_paths_truncated: false,
      diff_encoding: "git-diff",
      diff_base64: diff.toString("base64"),
      diff_bytes: diff.byteLength,
      diff_sha256: digestNormalized(diff),
      diff_truncated: false,
    };

    expect(quotedPath.length).toBeGreaterThan(4_096);
    expect(Buffer.byteLength(canonicalJson(paths), "utf8"))
      .toBeLessThanOrEqual(MAX_RECOVERY_CHANGED_PATHS_CANONICAL_BYTES);
    expect(parseLoopReceiptRecoveryContract(value).value).toEqual(value);

    const oversizedPath = `"${Array.from({ length: 14 }, () => component).join("/")}"`;
    const oversizedPaths = [oversizedPath];
    expect(Buffer.byteLength(canonicalJson(oversizedPaths), "utf8"))
      .toBeGreaterThan(MAX_RECOVERY_CHANGED_PATHS_CANONICAL_BYTES);
    expect(() => parseLoopReceiptRecoveryContract({
      ...value,
      changed_paths: oversizedPaths,
      changed_paths_sha256: digestNormalized(canonicalJson(oversizedPaths)),
    })).toThrow(/exceeds 16 KiB/);
  });

  it("accepts one external payload phase and rejects mixed storage pointers", () => {
    const paths: string[] = [];
    const common = {
      ...base,
      base_commit: "c".repeat(40),
      candidate_commit: null,
      candidate_tree: "e".repeat(40),
      changed_paths: paths,
      changed_paths_count: 0,
      changed_paths_sha256: digestNormalized(canonicalJson(paths)),
      changed_paths_truncated: false,
      diff_encoding: "gzip+git-diff",
      diff_base64: null,
      diff_bytes: 50_000,
      diff_sha256: "f".repeat(64),
      diff_truncated: false,
    };
    const sandbox = {
      ...common,
      diff_payload: { file: "recovery.patch.gz", bytes: 1_000, sha256: "1".repeat(64) },
    };
    const persisted = {
      ...common,
      private_payload: {
        schema: EXECUTION_WORK_PRIVATE_ARTIFACT_SCHEMA,
        encoding: "gzip+git-diff",
        bytes: 1_000,
        sha256: "1".repeat(64),
      },
      source_manifest_sha256: "2".repeat(64),
    };

    expect(parseLoopReceiptRecoveryContract(sandbox).value).toEqual(sandbox);
    expect(parseLoopReceiptRecoveryContract(persisted).value).toEqual(persisted);
    expect(() => parseLoopReceiptRecoveryContract({ ...sandbox, ...persisted }))
      .toThrow(/cannot name both/);
  });

  it("requires explicit workspace preservation when no portable payload exists", () => {
    const preserved = {
      ...base,
      recovery_subject: "b".repeat(40),
      requires_workspace_preservation: true,
      error: "recovery diff exceeds the platform bound",
    };
    expect(parseLoopReceiptRecoveryContract(preserved).value).toEqual(preserved);
    expect(() => parseLoopReceiptRecoveryContract({ ...base, error: "lost" }))
      .toThrow();
  });
});
