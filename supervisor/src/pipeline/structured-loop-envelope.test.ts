import { describe, expect, it } from "vitest";
import type { ExecutionPlanContract } from "@openthrottle/contracts";
import { canonicalJson } from "./manifest.js";
import {
  MAX_VALID_DOWNSTREAM_CONTEXT,
  structuredPlanLoopEnvelopeBytes,
} from "./structured-loop-envelope.js";
import {
  MAX_DOWNSTREAM_CONTEXT_BYTES,
  MAX_DOWNSTREAM_CONTEXT_RECORDS,
  MAX_DOWNSTREAM_CONTEXT_RECORD_PAYLOAD_BYTES,
  MAX_LOOP_REQUEST_ENVELOPE_BYTES,
} from "./structured-loop-limits.js";

function unitPlan(unitCount: number): ExecutionPlanContract {
  return {
    schema: "openthrottle.execution-plan/v1",
    graph_id: "structured",
    plan_id: "downstream-context-bound",
    instructions: { one: "Implement the unit." },
    acceptance: { done: "Unit is done." },
    units: Array.from({ length: unitCount }, (_, index) => ({
      id: `unit_${index}`,
      title: `Unit ${index}`,
      depends_on: [],
      instructions: ["one"],
      acceptance: ["done"],
    })),
    commands: [],
  };
}

describe("downstream-context admission bound", () => {
  it("reserves exactly the shared canonical aggregate maximum, not a representative sample", () => {
    const bytes = Buffer.byteLength(canonicalJson(MAX_VALID_DOWNSTREAM_CONTEXT), "utf8");
    expect(bytes).toBe(MAX_DOWNSTREAM_CONTEXT_BYTES);
    expect(MAX_VALID_DOWNSTREAM_CONTEXT.length).toBeLessThanOrEqual(MAX_DOWNSTREAM_CONTEXT_RECORDS);
  });

  it("keeps every reserved record's payload within the sandbox's per-record cap", () => {
    for (const record of MAX_VALID_DOWNSTREAM_CONTEXT) {
      const payloadBytes = Buffer.byteLength(canonicalJson(record.payload), "utf8");
      expect(payloadBytes).toBeLessThanOrEqual(MAX_DOWNSTREAM_CONTEXT_RECORD_PAYLOAD_BYTES);
    }
  });

  it("dispatches a plan whose sealed envelope carries the true maximum downstream-context aggregate", () => {
    const bytes = structuredPlanLoopEnvelopeBytes(unitPlan(1));
    expect(bytes).toBeLessThanOrEqual(MAX_LOOP_REQUEST_ENVELOPE_BYTES);
  });

  it("reserves more than the ticket's reproduced 31,041-byte representative sample", () => {
    // Regression guard for the exact reproduction in the ticket: the old probe
    // (32 records of a fixed 760-character summary) serialized to 31,041
    // bytes, under-reserving the true 32,768-byte canonical maximum and
    // letting a boundary-admitted plan become oversized only after
    // provisioning. Today's reservation must exceed that under-sized sample.
    const oldRepresentativeSampleBytes = (() => {
      const records = Array.from({ length: 32 }, (_, index) => {
        const payload = {
          schema: "openthrottle.downstream-context/v1",
          from_unit_id: `upstream-${index.toString(16).padStart(2, "0")}`,
          summary: "x".repeat(760),
        };
        return { fromUnitId: payload.from_unit_id, payloadHash: "0".repeat(64), payload };
      });
      return Buffer.byteLength(canonicalJson(records), "utf8");
    })();
    expect(oldRepresentativeSampleBytes).toBe(31_041);
    const trueMaxBytes = Buffer.byteLength(canonicalJson(MAX_VALID_DOWNSTREAM_CONTEXT), "utf8");
    expect(trueMaxBytes).toBeGreaterThan(oldRepresentativeSampleBytes);
    expect(trueMaxBytes).toBe(MAX_DOWNSTREAM_CONTEXT_BYTES);
  });
});
