import type { StageOutcome } from "./manifest.js";

// Mirrors LAUNCH_FAILURE_REASONS in sandbox/runner/launch-failure.mjs. The
// sandbox-to-supervisor stage_result event carries at most one of these on
// its optional fault_reason field (see runtime/events.ts parseSandboxEvent);
// a new launch-failure reason requires a code change there and here together.
export const LAUNCH_FAULT_REASONS = Object.freeze([
  "credential_missing",
  "credential_rejected",
  "rate_limited",
  "unregistered_command",
  "engine_crash",
] as const);
export type LaunchFaultReason = (typeof LAUNCH_FAULT_REASONS)[number];

const PROVIDER_LAUNCH_FAULT_REASONS = new Set<LaunchFaultReason>([
  "credential_missing",
  "credential_rejected",
  "rate_limited",
  "engine_crash",
]);

const NON_FAULT_OUTCOMES = new Set<StageOutcome>([
  "success",
  "no_change",
  "canceled",
  "superseded",
]);

// The closed vocabulary for runs.fault_attribution in the epoch-1 baseline. Grown
// bottom-up per incident, mirroring the GATE_RECEIPT_REASONS/
// LAUNCH_FAILURE_REASONS pattern: every value here must already be produced
// by deriveStageFaultAttribution below or a call site that stamps it directly.
export const FAULT_ATTRIBUTIONS = Object.freeze([
  "executor",
  "agent",
  "provider",
  "unknown",
] as const);
export type FaultAttribution = (typeof FAULT_ATTRIBUTIONS)[number];

// Classifies a settled stage's fault domain from the existing classification
// surfaces (the gate-evaluated outcome and, when available, the sandbox's
// structured launch-failure reason) instead of inferring it from prose.
// `null` means the terminal outcome was not a fault (success/no_change/
// canceled/superseded) -- there is nothing to attribute. `"unknown"` is a
// first-class result: it is returned whenever the available evidence does
// not determine a domain, and it is never guessed.
//
// launchFaultReason is only trusted when the outcome is
// retryable_infrastructure_failure. classifyLaunchFailure (launch-failure.mjs)
// falls back to "engine_crash" whenever no other pattern matches, including
// for a clean, non-terminated process that simply never produced a proposal
// -- an agent protocol failure, not a provider fault. That fallback is only
// distinguishable from a genuine crash by the outcome it produced: a real
// crash (timeout/signal/exit 137) always resolves to
// retryable_infrastructure_failure, while the ambiguous clean-exit case
// resolves to failure. The other four reasons never co-occur with a
// non-retryable outcome (classifyLaunchFailure marks all of them retryable),
// so scoping the lookup this way changes nothing for them.
export function deriveStageFaultAttribution(
  outcome: StageOutcome,
  launchFaultReason?: LaunchFaultReason | null
): FaultAttribution | null {
  if (NON_FAULT_OUTCOMES.has(outcome)) return null;
  if (outcome === "retryable_infrastructure_failure") {
    if (launchFaultReason === "unregistered_command") return "executor";
    if (launchFaultReason && PROVIDER_LAUNCH_FAULT_REASONS.has(launchFaultReason)) return "provider";
    return "executor";
  }
  if (outcome === "semantic_repair_required" || outcome === "failure") return "agent";
  return "unknown";
}
