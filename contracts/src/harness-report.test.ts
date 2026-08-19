import { describe, expect, it } from "vitest";
import {
  HARNESS_INCIDENT_SCHEMA,
  HARNESS_REPORT_ENVELOPE_SCHEMA,
  HARNESS_REPORT_PRIVACY_PROFILE,
  HARNESS_REPORT_RECEIPT_SCHEMA,
  parseHarnessAgentReport,
  validateHarnessReportEnvelope,
  validateHarnessReportReceipt,
} from "./harness-report.js";

const reportId = "019c9fb0-778c-7d21-a01a-69c46ea112c8";

function agentReport() {
  return {
    component: "sandbox_runner",
    boundary: "receipt_validation",
    failure_class: "invalid_receipt",
    observed_signals: ["repeated_retry", "provider_rejection"],
    suspected_cause: "contract_validation",
    suggested_investigation: "inspect_receipt_validation",
    repeatability: "repeatable",
    confidence: "medium",
  };
}

function envelope(mode: "on" | "deterministic" = "on") {
  return {
    schema: HARNESS_REPORT_ENVELOPE_SCHEMA,
    report_id: reportId,
    mode,
    privacy_profile: HARNESS_REPORT_PRIVACY_PROFILE,
    receipt: {
      schema: HARNESS_INCIDENT_SCHEMA,
      runtime: {
        runtime_release: "openthrottle-snapshot/v13",
        protocol: "stage-executor/1",
        capability: "accept-unit/1",
      },
      incident: {
        component: "structured_loop",
        boundary: "gate_evaluation",
        operation: "lead",
        outcome: "needs_human",
        reason_code: "lead_needs_human",
        retry_count: 1,
      },
    },
    agent_report_status: mode === "on" ? "included" : "not_requested",
    ...(mode === "on" ? { agent_report: agentReport() } : {}),
  };
}

describe("harness report contracts", () => {
  it("validates on and deterministic envelopes with exact mode semantics", () => {
    expect(validateHarnessReportEnvelope(envelope()).value.agent_report).toEqual(agentReport());
    expect(validateHarnessReportEnvelope(envelope("deterministic")).value.agent_report).toBeUndefined();
    expect(validateHarnessReportEnvelope({
      ...envelope(),
      agent_report_status: "not_provided",
      agent_report: undefined,
    }).value.agent_report_status).toBe("not_provided");
  });

  it("rejects agent diagnosis in deterministic mode and unknown report fields", () => {
    expect(() => validateHarnessReportEnvelope({
      ...envelope("deterministic"),
      agent_report_status: "included",
      agent_report: agentReport(),
    })).toThrow(/must be absent/);
    expect(() => parseHarnessAgentReport({ ...agentReport(), repository: "private/repo" }))
      .toThrow(/repository: unknown field/);
  });

  it("requires closed, bounded agent context", () => {
    expect(() => parseHarnessAgentReport({ ...agentReport(), observed_signals: [] }))
      .toThrow(/must contain between 1 and 8 entries/);
    expect(() => parseHarnessAgentReport({ ...agentReport(), failure_class: "repo_specific_failure" }))
      .toThrow(/must be one of/);
    expect(() => parseHarnessAgentReport({ ...agentReport(), confidence: "certain" }))
      .toThrow(/must be one of/);
  });

  it("rejects duplicate signals and normalizes accepted signals to contract order", () => {
    expect(() => parseHarnessAgentReport({
      ...agentReport(),
      observed_signals: ["timeout", "timeout"],
    })).toThrow(/must contain unique values/);
    expect(parseHarnessAgentReport({
      ...agentReport(),
      observed_signals: ["provider_rejection", "unexpected_error", "timeout"],
    }).observed_signals).toEqual(["unexpected_error", "timeout", "provider_rejection"]);
  });

  it("validates backend queue receipts", () => {
    expect(validateHarnessReportReceipt({
      schema: HARNESS_REPORT_RECEIPT_SCHEMA,
      report_id: reportId,
      status: "queued",
    }).value).toEqual({
      schema: HARNESS_REPORT_RECEIPT_SCHEMA,
      report_id: reportId,
      status: "queued",
    });
  });
});
