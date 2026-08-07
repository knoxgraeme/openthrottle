import type { ExecutionUnitState } from "./unit-coordinator.js";
import { sanitizeText } from "../shared/sanitize.js";

const TEXT_LIMIT = 500;
const RATIONALE_LIMIT = 1_000;
const MAX_ACTIONS_PER_UNIT = 3;
const MAX_CONTEXT_PER_UNIT = 3;
// Pairs the MAX_ACTIVITY_LOG_EVENTS count cap with an explicit byte budget,
// the same downstream-context precedent as MAX_DOWNSTREAM_CONTEXT_RECORDS +
// MAX_DOWNSTREAM_CONTEXT_BYTES (structured-loop-limits.ts): 32 events at the
// per-event TEXT_LIMIT can alone exceed PUBLICATION_BODY_LIMIT, which would
// otherwise let the log evict the findings, event sentence, and links that
// are rendered after it in the body.
export const MAX_ACTIVITY_LOG_BYTES = 6_000;

export interface ExecutionPublicationActivityEvent {
  sequence: number;
  kind: string;
  unit_id: string | null;
  body: string;
}

export interface ExecutionPublicationSnapshot {
  graph: {
    id: string;
    parent_attempt_id: string;
    parent_stage_id: string;
    integration_subject: string | null;
    aggregate_artifact_hash: string | null;
    aggregate_emitted_at: string | null;
    stopped_at: string | null;
    stop_reason: string | null;
  };
  units: ExecutionPublicationUnit[];
  // Restart-safe, ordered activity history sourced from the durable
  // child-publication event rows (RR18/RAE7) -- distinct from `units`, which
  // is a live snapshot of current state. Each row is inserted in the same
  // transaction as the child transition it reports, so this converges
  // immediately from durable state without waiting on that event's own
  // correlated Linear activity to finish delivering. Optional: envelopes
  // persisted before this field existed round-trip through
  // parsePipelinePublication without it.
  activity_log?: ExecutionPublicationActivityEvent[];
}

export interface ExecutionPublicationUnit {
  unit_id: string;
  ordinal: number;
  dependencies: string[];
  status: ExecutionUnitState["status"];
  terminal_level: ExecutionUnitState["terminalLevel"];
  alarm: boolean;
  active_action_id: string | null;
  integration_subject: string | null;
  attempts: Array<{
    id: string;
    action_kind: string;
    attempt_ordinal: number;
    status: string;
    output_subject: string | null;
    native_session_id: string | null;
    request_hash: string | null;
    result_hash: string | null;
    last_error: string | null;
  }>;
  gates: Array<{
    kind: string;
    evaluator: string;
    result: string;
    outcome: string;
    subject: string | null;
    reason: string;
    artifact_hashes: string[];
    receipt_hash: string;
  }>;
  downstream_context: Array<{
    to_unit_id: string;
    summary: string;
    payload_hash: string;
  }>;
}

export interface ExecutionPublicationInput {
  graph: {
    id: string;
    parent_attempt_id: string;
    parent_stage_id: string;
    integration_subject: string | null;
    aggregate_artifact_hash: string | null;
    aggregate_emitted_at: string | null;
    stopped_at: string | null;
    stop_reason: string | null;
  } | undefined;
  units: readonly ExecutionUnitState[];
  attempts: readonly {
    id: string;
    unit_id: string;
    action_kind: string;
    attempt_ordinal: number;
    status: string;
    output_subject: string | null;
    native_session_id: string | null;
    request_hash: string | null;
    result_hash: string | null;
    last_error: string | null;
  }[];
  gates: readonly {
    unit_id: string;
    gate_kind: string;
    evaluator_kind: string;
    result: string;
    outcome: string;
    subject: string | null;
    reason: string;
    artifact_hashes: string;
    receipt_hash: string;
  }[];
  downstreamContext: readonly {
    from_unit_id: string;
    to_unit_id: string;
    payload: string;
    payload_hash: string;
  }[];
  activityLog?: readonly ExecutionPublicationActivityEvent[];
}

export function bounded(value: string | null | undefined, limit = TEXT_LIMIT): string | null {
  if (value == null) return null;
  const sanitized = sanitizeText(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, limit);
  return sanitized.length > 0 ? sanitized : null;
}

function shortSubject(subject: string | null): string {
  return subject ? ` \`${subject.slice(0, 12)}\`` : "";
}

function parseArtifactHashes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string").slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

function contextSummary(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const summary = (parsed as Record<string, unknown>).summary;
      if (typeof summary === "string") return bounded(summary, TEXT_LIMIT) ?? "context update";
    }
  } catch {
    // Fall through to the raw bounded payload.
  }
  return bounded(payload, TEXT_LIMIT) ?? "context update";
}

function groupBy<T>(items: readonly T[], keyFor: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return groups;
}

