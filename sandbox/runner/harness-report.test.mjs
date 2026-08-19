import { describe, expect, it } from "vitest";
import { harnessAgentReport } from "./harness-report.mjs";

function report(observedSignals) {
  return {
    component: "sandbox_runner",
    boundary: "receipt_validation",
    failure_class: "invalid_receipt",
    observed_signals: observedSignals,
    repeatability: "repeatable",
    confidence: "medium",
  };
}

describe("harnessAgentReport", () => {
  it("normalizes unique signals into contract order", () => {
    expect(harnessAgentReport(
      report(["provider_rejection", "unexpected_error", "timeout"]),
      "harness_report"
    ).observed_signals).toEqual(["unexpected_error", "timeout", "provider_rejection"]);
  });

  it("rejects duplicate signals", () => {
    expect(() => harnessAgentReport(
      report(["timeout", "timeout"]),
      "harness_report"
    )).toThrow(/must contain unique values/);
  });
});
