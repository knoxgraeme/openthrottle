import { createHmac, timingSafeEqual } from "node:crypto";
import type { ControlThreadEvent } from "../../app/ports.js";
import { linearGraphQL, type LinearClient } from "./client.js";

export function verifyLinearSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  webhookSecret: string
): boolean {
  if (!signatureHeader || !/^[a-f\d]{64}$/i.test(signatureHeader)) return false;
  const expected = createHmac("sha256", webhookSecret).update(rawBody).digest();
  const actual = Buffer.from(signatureHeader, "hex");
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

export function isRecentLinearWebhook(
  webhookTimestamp: number,
  maxAgeSeconds: number,
  nowMs = Date.now()
): boolean {
  return (
    Number.isFinite(webhookTimestamp) &&
    Math.abs(nowMs - webhookTimestamp) <= maxAgeSeconds * 1000
  );
}

interface ControlThreadWebhookPayload {
  id: string;
  identifier: string;
  team?: { id?: string; key?: string; name?: string };
  labels?: Array<{ id?: string; name: string }> | { nodes?: Array<{ name: string }> };
}

export interface ControlAgentSessionEventPayload {
  action: "created" | "prompted";
  type: "AgentSessionEvent";
  webhookId: string;
  webhookTimestamp: number;
  organizationId: string;
  oauthClientId?: string;
  appUserId?: string;
  promptContext?: string;
  agentSession: {
    id: string;
    issueId?: string;
    issue?: ControlThreadWebhookPayload;
  };
  agentActivity?: {
    id: string;
    signal?: string;
    content?: { type?: string; body?: string };
    body?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Linear delivers agent-activity control signals (currently `stop`, plus the
// agent->human `auth`/`select` signals) on `agentActivity.signal`. The docs
// describe a string enum, but the wire payload can arrive as an object, so
// accept either shape and reduce it to a lowercase signal name.
function normalizeSignal(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    return value === "" ? undefined : value;
  }
  if (isRecord(raw)) {
    const candidate = raw.type ?? raw.name ?? raw.signal ?? raw.value;
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim().toLowerCase();
    }
  }
  return undefined;
}

export function parseLinearWebhook(raw: string): ControlAgentSessionEventPayload {
  const payload: unknown = JSON.parse(raw);
  if (!isRecord(payload)) throw new Error("Linear webhook body must be an object");
  if (payload.type !== "AgentSessionEvent") {
    throw new Error(`Unexpected Linear webhook type: ${String(payload.type)}`);
  }
  if (payload.action !== "created" && payload.action !== "prompted") {
    throw new Error(`Unexpected Linear agent action: ${String(payload.action)}`);
  }
  if (!isRecord(payload.agentSession) || typeof payload.agentSession.id !== "string") {
    throw new Error("Linear webhook is missing agentSession.id");
  }
  if (payload.agentSession.issue !== undefined) {
    if (!isRecord(payload.agentSession.issue)) {
      throw new Error("Linear webhook has invalid agentSession.issue");
    }
    const issue = payload.agentSession.issue;
    if (typeof issue.id !== "string" || issue.id === "") {
      throw new Error("Linear webhook is missing agentSession.issue.id");
    }
    if (
      typeof issue.identifier !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(issue.identifier)
    ) {
      throw new Error("Linear webhook has an unsafe agentSession.issue.identifier");
    }
  }
  if (typeof payload.webhookId !== "string" || typeof payload.webhookTimestamp !== "number") {
    throw new Error("Linear webhook is missing webhookId/webhookTimestamp");
  }
  if (typeof payload.organizationId !== "string") {
    throw new Error("Linear webhook is missing organizationId");
  }
  if (payload.promptContext !== undefined && typeof payload.promptContext !== "string") {
    throw new Error("Linear webhook has invalid promptContext");
  }
  if (payload.action === "prompted") {
    if (!isRecord(payload.agentActivity) || typeof payload.agentActivity.id !== "string") {
      throw new Error("Prompted webhook is missing agentActivity.id");
    }
    const rawSignal = payload.agentActivity.signal;
    if (rawSignal !== undefined && typeof rawSignal !== "string") {
      console.warn("[linear] non-string agentActivity.signal:", JSON.stringify(rawSignal));
    }
    const signal = normalizeSignal(rawSignal);
    payload.agentActivity.signal = signal;
    const body = isRecord(payload.agentActivity.content)
      ? payload.agentActivity.content.body
      : payload.agentActivity.body;
    if (signal !== "stop" && (typeof body !== "string" || body.trim() === "")) {
      throw new Error("Prompted webhook is missing agentActivity.body");
    }
  }
  return payload as unknown as ControlAgentSessionEventPayload;
}

export function linearControlEvent(payload: ControlAgentSessionEventPayload): ControlThreadEvent {
  const issue = payload.agentSession.issue;
  return {
    provider: "linear",
    action: payload.action,
    promptContext: payload.promptContext,
    agentSession: {
      id: payload.agentSession.id,
      threadId: payload.agentSession.issueId,
      thread: issue
        ? {
            id: issue.id,
            identifier: issue.identifier,
            provider: "linear",
            route: issue.team,
            labels: issue.labels,
          }
        : undefined,
    },
    activity: payload.agentActivity,
  };
}

export interface ResolvedLabel {
  name: string;
  parentName?: string;
}

export async function fetchIssueLabels(
  client: LinearClient,
  issueId: string
): Promise<ResolvedLabel[]> {
  const data = await linearGraphQL<{
    issue?: { labels?: { nodes?: Array<{ name?: string; parent?: { name?: string } | null }> } };
  }>(
    client,
    `query IssueLabels($id: String!) {
      issue(id: $id) {
        labels { nodes { name parent { name } } }
      }
    }`,
    { id: issueId }
  );
  const nodes = data.issue?.labels?.nodes ?? [];
  const resolved: ResolvedLabel[] = [];
  for (const node of nodes) {
    if (typeof node?.name !== "string") continue;
    resolved.push({
      name: node.name,
      parentName: typeof node.parent?.name === "string" ? node.parent.name : undefined,
    });
  }
  return resolved;
}
