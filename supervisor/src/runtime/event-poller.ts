import type {
  RuntimeWorkspace,
  RuntimeWorkspaceAccess,
  SandboxAutostopRuntime,
} from "./contracts.js";
import type { Ticket, SupervisorStore } from "../persistence/store.js";
import type { ChildActionLivenessPort } from "../pipeline/store.js";
import { reconcileSandboxAutostop } from "./lifecycle.js";
import { serializeRuntimeObservationError } from "./observation-error.js";
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
import { SEALED_STAGE_RESULT_LIMIT_BYTES } from "../pipeline/evidence-limits.js";

const OUTBOX_DIR = "/home/agent/.ot/outbox";
const LOOP_ACTION_DIR = "/var/lib/openthrottle/loop-actions";
const SEALED_HEARTBEAT_FILE = "/var/lib/openthrottle/heartbeat/heartbeat.json";
const SEALED_STAGE_RESULT_DIR = "/var/lib/openthrottle/stage-results";
const WORKSPACE_SUBJECT_COMMAND = "node /opt/openthrottle/runner/execute-stage.mjs --print-subject --repo /home/agent/repo";
const MAX_EVENT_BYTES = 32 * 1024;
const INGESTION_DIAGNOSTIC_ATTEMPTS = 5;
const CHILD_ACTION_HEARTBEAT_LEASE_MS = 60_000;

interface SandboxEventFile {
  name: string;
  remotePath: string;
  size: number;
  sealedHeartbeat: boolean;
  sealedStageResult: boolean;
  prefetched?: Buffer;
}

function safeRemoteName(name: string | undefined): string | null {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name) ? name : null;
}

async function listActivityEventFiles(
  sandbox: RuntimeWorkspace,
  directory: string,
  options: { optional?: boolean } = {}
): Promise<SandboxEventFile[]> {
  let files;
  try {
    files = await sandbox.fs.listFiles!(directory);
  } catch (error) {
    const observed = serializeRuntimeObservationError(`list activity events ${directory}`, error);
    if (observed.retryable) throw new Error(observed.text);
    if (options.optional) return [];
    throw error;
  }
  return files
    .filter((file) => !file.isDir && typeof file.name === "string" && /^[A-Za-z0-9._-]+\.json$/.test(file.name))
    .map((file) => ({
      name: file.name!,
      remotePath: `${directory}/${file.name}`,
      size: file.size,
      sealedHeartbeat: false,
      sealedStageResult: false,
    }));
}

async function listLoopActionOutboxFiles(sandbox: RuntimeWorkspace): Promise<SandboxEventFile[]> {
  const attempts = await sandbox.fs.listFiles!(LOOP_ACTION_DIR).catch((error) => {
    const observed = serializeRuntimeObservationError(`list loop action attempts ${LOOP_ACTION_DIR}`, error);
    if (observed.retryable) throw new Error(observed.text);
    return [];
  });
  const events: SandboxEventFile[] = [];
  for (const attempt of attempts) {
    const attemptName = safeRemoteName(attempt.name);
    if (!attempt.isDir || !attemptName) continue;
    const attemptPath = `${LOOP_ACTION_DIR}/${attemptName}`;
    const actions = await sandbox.fs.listFiles!(attemptPath).catch((error) => {
      const observed = serializeRuntimeObservationError(`list loop actions ${attemptPath}`, error);
      if (observed.retryable) throw new Error(observed.text);
      return [];
    });
    for (const action of actions) {
      const actionName = safeRemoteName(action.name);
      if (!action.isDir || !actionName) continue;
      const outboxDir = `${attemptPath}/${actionName}/outbox`;
      const actionEvents = await listActivityEventFiles(sandbox, outboxDir, { optional: true });
      events.push(...actionEvents.map((event) => ({
        ...event,
        name: `050-loop-${attemptName}-${actionName}-${event.name}`,
      })));
    }
  }
  return events;
}

async function listEventFiles(sandbox: RuntimeWorkspace): Promise<SandboxEventFile[]> {
  const events: SandboxEventFile[] = [
    ...(await listActivityEventFiles(sandbox, OUTBOX_DIR)),
    ...(await listLoopActionOutboxFiles(sandbox)),
  ];
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
  } catch (error) {
    const observed = serializeRuntimeObservationError(`read sealed heartbeat ${SEALED_HEARTBEAT_FILE}`, error);
    if (observed.retryable) throw new Error(observed.text);
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
  } catch (error) {
    const observed = serializeRuntimeObservationError(`list sealed stage results ${SEALED_STAGE_RESULT_DIR}`, error);
    if (observed.retryable) throw new Error(observed.text);
    // No sealed stage result has landed yet.
  }
  return events.sort((left, right) => left.name.localeCompare(right.name));
}

