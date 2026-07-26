import type {
  RuntimeWorkspace,
  RuntimeWorkspaceAccess,
  SandboxAutostopRuntime,
} from "./contracts.js";
import type { Ticket, SupervisorStore } from "../persistence/store.js";
import { reconcileSandboxAutostop } from "./lifecycle.js";
import { sanitizeText } from "../shared/sanitize.js";
import {
  parseSandboxEvent,
  sanitizePlan,
  toProgressActivity,
  type RuntimePlanItem,
  type RuntimeProgressActivityInput,
  type SandboxActivityEvent,
  type SandboxEvent,
  type SandboxPlanEvent,
  type SandboxStageResultEvent,
} from "./events.js";

const OUTBOX_DIR = "/home/agent/.ot/outbox";
const SEALED_HEARTBEAT_FILE = "/var/lib/openthrottle/heartbeat/heartbeat.json";
const SEALED_STAGE_RESULT_DIR = "/var/lib/openthrottle/stage-results";
const WORKSPACE_SUBJECT_COMMAND = "node /opt/openthrottle/runner/execute-stage.mjs --print-subject --repo /home/agent/repo";
const MAX_EVENT_BYTES = 32 * 1024;
const MAX_STAGE_EVENT_BYTES = 64 * 1024;
const INGESTION_DIAGNOSTIC_ATTEMPTS = 5;

interface SandboxEventFile {
  name: string;
  remotePath: string;
  size: number;
  sealedHeartbeat: boolean;
  sealedStageResult: boolean;
  prefetched?: Buffer;
}

async function listEventFiles(sandbox: RuntimeWorkspace): Promise<SandboxEventFile[]> {
  const files = await sandbox.fs.listFiles!(OUTBOX_DIR);
  const events: SandboxEventFile[] = files
    .filter((file) => !file.isDir && typeof file.name === "string" && /^[A-Za-z0-9._-]+\.json$/.test(file.name))
    .map((file) => ({
      name: file.name!,
      remotePath: `${OUTBOX_DIR}/${file.name}`,
      size: file.size,
      sealedHeartbeat: false,
      sealedStageResult: false,
    }));
  try {
    const heartbeat = await sandbox.fs.downloadFile!(SEALED_HEARTBEAT_FILE);
    if (Buffer.isBuffer(heartbeat) && heartbeat.length > 0) {
      events.push({
        name: "000-sealed-heartbeat.json",
        remotePath: SEALED_HEARTBEAT_FILE,
        size: heartbeat.length,
        sealedHeartbeat: true,
        sealedStageResult: false,
        prefetched: heartbeat,
      });
    }
  } catch {
    // No sealed pulse has landed yet.
  }
  try {
    const stageResults = await sandbox.fs.listFiles!(SEALED_STAGE_RESULT_DIR);
    events.push(...stageResults
      .filter((file) => !file.isDir && typeof file.name === "string" && /^[A-Za-z0-9._-]+\.json$/.test(file.name) &&
        (!file.path || file.path.startsWith(`${SEALED_STAGE_RESULT_DIR}/`)))
      .map((file) => ({
        name: `100-stage-${file.name}`,
        remotePath: `${SEALED_STAGE_RESULT_DIR}/${file.name}`,
        size: file.size,
        sealedHeartbeat: false,
        sealedStageResult: true,
      })));
  } catch {
    // No sealed stage result has landed yet.
  }
  return events.sort((left, right) => left.name.localeCompare(right.name));
}

async function readWorkspaceSubject(sandbox: RuntimeWorkspace): Promise<string> {
  if (!sandbox.process?.executeCommand) throw new Error("sandbox cannot attest the current workspace subject");
  const result = await sandbox.process.executeCommand(WORKSPACE_SUBJECT_COMMAND, undefined, undefined, 30);
  const subject = result.result?.trim();
  if (result.exitCode !== 0 || !subject || !/^[a-f0-9]{40,64}$/.test(subject)) {
    throw new Error("sandbox current workspace subject attestation failed");
  }
  return subject;
}

interface SandboxEventPollerParams {
  runtime: RuntimeWorkspaceAccess & SandboxAutostopRuntime;
  store: SupervisorStore;
  postActivity: (
    activity: RuntimeProgressActivityInput,
    event: SandboxActivityEvent & { issueId: string }
  ) => Promise<unknown>;
  // Forwards a session-level plan (live gate/phase checklist) to Linear.
  // Optional so tests and older callers that never emit plans compile
  // unchanged; a plan event with no handler is dropped, not retried forever.
  postSessionUpdate?: (params: {
    sessionId: string;
    issueId: string;
    plan: RuntimePlanItem[];
    eventId: string;
  }) => Promise<unknown>;
  // Best-effort read-back of a rotating agent credential (Codex refresh token)
  // from the sandbox after a stage completes. Failures are logged and ignored.
  captureAgentAuth?: (sandbox: RuntimeWorkspace, ticket: Ticket) => Promise<void>;
  postStageResult?: (event: SandboxStageResultEvent, observedSubject: string) => Promise<unknown>;
}

