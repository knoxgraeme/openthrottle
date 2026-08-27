import { describe, expect, it } from "vitest";
import {
  PENDING_RESULT_DIAGNOSTICS_SCHEMA,
  parsePendingResultDiagnostics,
  serializePendingResultDiagnostics,
} from "./kernel-store-codecs.js";

const diagnostics = [{ path: "/payload/summary", detail: "must be a string" }];
const evidence = {
  algorithm: "sha256" as const,
  digest: "e".repeat(64),
  bytes: 128,
  encoding: "utf-8" as const,
  media_type: "application/json",
  payload_schema: "openthrottle.invalid-result-evidence/v1",
};

describe("pending result diagnostics codec", () => {
  it("reads the legacy bare array and writes the epoch-safe evidence envelope", () => {
    expect(parsePendingResultDiagnostics(diagnostics)).toEqual({
      diagnostics,
      invalid_result_evidence: null,
    });
    const encoded = serializePendingResultDiagnostics({
      candidate_hash: "d".repeat(64),
      diagnostics,
      invalid_result_evidence: evidence,
    });
    expect(JSON.parse(encoded)).toEqual({
      schema: PENDING_RESULT_DIAGNOSTICS_SCHEMA,
      diagnostics,
      invalid_result_evidence: evidence,
    });
    expect(parsePendingResultDiagnostics(JSON.parse(encoded))).toEqual({
      diagnostics,
      invalid_result_evidence: evidence,
    });
  });
});