function sandboxEventPayload(event: SandboxEvent): unknown {
  if (event.kind === "stage_result") {
    return {
      version: event.version,
      kind: event.kind,
      event_id: event.event_id,
      run_id: event.run_id,
      pipeline_instance_id: event.pipeline_instance_id,
      attempt_id: event.attempt_id,
      request_hash: event.request_hash,
      result_hash: event.result_hash,
    };
  }
  if (event.kind === "activity") {
    return {
      ...event,
      body: sanitizeText(event.body),
      ...(event.action ? { action: sanitizeText(event.action) } : {}),
      ...(event.parameter ? { parameter: sanitizeText(event.parameter) } : {}),
      ...(event.result ? { result: sanitizeText(event.result) } : {}),
    };
  }
  if (event.kind === "plan") {
    return { ...event, plan: sanitizePlan(event.plan) };
  }
  return event;
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
  postStageResult?: (event: SandboxStageResultEvent, observedSubject: string) => Promise<unknown>;
  childActions?: ChildActionLivenessPort;
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
  const sessionId = run?.session_id ?? ticket.session_id;
  const issueId = run?.ticket_id ?? ticket.ticket_id;
  if (!run?.session_id || run.session_id === ticket.session_id) {
    return { sessionId, issueId, superseded: false };
  }
  return {
    sessionId,
    issueId,
    superseded: params.store.getSession(run.session_id)?.state === "superseded",
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
    if (params.store.getByIssueId(ticket.ticket_id)?.run_id !== ticket.run_id) {
      await reconcileSandboxAutostop({
        runtime: params.runtime,
        store: params.store,
        issueId: ticket.ticket_id,
        providerResourceId: ticket.sandbox_id,
      });
      return;
    }
    files = await listEventFiles(sandbox);
  } catch (error) {
    const observed = serializeRuntimeObservationError(`poll sandbox events ${ticket.ticket_reference}`, error);
    console.error(`[sandbox-events] could not inspect ${ticket.ticket_reference}: ${observed.text}`);
    return;
  }

  for (const file of files) {
    const remotePath = file.remotePath;
    const eventLimit = file.sealedStageResult ? SEALED_STAGE_RESULT_LIMIT_BYTES : MAX_EVENT_BYTES;
    if (file.size > eventLimit) {
      console.error(`[sandbox-events] deleting oversized event ${file.name}`);
      await sandbox.fs.deleteFile!(remotePath).catch(() => undefined);
      continue;
    }

    let raw: string;
    try {
      raw = (file.prefetched ?? await sandbox.fs.downloadFile!(remotePath))!.toString("utf8");
    } catch (error) {
      const observed = serializeRuntimeObservationError(`download sandbox event ${remotePath}`, error);
      // A provider exception says nothing about the bytes on disk, even when
      // its classification is unknown or non-retryable. Preserve the file and
      // the sorted processing fence so a later poll can observe it again.
      console.error(`[sandbox-events] could not read ${file.name}: ${observed.text}`);
      break;
    }

    let event: SandboxEvent;
    try {
      event = parseSandboxEvent(raw);
    } catch (error) {
      // Once bytes have been downloaded, malformed event content is
      // deterministic. Do not classify parser text (which may itself contain
      // words such as "timeout") as a transient provider failure.
      const message = sanitizeText(error instanceof Error ? error.message : String(error)).slice(-2_000);
      console.error(`[sandbox-events] deleting invalid event ${file.name}: ${message}`);
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
      payload: JSON.stringify(sandboxEventPayload(event)),
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
        const heartbeatAt = new Date();
        if (!params.store.renewRunLiveness(event.run_id, heartbeatAt.toISOString())) {
          throw new Error(`heartbeat rejected for inactive run ${event.run_id}`);
        }
        if (event.child_action_id && params.childActions) {
          const renewed = params.childActions.renewChildActionLiveness({
            parentRunId: event.run_id,
            actionId: event.child_action_id,
            heartbeatAtIso: heartbeatAt.toISOString(),
            leaseUntilIso: new Date(heartbeatAt.getTime() + CHILD_ACTION_HEARTBEAT_LEASE_MS).toISOString(),
          });
          if (!renewed) {
            console.warn(`[sandbox-events] child heartbeat ignored for inactive action ${event.child_action_id}`);
          }
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
            sessionId: ticket.session_id,
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
            issueId: ticket.ticket_id,
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
