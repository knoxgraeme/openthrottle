import {
  IDENTIFIER,
  arrayAt,
  enumAt,
  fail,
  integerAt,
  normalizedContract,
  objectAt,
  optional,
  stringAt,
  type ValidatedContract,
} from "./validation.js";

export const HARNESS_INCIDENT_SCHEMA = "openthrottle.harness-incident/v1" as const;
export const HARNESS_REPORT_ENVELOPE_SCHEMA = "openthrottle.harness-report-envelope/v1" as const;
export const HARNESS_REPORT_RECEIPT_SCHEMA = "openthrottle.harness-report-receipt/v1" as const;
export const HARNESS_REPORT_PRIVACY_PROFILE = "closed-vocabulary/v1" as const;

export const HARNESS_REPORTING_MODES = ["off", "on", "deterministic"] as const;
export type HarnessReportingMode = (typeof HARNESS_REPORTING_MODES)[number];

export const HARNESS_REPORT_COMPONENTS = [
  "supervisor",
  "sandbox_runner",
  "structured_loop",
  "repository_control",
  "publication",
  "provider_integration",
] as const;
export type HarnessReportComponent = (typeof HARNESS_REPORT_COMPONENTS)[number];

export const HARNESS_REPORT_BOUNDARIES = [
  "admission",
  "stage_dispatch",
  "child_action_dispatch",
  "result_collection",
  "receipt_validation",
  "gate_evaluation",
  "worktree",
  "lifecycle",
  "publication",
] as const;
export type HarnessReportBoundary = (typeof HARNESS_REPORT_BOUNDARIES)[number];

