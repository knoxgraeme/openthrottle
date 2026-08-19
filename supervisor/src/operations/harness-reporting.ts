import {
  HARNESS_INCIDENT_SCHEMA,
  HARNESS_REPORT_ENVELOPE_SCHEMA,
  HARNESS_REPORT_PRIVACY_PROFILE,
  digestCanonicalJson,
  validateHarnessReportEnvelope,
  validateHarnessReportReceipt,
  type HarnessReportEnvelope,
  type HarnessReportingMode,
  type UnitDecisionReceipt,
} from "@openthrottle/contracts";
import type { ExecutionGateDecision } from "../pipeline/execution-gates.js";
import type { PipelineInstance } from "../pipeline/store.js";
import type { ExecutionWorkAttempt } from "../persistence/pipeline/unit-store.js";
import type {
  HarnessReportOutboxRecord,
  HarnessReportStore,
} from "../persistence/harness-report-store.js";
import { exponentialBackoffDelayMs } from "../shared/backoff.js";
import { readStreamUpToByteLimit } from "../shared/bounded-stream.js";
import { sanitizeText } from "../shared/sanitize.js";

const REPORT_LEASE_MS = 60_000;
const REPORT_TIMEOUT_MS = 10_000;
const REPORT_RETRY_BASE_MS = 30_000;
const REPORT_MAX_RETRY_MS = 60 * 60_000;
const REPORT_MAX_ATTEMPTS = 10;
const REPORT_RESPONSE_MAX_BYTES = 16 * 1024;
const REPORT_RECOVERY_LOOKBACK_MS = 30 * 24 * 60 * 60_000;
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 409, 413, 422]);

export interface HarnessReportCapture {
  capture(input: {
    instance: PipelineInstance;
    action: ExecutionWorkAttempt;
    receipt: UnitDecisionReceipt;
    decision: ExecutionGateDecision;
  }): void;
}

export interface HarnessReportProcessor extends HarnessReportCapture {
  reconcile(): void;
  drain(): Promise<void>;
}

type HarnessReportProcessorCommon = {
  fetch?: typeof fetch;
  now?: () => Date;
  logError?: (message: string) => void;
};

type HarnessReportProcessorInput = HarnessReportProcessorCommon & (
  | { mode: "off" }
  | {
      mode: Exclude<HarnessReportingMode, "off">;
      endpoint: string;
      token: string;
      store: HarnessReportStore;
      recoverySinceIso?: string;
    }
);

