import type { AgentActivityInput, AgentPlanItem, LinearClient } from "./linear.js";
import { agentActivityCreate, agentSessionUpdate } from "./linear.js";
import type { LinearOutboxRecord, TicketStore } from "./db.js";
import { sanitizeText } from "./sanitize.js";

// Shared helpers for enqueueing a single Linear outbox row and processing it
// immediately, used across the run lifecycle, the Linear/GitHub event
// handlers, and the scheduler. They live here (rather than being duplicated
// per caller) since they are pure wrappers over this module's own processor.

export async function tryPostError(
  store: TicketStore,
  outbox: LinearOutboxProcessor,
  sessionId: string | undefined,
  issueId: string | undefined,
  message: string
): Promise<void> {
  if (!sessionId) return;
  try {
    const row = store.enqueueLinearOutbox({
      linearSessionId: sessionId,
      issueId,
      kind: "activity",
      payload: activityPayload({
        sessionId,
        type: "error",
        body: sanitizeText(message),
      }),
    });
    await outbox.process(row.id);
  } catch (error) {
    console.error("[linear] failed to enqueue error activity:", error);
  }
}

export async function enqueueActivity(
  store: TicketStore,
  outbox: LinearOutboxProcessor,
  activity: AgentActivityInput,
  issueId?: string,
  runId?: string
): Promise<void> {
  const row = store.enqueueLinearOutbox({
    linearSessionId: activity.sessionId,
    issueId,
    runId,
    kind: "activity",
    payload: activityPayload(activity),
  });
  await outbox.process(row.id);
}

export async function enqueueSessionUpdate(
  store: TicketStore,
  outbox: LinearOutboxProcessor,
  params: {
    id?: string;
    sessionId: string;
    issueId?: string;
    externalUrls?: Array<{ label: string; url: string }>;
    addedExternalUrls?: Array<{ label: string; url: string }>;
    plan?: AgentPlanItem[];
  }
): Promise<void> {
  const row = store.enqueueLinearOutbox({
    id: params.id,
    linearSessionId: params.sessionId,
    issueId: params.issueId,
    kind: "session_update",
    payload: sessionUpdatePayload({
      sessionId: params.sessionId,
      externalUrls: params.externalUrls,
      addedExternalUrls: params.addedExternalUrls,
      plan: params.plan,
    }),
  });
  await outbox.process(row.id);
}

export interface LinearOutboxProcessor {
  process(id: string): Promise<void>;
  drain(limit?: number): Promise<void>;
}

type LinearOutboxPayload =
  | { type: "activity"; activity: AgentActivityInput }
  | {
      type: "session_update";
      sessionId: string;
      externalUrls?: Array<{ label: string; url: string }>;
      addedExternalUrls?: Array<{ label: string; url: string }>;
      plan?: AgentPlanItem[];
    };

function retryDelayMs(attempts: number): number {
  return Math.min(5 * 60_000, 2 ** Math.max(0, attempts - 1) * 5_000);
}

function classifyRetry(error: unknown): { retry: boolean; message: string } {
  const message = sanitizeText(String(error)).slice(-2_000);
  if (/invalid|permission|forbidden|unauthorized|revoked|missing/i.test(message)) {
    return { retry: false, message };
  }
  return { retry: true, message };
}

function parsePayload(row: LinearOutboxRecord): LinearOutboxPayload {
  const payload = JSON.parse(row.payload) as LinearOutboxPayload;
  if (payload.type !== row.kind) {
    throw new Error(`outbox ${row.id} payload kind mismatch`);
  }
  return payload;
}

async function deliver(linear: LinearClient, row: LinearOutboxRecord): Promise<void> {
  const payload = parsePayload(row);
  if (payload.type === "activity") {
    await agentActivityCreate(linear, { ...payload.activity, id: row.id });
    return;
  }
  await agentSessionUpdate(linear, {
    sessionId: payload.sessionId,
    externalUrls: payload.externalUrls,
    addedExternalUrls: payload.addedExternalUrls,
    plan: payload.plan,
  });
}

export function createLinearOutboxProcessor(params: {
  store: TicketStore;
  getLinearClient: () => Promise<LinearClient | undefined>;
  leaseMs?: number;
}): LinearOutboxProcessor {
  const leaseMs = params.leaseMs ?? 30_000;

  async function processRow(row: LinearOutboxRecord): Promise<void> {
    const linear = await params.getLinearClient();
    if (!linear) throw new Error("No valid Linear OAuth token is stored");
    await deliver(linear, row);
    params.store.markLinearOutboxProcessed(row.id);
  }

  return {
    async process(id: string) {
      const now = new Date();
      const rows = params.store.claimLinearOutbox(
        now.toISOString(),
        new Date(now.getTime() + leaseMs).toISOString(),
        50
      );
      if (!rows.some((candidate) => candidate.id === id)) return;
      for (const row of rows) {
        try {
          await processRow(row);
        } catch (error) {
          const classified = classifyRetry(error);
          params.store.markLinearOutboxFailed(
            row.id,
            classified.message,
            classified.retry
              ? new Date(Date.now() + retryDelayMs(row.attempts)).toISOString()
              : null
          );
        }
      }
    },
    async drain(limit = 50) {
      const now = new Date();
      const rows = params.store.claimLinearOutbox(
        now.toISOString(),
        new Date(now.getTime() + leaseMs).toISOString(),
        limit
      );
      for (const row of rows) {
        try {
          await processRow(row);
        } catch (error) {
          const classified = classifyRetry(error);
          params.store.markLinearOutboxFailed(
            row.id,
            classified.message,
            classified.retry
              ? new Date(Date.now() + retryDelayMs(row.attempts)).toISOString()
              : null
          );
        }
      }
    },
  };
}

export function activityPayload(activity: AgentActivityInput): string {
  return JSON.stringify({ type: "activity", activity });
}

export function sessionUpdatePayload(params: {
  sessionId: string;
  externalUrls?: Array<{ label: string; url: string }>;
  addedExternalUrls?: Array<{ label: string; url: string }>;
  plan?: AgentPlanItem[];
}): string {
  return JSON.stringify({ type: "session_update", ...params });
}