interface ProgressEventTarget {
  sessionId: string;
  issueId: string;
  superseded: boolean;
}

function resolveProgressEventTarget(
  params: SandboxEventPollerParams,
  ticket: Ticket,
  event: SandboxActivityEvent | SandboxPlanEvent
): ProgressEventTarget {
  const run = params.store.getRun(event.run_id);
  const sessionId = run?.linear_session_id ?? ticket.linear_session_id;
  const issueId = run?.linear_issue_id ?? ticket.linear_issue_id;
  if (!run?.linear_session_id || run.linear_session_id === ticket.linear_session_id) {
    return { sessionId, issueId, superseded: false };
  }
  return {
    sessionId,
    issueId,
    superseded: params.store.getSession(run.linear_session_id)?.state === "superseded",
  };
}

async function pollTicketEvents(
  params: SandboxEventPollerParams,
  ticket: Ticket
): Promise<void> {
  if (!ticket.sandbox_id || !ticket.run_id) return;
  let sandbox: RuntimeWorkspace;
  let files;
  try {
    sandbox = await params.runtime.getWorkspace(ticket.sandbox_id);
    if (sandbox.state !== "started") await sandbox.start?.(60);
    await params.runtime.setActive(ticket.sandbox_id);
    if (params.store.getByIssueId(ticket.linear_issue_id)?.run_id !== ticket.run_id) {
      await reconcileSandboxAutostop({
        runtime: params.runtime,
        store: params.store,
        issueId: ticket.linear_issue_id,
        providerResourceId: ticket.sandbox_id,
      });
      return;
    }
    files = await listEventFiles(sandbox);
  } catch (error) {
    console.error(`[sandbox-events] could not inspect ${ticket.linear_issue_identifier}:`, error);
    return;
  }

  for (const file of files) {
    const remotePath = file.remotePath;
    const eventLimit = file.sealedStageResult ? MAX_STAGE_EVENT_BYTES : MAX_EVENT_BYTES;
    if (file.size > eventLimit) {
      console.error(`[sandbox-events] deleting oversized event ${file.name}`);
      await sandbox.fs.deleteFile!(remotePath).catch(() => undefined);
      continue;
    }

    let event: SandboxEvent;
    try {
      const raw = (file.prefetched ?? await sandbox.fs.downloadFile!(remotePath))!.toString("utf8");
      event = parseSandboxEvent(raw);
    } catch (error) {
      console.error(`[sandbox-events] deleting invalid event ${file.name}:`, error);
      await sandbox.fs.deleteFile!(remotePath).catch(() => undefined);
      continue;
    }

    if (
      (event.kind === "heartbeat" && !file.sealedHeartbeat) ||
      (event.kind !== "heartbeat" && file.sealedHeartbeat) ||
      (event.kind === "stage_result" && !file.sealedStageResult) ||
      (event.kind !== "stage_result" && file.sealedStageResult)
    ) {
      console.error(`[sandbox-events] deleting event with invalid trust origin ${file.name}`);
      await sandbox.fs.deleteFile!(remotePath).catch(() => undefined);
      continue;
    }

    if (event.run_id !== ticket.run_id) {
      console.warn(`[sandbox-events] deleting stale event ${event.event_id} for ${event.run_id}`);
      await sandbox.fs.deleteFile!(remotePath).catch(() => undefined);
      continue;
    }

    const existing = params.store.insertSandboxEvent({
      eventId: event.event_id,
      runId: event.run_id,
      sandboxId: ticket.sandbox_id,
      kind: event.kind,
      payload: JSON.stringify(
        event.kind === "stage_result"
          ? {
              version: event.version,
              kind: event.kind,
              event_id: event.event_id,
              run_id: event.run_id,
              pipeline_instance_id: event.pipeline_instance_id,
              attempt_id: event.attempt_id,
              request_hash: event.request_hash,
              result_hash: event.result_hash,
            }
          : event.kind === "activity"
          ? {
              ...event,
              body: sanitizeText(event.body),
              ...(event.action ? { action: sanitizeText(event.action) } : {}),
              ...(event.parameter ? { parameter: sanitizeText(event.parameter) } : {}),
              ...(event.result ? { result: sanitizeText(event.result) } : {}),
            }
          : event.kind === "plan"
            ? { ...event, plan: sanitizePlan(event.plan) }
            : event
      ),
    });
    if (
      existing.run_id !== event.run_id ||
      existing.sandbox_id !== ticket.sandbox_id ||
      existing.kind !== event.kind
    ) {
      console.error(`[sandbox-events] deleting conflicting event id ${event.event_id}`);
      await sandbox.fs.deleteFile!(remotePath).catch(() => undefined);
      continue;
    }
    if (existing.status === "processed") {
      await sandbox.fs.deleteFile!(remotePath).catch(() => undefined);
      continue;
    }

    const now = new Date();
    const claimed = params.store.claimSandboxEvent(
      event.event_id,
      now.toISOString(),
      new Date(now.getTime() + 30_000).toISOString()
    );
    if (!claimed) break;

    try {
      if (event.kind === "heartbeat") {
        // Supervisor receipt time is authoritative; a skewed sandbox clock
        // cannot extend a lease into the future.
        if (!params.store.renewRunLiveness(event.run_id, new Date().toISOString())) {
          throw new Error(`heartbeat rejected for inactive run ${event.run_id}`);
        }
      } else if (event.kind === "activity") {
        const target = resolveProgressEventTarget(params, ticket, event);
        if (target.superseded) {
          await sandbox.fs.deleteFile!(remotePath).catch(() => undefined);
          params.store.markSandboxEventProcessed(event.event_id);
          continue;
        }
        await params.postActivity(toProgressActivity(event, target.sessionId), {
          ...event,
          issueId: target.issueId,
        });
      } else if (event.kind === "plan") {
        const target = resolveProgressEventTarget(params, ticket, event);
        if (target.superseded) {
          await sandbox.fs.deleteFile!(remotePath).catch(() => undefined);
          params.store.markSandboxEventProcessed(event.event_id);
          continue;
        }
        // A plan event with no wired handler is simply dropped below (marked
        // processed), never retried forever.
        if (params.postSessionUpdate) {
          await params.postSessionUpdate({
            sessionId: target.sessionId,
            issueId: target.issueId,
            plan: sanitizePlan(event.plan),
            eventId: event.event_id,
          });
        }
      } else if (event.kind === "stage_result") {
        if (!params.postStageResult) throw new Error("sealed stage result handler is not configured");
        try {
          await params.captureAgentAuth?.(sandbox, ticket);
        } catch (error) {
          console.warn("[sandbox-events] agent auth capture failed:", sanitizeText(String(error)).slice(-2_000));
        }
        await params.postStageResult(event, await readWorkspaceSubject(sandbox));
      }
      params.store.markSandboxEventProcessed(event.event_id);
    } catch (error) {
      const message = sanitizeText(String(error)).slice(-2_000);
      params.store.markSandboxEventFailed(
        event.event_id,
        message,
        new Date(Date.now() + 5_000).toISOString()
      );
      const failed = params.store.getSandboxEvent(event.event_id);
      if (
        event.kind === "stage_result" &&
        failed &&
        failed.attempts >= INGESTION_DIAGNOSTIC_ATTEMPTS &&
        !failed.ingestion_diagnosed_at
      ) {
        try {
          await params.postActivity({
            id: `sandbox-ingestion-diagnostic:${event.event_id}`,
            sessionId: ticket.linear_session_id,
            type: "error",
            body: `The supervisor cannot ingest the stage result: ${message}. It will keep retrying.`,
          }, {
            version: 1,
            kind: "activity",
            event_id: event.event_id,
            run_id: event.run_id,
            created_at: event.created_at,
            type: "error",
            body: message,
            issueId: ticket.linear_issue_id,
          });
          params.store.markSandboxEventDiagnosed(event.event_id, new Date().toISOString());
        } catch (activityError) {
          console.error(
            `[sandbox-events] failed to publish ingestion diagnostic for ${event.event_id}:`,
            sanitizeText(String(activityError)).slice(-2_000)
          );
        }
      }
      console.error(`[sandbox-events] event ${event.event_id} failed:`, message);
      break;
    }
    await sandbox.fs.deleteFile!(remotePath).catch((error) =>
      console.warn(`[sandbox-events] processed ${event.event_id} but could not delete its file:`, error)
    );
  }
}

export async function pollSandboxEvents(params: SandboxEventPollerParams): Promise<void> {
  await Promise.all(
    params.store.listRunning().map((ticket) => pollTicketEvents(params, ticket))
  );
}