function reportIdFromOccurrence(input: {
  instanceId: string;
  actionId: string;
  receipt: UnitDecisionReceipt;
}): string {
  const hex = digestCanonicalJson([input.instanceId, input.actionId, input.receipt]).slice(0, 32);
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function buildHarnessReportEnvelope(input: {
  mode: Exclude<HarnessReportingMode, "off">;
  instance: Pick<PipelineInstance, "id" | "runtime_release">;
  action: Pick<ExecutionWorkAttempt, "id" | "cycle">;
  receipt: UnitDecisionReceipt;
  decision: Pick<ExecutionGateDecision, "outcome" | "reason">;
}): HarnessReportEnvelope {
  const report = input.receipt.payload.harness_report;
  const includeReport = input.mode === "on" && report !== undefined;
  let agentReportStatus: HarnessReportEnvelope["agent_report_status"] = "not_provided";
  if (input.mode === "deterministic") agentReportStatus = "not_requested";
  else if (includeReport) agentReportStatus = "included";
  return validateHarnessReportEnvelope({
    schema: HARNESS_REPORT_ENVELOPE_SCHEMA,
    report_id: reportIdFromOccurrence({
      instanceId: input.instance.id,
      actionId: input.action.id,
      receipt: input.receipt,
    }),
    mode: input.mode,
    privacy_profile: HARNESS_REPORT_PRIVACY_PROFILE,
    receipt: {
      schema: HARNESS_INCIDENT_SCHEMA,
      runtime: {
        runtime_release: input.instance.runtime_release,
        protocol: "stage-executor/1",
        capability: "accept-unit/1",
      },
      incident: {
        component: "structured_loop",
        boundary: "gate_evaluation",
        operation: "lead",
        outcome: input.decision.outcome,
        reason_code: input.decision.reason,
        retry_count: input.action.cycle,
      },
    },
    agent_report_status: agentReportStatus,
    ...(includeReport ? { agent_report: report } : {}),
  }).value;
}

function retryAt(record: HarnessReportOutboxRecord, now: Date): string | null {
  if (record.attempts >= REPORT_MAX_ATTEMPTS) return null;
  return new Date(now.getTime() + exponentialBackoffDelayMs(record.attempts, {
    baseDelayMs: REPORT_RETRY_BASE_MS,
    maxDelayMs: REPORT_MAX_RETRY_MS,
  })).toISOString();
}

function responseError(status: number): string {
  return `harness reporting backend returned HTTP ${status}`;
}

export function createHarnessReportProcessor(input: HarnessReportProcessorInput): HarnessReportProcessor {
  if (input.mode === "off") {
    return { capture() {}, reconcile() {}, async drain() {} };
  }
  const request = input.fetch ?? fetch;
  const now = input.now ?? (() => new Date());
  const logError = input.logError ?? ((message: string) => console.error(`[harness-reporting] ${message}`));
  let draining = false;

  const fail = (
    record: HarnessReportOutboxRecord,
    message: string,
    permanent = false
  ): void => {
    const timestamp = now();
    input.store.markFailed(
      record.id,
      record.payload_hash,
      sanitizeText(message, process.env, [input.token ?? ""]).slice(0, 1_000),
      permanent ? null : retryAt(record, timestamp),
      timestamp.toISOString()
    );
  };

  const deliver = async (record: HarnessReportOutboxRecord): Promise<void> => {
    try {
      let envelope: HarnessReportEnvelope;
      try {
        envelope = validateHarnessReportEnvelope(JSON.parse(record.payload)).value;
      } catch {
        fail(record, "harness report outbox contains an invalid envelope", true);
        return;
      }
      if (input.mode === "deterministic" && envelope.mode === "on") {
        fail(record, "reporting mode no longer permits queued envelope", true);
        return;
      }
      const response = await request(input.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
          "idempotency-key": record.id,
        },
        body: record.payload,
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      });
      if (response.status !== 200 && response.status !== 202) {
        await response.body?.cancel().catch(() => undefined);
        fail(record, responseError(response.status), PERMANENT_HTTP_STATUSES.has(response.status));
        return;
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > REPORT_RESPONSE_MAX_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        fail(record, "harness reporting backend returned an oversized receipt", true);
        return;
      }
      const bounded = response.body
        ? await readStreamUpToByteLimit(response.body, REPORT_RESPONSE_MAX_BYTES)
        : { exceeded: false as const, bytes: new Uint8Array() };
      if (bounded.exceeded) {
        fail(record, "harness reporting backend returned an oversized receipt", true);
        return;
      }
      const body = new TextDecoder().decode(bounded.bytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        fail(record, "harness reporting backend returned a malformed receipt", true);
        return;
      }
      let receipt;
      try {
        receipt = validateHarnessReportReceipt(parsed).value;
      } catch {
        fail(record, "harness reporting backend returned an invalid receipt", true);
        return;
      }
      if (receipt.report_id !== record.id) {
        fail(record, "harness reporting backend receipt id mismatch", true);
        return;
      }
      input.store.markProcessed(record.id, record.payload_hash, now().toISOString());
    } catch (error) {
      fail(record, error instanceof Error ? error.message : String(error));
    }
  };

  return {
    capture({ instance, action, receipt, decision }) {
      if (!receipt.payload.harness_report && decision.outcome !== "needs_human") return;
      try {
        input.store.enqueue(buildHarnessReportEnvelope({
          mode: input.mode,
          instance,
          action,
          receipt,
          decision,
        }), now().toISOString());
      } catch (error) {
        logError(`capture failed: ${sanitizeText(error instanceof Error ? error.message : String(error))}`);
      }
    },

    reconcile() {
      if (!input.recoverySinceIso) return;
      const retentionCutoff = new Date(now().getTime() - REPORT_RECOVERY_LOOKBACK_MS).toISOString();
      const recoveryCutoff = input.recoverySinceIso > retentionCutoff
        ? input.recoverySinceIso
        : retentionCutoff;
      for (const candidate of input.store.listRecoveryCandidates(recoveryCutoff)) {
        try {
          const parsed = JSON.parse(candidate.receipt) as unknown;
          if (
            typeof parsed !== "object" || parsed === null ||
            (parsed as { type?: unknown }).type !== "unit_decision" ||
            typeof (parsed as { payload?: unknown }).payload !== "object" ||
            (parsed as { payload?: unknown }).payload === null
          ) {
            throw new Error("completed lead receipt is not a unit_decision");
          }
          const receipt = parsed as UnitDecisionReceipt;
          input.store.enqueue(buildHarnessReportEnvelope({
            mode: input.mode,
            instance: {
              id: candidate.instance_id,
              runtime_release: candidate.runtime_release,
            },
            action: { id: candidate.action_id, cycle: candidate.cycle },
            receipt,
            decision: { outcome: candidate.outcome, reason: candidate.reason },
          }), now().toISOString());
        } catch (error) {
          logError(`recovery failed for completed lead: ${sanitizeText(
            error instanceof Error ? error.message : String(error)
          )}`);
        }
      }
    },

    async drain() {
      if (draining) return;
      draining = true;
      try {
        const timestamp = now();
        const records = input.store.claim(
          timestamp.toISOString(),
          new Date(timestamp.getTime() + REPORT_LEASE_MS).toISOString(),
          20
        );
        await Promise.all(records.map(deliver));
      } finally {
        draining = false;
      }
    },
  };
}
