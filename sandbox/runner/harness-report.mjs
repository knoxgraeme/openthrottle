export const HARNESS_REPORT_COMPONENTS = new Set([
  "supervisor",
  "sandbox_runner",
  "structured_loop",
  "repository_control",
  "publication",
  "provider_integration",
]);

export const HARNESS_REPORT_BOUNDARIES = new Set([
  "admission",
  "stage_dispatch",
  "child_action_dispatch",
  "result_collection",
  "receipt_validation",
  "gate_evaluation",
  "worktree",
  "lifecycle",
  "publication",
]);

export const HARNESS_REPORT_FAILURE_CLASSES = new Set([
  "unexpected_exception",
  "invalid_receipt",
  "missing_receipt",
  "state_transition_mismatch",
  "evidence_binding_mismatch",
  "lease_or_retry_failure",
  "timeout_or_stall",
  "provider_contract_mismatch",
  "worktree_or_git_failure",
  "publication_failure",
  "other_harness_failure",
]);

export const HARNESS_REPORT_SIGNALS = new Set([
  "unexpected_error",
  "missing_output",
  "malformed_output",
  "stale_output",
  "conflicting_evidence",
  "incorrect_state",
  "repeated_retry",
  "timeout",
  "provider_rejection",
  "unsafe_output_blocked",
  "publication_not_confirmed",
]);
const HARNESS_REPORT_SIGNAL_ORDER = new Map(
  [...HARNESS_REPORT_SIGNALS].map((signal, index) => [signal, index])
);

export const HARNESS_REPORT_CAUSES = new Set([
  "contract_validation",
  "state_machine",
  "lease_or_idempotency",
  "context_binding",
  "provider_boundary",
  "sandbox_runtime",
  "repository_control",
  "unknown",
]);

export const HARNESS_REPORT_INVESTIGATIONS = new Set([
  "inspect_receipt_validation",
  "inspect_state_transition",
  "inspect_lease_history",
  "inspect_context_binding",
  "inspect_provider_response",
  "inspect_runtime_events",
  "inspect_repository_control",
  "inspect_publication_receipt",
]);

export const HARNESS_REPORT_REPEATABILITY = new Set(["once", "intermittent", "repeatable", "unknown"]);
export const HARNESS_REPORT_CONFIDENCE = new Set(["low", "medium", "high"]);

function exactObject(value, label, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(`${label}.${key} is an unknown field`);
  }
  return value;
}

function member(value, label, vocabulary) {
  if (!vocabulary.has(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function harnessAgentReport(value, label) {
  const report = exactObject(value, label, new Set([
    "component",
    "boundary",
    "failure_class",
    "observed_signals",
    "suspected_cause",
    "suggested_investigation",
    "repeatability",
    "confidence",
  ]));
  if (!Array.isArray(report.observed_signals) ||
      report.observed_signals.length < 1 || report.observed_signals.length > 8) {
    throw new Error(`${label}.observed_signals must contain between 1 and 8 items`);
  }
  const observedSignals = report.observed_signals.map((signal, index) =>
    member(signal, `${label}.observed_signals[${index}]`, HARNESS_REPORT_SIGNALS));
  if (new Set(observedSignals).size !== observedSignals.length) {
    throw new Error(`${label}.observed_signals must contain unique values`);
  }
  observedSignals.sort((left, right) =>
    HARNESS_REPORT_SIGNAL_ORDER.get(left) - HARNESS_REPORT_SIGNAL_ORDER.get(right));
  return {
    component: member(report.component, `${label}.component`, HARNESS_REPORT_COMPONENTS),
    boundary: member(report.boundary, `${label}.boundary`, HARNESS_REPORT_BOUNDARIES),
    failure_class: member(
      report.failure_class,
      `${label}.failure_class`,
      HARNESS_REPORT_FAILURE_CLASSES
    ),
    observed_signals: observedSignals,
    ...(report.suspected_cause === undefined ? {} : {
      suspected_cause: member(report.suspected_cause, `${label}.suspected_cause`, HARNESS_REPORT_CAUSES),
    }),
    ...(report.suggested_investigation === undefined ? {} : {
      suggested_investigation: member(
        report.suggested_investigation,
        `${label}.suggested_investigation`,
        HARNESS_REPORT_INVESTIGATIONS
      ),
    }),
    repeatability: member(report.repeatability, `${label}.repeatability`, HARNESS_REPORT_REPEATABILITY),
    confidence: member(report.confidence, `${label}.confidence`, HARNESS_REPORT_CONFIDENCE),
  };
}
