import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveStageFaultAttribution, FAULT_ATTRIBUTIONS, LAUNCH_FAULT_REASONS } from "./fault-attribution.js";
import { STAGE_OUTCOMES, type StageOutcome } from "./manifest.js";

describe("deriveStageFaultAttribution", () => {
  it("attributes nothing to a non-fault outcome, even with a launch reason present", () => {
    for (const outcome of ["success", "no_change", "canceled", "superseded"] as const) {
      expect(deriveStageFaultAttribution(outcome)).toBeNull();
      expect(deriveStageFaultAttribution(outcome, "engine_crash")).toBeNull();
    }
  });

  it("attributes provider-caused launch failures to provider regardless of outcome", () => {
    for (const reason of ["credential_missing", "credential_rejected", "rate_limited", "engine_crash"] as const) {
      expect(deriveStageFaultAttribution("retryable_infrastructure_failure", reason)).toBe("provider");
      expect(deriveStageFaultAttribution("failure", reason)).toBe("provider");
    }
  });

  it("attributes an unregistered_command launch failure to executor", () => {
    expect(deriveStageFaultAttribution("retryable_infrastructure_failure", "unregistered_command")).toBe("executor");
    expect(deriveStageFaultAttribution("failure", "unregistered_command")).toBe("executor");
  });

  it("attributes retryable infrastructure failures to executor without a launch reason", () => {
    expect(deriveStageFaultAttribution("retryable_infrastructure_failure")).toBe("executor");
    expect(deriveStageFaultAttribution("retryable_infrastructure_failure", null)).toBe("executor");
  });

  it("attributes semantic failure outcomes to agent", () => {
    expect(deriveStageFaultAttribution("failure")).toBe("agent");
    expect(deriveStageFaultAttribution("semantic_repair_required")).toBe("agent");
  });

  it("attributes needs_human to unknown rather than guessing", () => {
    expect(deriveStageFaultAttribution("needs_human")).toBe("unknown");
  });

  it("never returns a value outside the closed vocabulary for any outcome/reason combination", () => {
    const outcomes: StageOutcome[] = [...STAGE_OUTCOMES];
    const reasons = [undefined, null, ...LAUNCH_FAULT_REASONS] as const;
    for (const outcome of outcomes) {
      for (const reason of reasons) {
        const result = deriveStageFaultAttribution(outcome, reason);
        expect(result === null || FAULT_ATTRIBUTIONS.includes(result)).toBe(true);
      }
    }
  });

  it("keeps LAUNCH_FAULT_REASONS aligned with the sandbox's LAUNCH_FAILURE_REASONS", () => {
    // fault-attribution.ts cannot import launch-failure.mjs (supervisor and
    // sandbox are separate deployables), so LAUNCH_FAULT_REASONS is a
    // hand-mirrored copy, same as execute-loop.test.mjs's cross-check of
    // LOGICAL_CREDENTIAL_SCOPES against contracts' LOGICAL_CREDENTIALS.
    // Cross-check the two source texts so a future change to one is caught
    // if the other isn't updated to match.
    const sandboxSource = readFileSync(
      new URL("../../../sandbox/runner/launch-failure.mjs", import.meta.url),
      "utf8"
    );
    const sandboxMatch = sandboxSource.match(/export const LAUNCH_FAILURE_REASONS = Object\.freeze\(\[([^\]]+)\]\);/);
    expect(sandboxMatch).not.toBeNull();
    const sandboxReasons = JSON.parse(`[${sandboxMatch![1].replace(/,\s*$/, "")}]`).sort();

    expect([...LAUNCH_FAULT_REASONS].sort()).toEqual(sandboxReasons);
  });
});