export const HARNESS_REPORT_CONFIDENCE = ["low", "medium", "high"] as const;
export const HARNESS_REPORT_FAILURE_CLASSES = [
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
] as const;
export const HARNESS_REPORT_SIGNALS = [
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
] as const;
const HARNESS_REPORT_SIGNAL_ORDER = new Map(
  HARNESS_REPORT_SIGNALS.map((signal, index) => [signal, index])
);
export const HARNESS_REPORT_CAUSES = [
  "contract_validation",
  "state_machine",
  "lease_or_idempotency",
  "context_binding",
  "provider_boundary",
  "sandbox_runtime",
  "repository_control",
  "unknown",
] as const;
export const HARNESS_REPORT_INVESTIGATIONS = [
  "inspect_receipt_validation",
  "inspect_state_transition",
  "inspect_lease_history",
  "inspect_context_binding",
  "inspect_provider_response",
  "inspect_runtime_events",
  "inspect_repository_control",
  "inspect_publication_receipt",
] as const;
export const HARNESS_REPORT_REPEATABILITY = ["once", "intermittent", "repeatable", "unknown"] as const;
export const HARNESS_REPORT_AGENT_STATUSES = [
  "not_requested",
  "included",
  "not_provided",
] as const;
export const HARNESS_REPORT_RECEIPT_STATUSES = ["queued"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REASON_CODE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export interface HarnessAgentReport {
  component: HarnessReportComponent;
  boundary: HarnessReportBoundary;
  failure_class: (typeof HARNESS_REPORT_FAILURE_CLASSES)[number];
  observed_signals: (typeof HARNESS_REPORT_SIGNALS)[number][];
  suspected_cause?: (typeof HARNESS_REPORT_CAUSES)[number];
  suggested_investigation?: (typeof HARNESS_REPORT_INVESTIGATIONS)[number];
  repeatability: (typeof HARNESS_REPORT_REPEATABILITY)[number];
  confidence: (typeof HARNESS_REPORT_CONFIDENCE)[number];
}

export interface HarnessIncidentReceipt {
  schema: typeof HARNESS_INCIDENT_SCHEMA;
  runtime: {
    runtime_release: string;
    protocol: string;
    capability: string;
  };
  incident: {
    component: "structured_loop";
    boundary: "gate_evaluation";
    operation: "lead";
    outcome: string;
    reason_code: string;
    retry_count: number;
  };
}

export interface HarnessReportEnvelope {
  schema: typeof HARNESS_REPORT_ENVELOPE_SCHEMA;
  report_id: string;
  mode: Exclude<HarnessReportingMode, "off">;
  privacy_profile: typeof HARNESS_REPORT_PRIVACY_PROFILE;
  receipt: HarnessIncidentReceipt;
  agent_report_status: (typeof HARNESS_REPORT_AGENT_STATUSES)[number];
  agent_report?: HarnessAgentReport;
}

export interface HarnessReportReceipt {
  schema: typeof HARNESS_REPORT_RECEIPT_SCHEMA;
  report_id: string;
  status: (typeof HARNESS_REPORT_RECEIPT_STATUSES)[number];
}

function parseReasonCode(value: unknown, path: string): string {
  return stringAt(value, path, { max: 120, pattern: REASON_CODE });
}

export function parseHarnessAgentReport(value: unknown, path = "harness_report"): HarnessAgentReport {
  const input = objectAt(value, path, [
    "component",
    "boundary",
    "failure_class",
    "observed_signals",
    "suspected_cause",
    "suggested_investigation",
    "repeatability",
    "confidence",
  ]);
  const observedSignals = arrayAt(input.observed_signals, `${path}.observed_signals`, (entry, entryPath) =>
    enumAt(entry, entryPath, HARNESS_REPORT_SIGNALS), { min: 1, max: 8 });
  if (new Set(observedSignals).size !== observedSignals.length) {
    fail(`${path}.observed_signals`, "must contain unique values");
  }
  observedSignals.sort((left, right) =>
    HARNESS_REPORT_SIGNAL_ORDER.get(left)! - HARNESS_REPORT_SIGNAL_ORDER.get(right)!);
  return {
    component: enumAt(input.component, `${path}.component`, HARNESS_REPORT_COMPONENTS),
    boundary: enumAt(input.boundary, `${path}.boundary`, HARNESS_REPORT_BOUNDARIES),
    failure_class: enumAt(input.failure_class, `${path}.failure_class`, HARNESS_REPORT_FAILURE_CLASSES),
    observed_signals: observedSignals,
    ...optional(input.suspected_cause, (entry) => ({
      suspected_cause: enumAt(entry, `${path}.suspected_cause`, HARNESS_REPORT_CAUSES),
    })),
    ...optional(input.suggested_investigation, (entry) => ({
      suggested_investigation: enumAt(
        entry,
        `${path}.suggested_investigation`,
        HARNESS_REPORT_INVESTIGATIONS
      ),
    })),
    repeatability: enumAt(input.repeatability, `${path}.repeatability`, HARNESS_REPORT_REPEATABILITY),
    confidence: enumAt(input.confidence, `${path}.confidence`, HARNESS_REPORT_CONFIDENCE),
  };
}

function parseIncidentReceipt(value: unknown, path: string): HarnessIncidentReceipt {
  const input = objectAt(value, path, ["schema", "runtime", "incident"]);
  if (input.schema !== HARNESS_INCIDENT_SCHEMA) fail(`${path}.schema`, `must be ${HARNESS_INCIDENT_SCHEMA}`);
  const runtime = objectAt(input.runtime, `${path}.runtime`, ["runtime_release", "protocol", "capability"]);
  const incident = objectAt(input.incident, `${path}.incident`, [
    "component", "boundary", "operation", "outcome", "reason_code", "retry_count",
  ]);
  return {
    schema: HARNESS_INCIDENT_SCHEMA,
    runtime: {
      runtime_release: stringAt(runtime.runtime_release, `${path}.runtime.runtime_release`, { max: 120 }),
      protocol: stringAt(runtime.protocol, `${path}.runtime.protocol`, { max: 120, pattern: IDENTIFIER }),
      capability: stringAt(runtime.capability, `${path}.runtime.capability`, { max: 160, pattern: IDENTIFIER }),
    },
    incident: {
      component: enumAt(incident.component, `${path}.incident.component`, ["structured_loop"] as const),
      boundary: enumAt(incident.boundary, `${path}.incident.boundary`, ["gate_evaluation"] as const),
      operation: enumAt(incident.operation, `${path}.incident.operation`, ["lead"] as const),
      outcome: stringAt(incident.outcome, `${path}.incident.outcome`, { max: 80, pattern: REASON_CODE }),
      reason_code: parseReasonCode(incident.reason_code, `${path}.incident.reason_code`),
      retry_count: integerAt(incident.retry_count, `${path}.incident.retry_count`, 0, 100),
    },
  };
}

export function validateHarnessReportEnvelope(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<HarnessReportEnvelope> {
  const source = options.source ?? "harness_report_envelope";
  const input = objectAt(value, source, [
    "schema",
    "report_id",
    "mode",
    "privacy_profile",
    "receipt",
    "agent_report_status",
    "agent_report",
  ]);
  if (input.schema !== HARNESS_REPORT_ENVELOPE_SCHEMA) {
    fail(`${source}.schema`, `must be ${HARNESS_REPORT_ENVELOPE_SCHEMA}`);
  }
  if (input.privacy_profile !== HARNESS_REPORT_PRIVACY_PROFILE) {
    fail(`${source}.privacy_profile`, `must be ${HARNESS_REPORT_PRIVACY_PROFILE}`);
  }
  const mode = enumAt(input.mode, `${source}.mode`, ["on", "deterministic"] as const);
  const agentReportStatus = enumAt(
    input.agent_report_status,
    `${source}.agent_report_status`,
    HARNESS_REPORT_AGENT_STATUSES
  );
  const agentReport = optional(input.agent_report, (entry) => parseHarnessAgentReport(entry, `${source}.agent_report`));
  if (mode === "deterministic" && (agentReportStatus !== "not_requested" || agentReport !== undefined)) {
    fail(`${source}.agent_report`, "must be absent with not_requested status in deterministic mode");
  }
  if (mode === "on" && (agentReportStatus === "included") !== (agentReport !== undefined)) {
    fail(`${source}.agent_report`, "must be present exactly when status is included");
  }
  if (mode === "on" && agentReportStatus === "not_requested") {
    fail(`${source}.agent_report_status`, "must not be not_requested in on mode");
  }
  return normalizedContract({
    schema: HARNESS_REPORT_ENVELOPE_SCHEMA,
    report_id: stringAt(input.report_id, `${source}.report_id`, { max: 36, pattern: UUID }),
    mode,
    privacy_profile: HARNESS_REPORT_PRIVACY_PROFILE,
    receipt: parseIncidentReceipt(input.receipt, `${source}.receipt`),
    agent_report_status: agentReportStatus,
    ...(agentReport ? { agent_report: agentReport } : {}),
  });
}

export function validateHarnessReportReceipt(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<HarnessReportReceipt> {
  const source = options.source ?? "harness_report_receipt";
  const input = objectAt(value, source, ["schema", "report_id", "status"]);
  if (input.schema !== HARNESS_REPORT_RECEIPT_SCHEMA) {
    fail(`${source}.schema`, `must be ${HARNESS_REPORT_RECEIPT_SCHEMA}`);
  }
  return normalizedContract({
    schema: HARNESS_REPORT_RECEIPT_SCHEMA,
    report_id: stringAt(input.report_id, `${source}.report_id`, { max: 36, pattern: UUID }),
    status: enumAt(input.status, `${source}.status`, HARNESS_REPORT_RECEIPT_STATUSES),
  });
}