export function buildExecutionPublicationSnapshot(
  input: ExecutionPublicationInput
): ExecutionPublicationSnapshot | undefined {
  if (!input.graph) return undefined;
  const attemptsByUnit = groupBy(input.attempts, (attempt) => attempt.unit_id);
  const gatesByUnit = groupBy(input.gates, (gate) => gate.unit_id);
  const contextByUnit = groupBy(input.downstreamContext, (context) => context.from_unit_id);
  return {
    graph: {
      id: input.graph.id,
      parent_attempt_id: input.graph.parent_attempt_id,
      parent_stage_id: input.graph.parent_stage_id,
      integration_subject: input.graph.integration_subject,
      aggregate_artifact_hash: input.graph.aggregate_artifact_hash,
      aggregate_emitted_at: input.graph.aggregate_emitted_at,
      stopped_at: input.graph.stopped_at,
      stop_reason: bounded(input.graph.stop_reason),
    },
    units: input.units.map((unit) => ({
      unit_id: unit.unitId,
      ordinal: unit.ordinal,
      dependencies: [...unit.dependencies],
      status: unit.status,
      terminal_level: unit.terminalLevel,
      alarm: unit.alarm,
      active_action_id: unit.activeActionId,
      integration_subject: unit.integrationSubject,
      attempts: (attemptsByUnit.get(unit.unitId) ?? []).slice(0, MAX_ACTIONS_PER_UNIT).map((attempt) => ({
        id: attempt.id,
        action_kind: attempt.action_kind,
        attempt_ordinal: attempt.attempt_ordinal,
        status: attempt.status,
        output_subject: attempt.output_subject,
        native_session_id: bounded(attempt.native_session_id),
        request_hash: attempt.request_hash,
        result_hash: attempt.result_hash,
        last_error: bounded(attempt.last_error),
      })),
      gates: (gatesByUnit.get(unit.unitId) ?? []).map((gate) => ({
        kind: gate.gate_kind,
        evaluator: gate.evaluator_kind,
        result: gate.result,
        outcome: gate.outcome,
        subject: gate.subject,
        reason: bounded(gate.reason, RATIONALE_LIMIT) ?? "",
        artifact_hashes: parseArtifactHashes(gate.artifact_hashes),
        receipt_hash: gate.receipt_hash,
      })),
      downstream_context: (contextByUnit.get(unit.unitId) ?? []).slice(0, MAX_CONTEXT_PER_UNIT).map((context) => ({
        to_unit_id: context.to_unit_id,
        summary: contextSummary(context.payload),
        payload_hash: context.payload_hash,
      })),
    })),
    activity_log: (input.activityLog ?? []).map((event) => ({
      sequence: event.sequence,
      kind: event.kind,
      unit_id: event.unit_id,
      body: bounded(event.body) ?? "",
    })),
  };
}

export function executionLedgerLines(snapshot: ExecutionPublicationSnapshot | undefined): string[] {
  if (!snapshot) return [];
  const lines = ["**Structured Unit Ledger**"];
  for (const unit of snapshot.units) {
    const level = unit.terminal_level ?? "active";
    const alarm = unit.alarm ? "alarm" : "no alarm";
    lines.push(`- ${unit.unit_id}: ${level} (${alarm}); state=${unit.status}${shortSubject(unit.integration_subject)}`);
    for (const gate of unit.gates) {
      lines.push(`  - ${gate.kind}: ${gate.result}/${gate.outcome} by ${gate.evaluator}${shortSubject(gate.subject)} - ${gate.reason}`);
    }
    for (const context of unit.downstream_context) {
      lines.push(`  - context to ${context.to_unit_id}: ${context.summary}`);
    }
  }
  if (snapshot.graph.aggregate_artifact_hash || snapshot.graph.integration_subject) {
    lines.push(
      `Whole change: subject${shortSubject(snapshot.graph.integration_subject)}; aggregate=${snapshot.graph.aggregate_artifact_hash ?? "pending"}`
    );
  }
  // Restart-safe ordered history, distinct from the live per-unit state above:
  // sourced from the durable child-publication event rows (see
  // listExecutionPublicationEvents), so this section converges from durable
  // state after an outage instead of re-deriving from in-flight state.
  if (snapshot.activity_log && snapshot.activity_log.length > 0) {
    const eventLines = snapshot.activity_log.map((event) => {
      const unitLabel = event.unit_id ? ` \`${event.unit_id}\`` : "";
      return `- [${event.sequence}]${unitLabel} ${event.kind}: ${event.body}`;
    });
    const { lines: boundedEventLines, omitted } = boundActivityLogLinesByBytes(eventLines, MAX_ACTIVITY_LOG_BYTES);
    lines.push("**Structured Activity Log** (ordered)");
    if (omitted > 0) {
      lines.push(`- (${omitted} earlier entries omitted to stay within the publication byte budget)`);
    }
    lines.push(...boundedEventLines);
  }
  return lines;
}

// Keeps the most recent lines that fit within maxBytes, dropping the oldest
// first -- always keeps at least one line so a single oversized entry still
// renders rather than vanishing entirely.
function boundActivityLogLinesByBytes(
  lines: string[],
  maxBytes: number
): { lines: string[]; omitted: number } {
  let usedBytes = 0;
  const kept: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (usedBytes + lineBytes > maxBytes && kept.length > 0) break;
    usedBytes += lineBytes;
    kept.unshift(line);
  }
  return { lines: kept, omitted: lines.length - kept.length };
}
