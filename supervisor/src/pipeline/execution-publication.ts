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
// The unit ledger loop above (units x gates x downstream context) has no
// per-unit or per-gate count cap -- only each gate's own rationale string is
// bounded (RATIONALE_LIMIT) -- so a graph with many units can alone exceed
// PUBLICATION_BODY_LIMIT even with the activity log empty. This is the
// aggregate ceiling for the *entire* structured-ledger block this function
// returns (unit ledger + whole-change line + activity log combined), so the
// rest of the publication body (findings, event sentence, links -- including
// the PR link) always has PUBLICATION_BODY_LIMIT - MAX_STRUCTURED_LEDGER_BYTES
// bytes of guaranteed headroom regardless of how many units or gates exist.
// The activity log keeps its own MAX_ACTIVITY_LOG_BYTES allotment first (it
// is the durable, restart-safe history); the live unit ledger gets whatever
// remains of the aggregate budget.
export const MAX_STRUCTURED_LEDGER_BYTES = 8_000;

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

  const unitBlocks = snapshot.units.map((unit) => {
    const level = unit.terminal_level ?? "active";
    const alarm = unit.alarm ? "alarm" : "no alarm";
    const block = [
      `- ${unit.unit_id}: ${level} (${alarm}); state=${unit.status}${shortSubject(unit.integration_subject)}`,
    ];
    for (const gate of unit.gates) {
      block.push(`  - ${gate.kind}: ${gate.result}/${gate.outcome} by ${gate.evaluator}${shortSubject(gate.subject)} - ${gate.reason}`);
    }
    for (const context of unit.downstream_context) {
      block.push(`  - context to ${context.to_unit_id}: ${context.summary}`);
    }
    return block;
  });

  const wholeChangeLines = snapshot.graph.aggregate_artifact_hash || snapshot.graph.integration_subject
    ? [`Whole change: subject${shortSubject(snapshot.graph.integration_subject)}; aggregate=${snapshot.graph.aggregate_artifact_hash ?? "pending"}`]
    : [];

  // Restart-safe ordered history, distinct from the live per-unit state
  // above: sourced from the durable child-publication event rows (see
  // listExecutionPublicationEvents), so this section converges from durable
  // state after an outage instead of re-deriving from in-flight state. It
  // keeps its own MAX_ACTIVITY_LOG_BYTES allotment first, ahead of the live
  // unit ledger below, since it is the durable record.
  const activityLogLines: string[] = [];
  if (snapshot.activity_log && snapshot.activity_log.length > 0) {
    const eventLines = snapshot.activity_log.map((event) => {
      const unitLabel = event.unit_id ? ` \`${event.unit_id}\`` : "";
      return `- [${event.sequence}]${unitLabel} ${event.kind}: ${event.body}`;
    });
    const { items: boundedEventLines, omitted } = boundByBytes(
      eventLines,
      (line) => Buffer.byteLength(line, "utf8") + 1,
      MAX_ACTIVITY_LOG_BYTES
    );
    activityLogLines.push("**Structured Activity Log** (ordered)");
    if (omitted > 0) {
      activityLogLines.push(`- (${omitted} earlier entries omitted to stay within the publication byte budget)`);
    }
    activityLogLines.push(...boundedEventLines);
  }

  // The live unit ledger gets whatever remains of the aggregate structured
  // budget once the activity log's own allotment is set aside, so the
  // combined block never exceeds MAX_STRUCTURED_LEDGER_BYTES regardless of
  // unit/gate count.
  const reservedBytes = Buffer.byteLength([...wholeChangeLines, ...activityLogLines].join("\n"), "utf8");
  const unitLedgerBudget = Math.max(0, MAX_STRUCTURED_LEDGER_BYTES - reservedBytes);
  const { items: keptUnitBlocks, omitted: omittedUnits } = boundByBytes(
    unitBlocks,
    (block) => Buffer.byteLength(block.join("\n"), "utf8") + block.length,
    unitLedgerBudget
  );

  const lines = ["**Structured Unit Ledger**"];
  if (omittedUnits > 0) {
    lines.push(`- (${omittedUnits} earlier unit(s) omitted to stay within the publication byte budget)`);
  }
  for (const block of keptUnitBlocks) lines.push(...block);
  lines.push(...wholeChangeLines);
  lines.push(...activityLogLines);
  return lines;
}

// Keeps the most recent items that fit within maxBytes, dropping the oldest
// first -- always keeps at least one item so a single oversized entry still
// renders rather than vanishing entirely. Used both for individual activity
// log lines and for whole unit-ledger blocks (a unit's summary line plus its
// gate/context sub-lines), which callers keep atomic by measuring and
// unshifting the block as one item so truncation never separates a unit's
// gate detail from its own summary line.
function boundByBytes<T>(
  items: T[],
  sizeOf: (item: T) => number,
  maxBytes: number
): { items: T[]; omitted: number } {
  let usedBytes = 0;
  const kept: T[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    const itemBytes = sizeOf(item);
    if (usedBytes + itemBytes > maxBytes && kept.length > 0) break;
    usedBytes += itemBytes;
    kept.unshift(item);
  }
  return { items: kept, omitted: items.length - kept.length };
}
