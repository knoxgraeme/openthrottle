import type { AgentActivityInput, AgentPlanItem, LinearClient, LinearComment, LinearIssueStateSignal } from "./client.js";
import {
  agentActivityCreate,
  agentSessionUpdate,
  commentCreate,
  commentUpdate,
  findCurrentAppCommentById,
  findIssueCommentByMarker,
  issueStateUpdate,
  linearFileUpload,
} from "./client.js";
import type { ActivityPublicationPort } from "../../app/ports.js";
import type { SupervisorStore } from "../../persistence/store.js";
import type { LinearOutboxRecord } from "../../persistence/delivery-store.js";
import { pipelineStatusCommentMarker } from "../../pipeline/publication.js";
import { classifyPermanentFailure, exponentialBackoffDelayMs } from "../../shared/backoff.js";
import { sanitizeText } from "../../shared/sanitize.js";

// Shared helpers for enqueueing a single Linear outbox row and processing it
// immediately, used across pipeline effects and the Linear/GitHub event
// handlers. They live here (rather than being duplicated
// per caller) since they are pure wrappers over this module's own processor.

export async function tryPostError(
  store: SupervisorStore,
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
  store: SupervisorStore,
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

export function createLinearActivityPublisher(
  store: SupervisorStore,
  outbox: LinearOutboxProcessor
): ActivityPublicationPort {
  return {
    publishActivity: (activity, issueId, runId) =>
      enqueueActivity(store, outbox, activity, issueId, runId),
    publishError: (sessionId, issueId, message) =>
      tryPostError(store, outbox, sessionId, issueId, message),
  };
}

export async function enqueueSessionUpdate(
  store: SupervisorStore,
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
    }
  | {
      type: "pipeline_receipt";
      publication: {
        body: string;
        artifactInline?: string;
        attachment?: { filename: string; contentType: "application/json"; content: string };
      };
    }
  | {
      type: "pipeline_status";
      publication: {
        body: string;
      };
    }
  | {
      type: "issue_state";
      issueId: string;
      signal: LinearIssueStateSignal;
    };

function classifyRetry(error: unknown): { retry: boolean; message: string } {
  return classifyPermanentFailure(error, /invalid|permission|forbidden|unauthorized|revoked|missing/i);
}

function isNotFoundError(error: unknown): boolean {
  return /\bnot[ _-]?found\b|not_found|does not exist|could not find/i.test(String(error));
}

async function findOwnedCommentById(
  linear: LinearClient,
  id: string
): Promise<LinearComment | undefined> {
  try {
    return await findCurrentAppCommentById(linear, id);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    return undefined;
  }
}

function parsePayload(row: LinearOutboxRecord): LinearOutboxPayload {
  const payload = JSON.parse(row.payload) as LinearOutboxPayload;
  if (payload.type !== row.kind) {
    throw new Error(`outbox ${row.id} payload kind mismatch`);
  }
  return payload;
}

async function deliver(
  linear: LinearClient,
  row: LinearOutboxRecord,
  store: SupervisorStore
): Promise<{ externalId?: string; externalUrl?: string; attachmentUrl?: string }> {
  const payload = parsePayload(row);
  if (payload.type === "activity") {
    const result = await agentActivityCreate(linear, { ...payload.activity, id: row.id });
    return { externalId: result.agentActivity?.id };
  }
  if (payload.type === "session_update") {
    await agentSessionUpdate(linear, {
      sessionId: payload.sessionId,
      externalUrls: payload.externalUrls,
      addedExternalUrls: payload.addedExternalUrls,
      plan: payload.plan,
    });
    return {};
  }
  if (payload.type === "issue_state") {
    const result = await issueStateUpdate(linear, {
      issueId: payload.issueId,
      signal: payload.signal,
    });
    return { externalId: result.state?.id };
  }
  if (payload.type === "pipeline_status") {
    if (!row.linear_issue_id) throw new Error(`pipeline status ${row.id} has no Linear issue`);
    const ticket = store.getByIssueId(row.linear_issue_id);
    if (ticket && row.linear_session_id && ticket.linear_session_id !== row.linear_session_id) {
      return {};
    }
    const body = sanitizeText([
      payload.publication.body,
      ...(ticket?.pr_url ? ["", `Pull request: ${ticket.pr_url}`] : []),
    ].join("\n")).slice(0, 20_000);
    let existing: LinearComment | undefined;
    if (row.external_id) {
      existing = await findOwnedCommentById(linear, row.external_id);
    } else {
      existing = await findOwnedCommentById(linear, row.id);
      const marker = pipelineStatusCommentMarker(row.linear_issue_id);
      existing ??= await findIssueCommentByMarker(linear, row.linear_issue_id, marker);
    }
    if (existing?.id) {
      if ("body" in existing && existing.body === body) {
        return { externalId: existing.id, externalUrl: existing.url ?? undefined };
      }
      try {
        const result = await commentUpdate(linear, { id: existing.id, body });
        return { externalId: result.comment?.id ?? existing.id, externalUrl: result.comment?.url ?? existing.url ?? undefined };
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    }
    const result = await commentCreate(linear, { id: row.id, issueId: row.linear_issue_id, body });
    return { externalId: result.comment?.id, externalUrl: result.comment?.url ?? undefined };
  }
  if (!row.linear_session_id) throw new Error(`pipeline receipt ${row.id} has no Linear session`);
  let attachmentUrl = row.attachment_url ?? undefined;
  if (payload.publication.attachment && !attachmentUrl) {
    const upload = await linearFileUpload(linear, payload.publication.attachment);
    attachmentUrl = upload.assetUrl;
    store.recordLinearOutboxAttachment(row.id, attachmentUrl);
  }
  const body = sanitizeText([
    payload.publication.body,
    ...(payload.publication.artifactInline
      ? ["", "<details><summary>Typed evidence</summary>", "", "```json", payload.publication.artifactInline, "```", "</details>"]
      : []),
    ...(attachmentUrl ? ["", `[Private typed evidence attachment](${attachmentUrl})`] : []),
  ].join("\n")).slice(0, 20_000);
  const result = await agentActivityCreate(linear, {
    id: row.id,
    sessionId: row.linear_session_id,
    type: "response",
    body,
  });
  return { externalId: result.agentActivity?.id, attachmentUrl };
}

export function createLinearOutboxProcessor(params: {
  store: SupervisorStore;
  getLinearClient: () => Promise<LinearClient | undefined>;
  leaseMs?: number;
}): LinearOutboxProcessor {
  const leaseMs = params.leaseMs ?? 30_000;

  async function processRow(row: LinearOutboxRecord): Promise<void> {
    const linear = await params.getLinearClient();
    if (!linear) throw new Error("No valid Linear OAuth token is stored");
    const receipt = await deliver(linear, row, params.store);
    params.store.markLinearOutboxProcessed(row.id, receipt, row.payload_hash);
  }

  async function processRows(rows: LinearOutboxRecord[]): Promise<void> {
    for (const row of rows) {
      try {
        await processRow(row);
      } catch (error) {
        const classified = classifyRetry(error);
        params.store.markLinearOutboxFailed(
          row.id,
          classified.message,
          classified.retry
            ? new Date(Date.now() + exponentialBackoffDelayMs(row.attempts)).toISOString()
            : null,
          row.payload_hash
        );
      }
    }
  }

  return {
    async process(id: string) {
      const now = new Date();
      const rows = params.store.claimLinearOutboxForId(
        id,
        now.toISOString(),
        new Date(now.getTime() + leaseMs).toISOString(),
        50
      );
      await processRows(rows);
    },
    async drain(limit = 50) {
      const now = new Date();
      await processRows(params.store.claimLinearOutbox(
        now.toISOString(),
        new Date(now.getTime() + leaseMs).toISOString(),
        limit
      ));
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
