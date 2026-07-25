import type Database from "better-sqlite3";
import { createAdmissionStore, type AdmissionStore } from "./admission-store.js";
import { createDeliveryStore, type DeliveryStore } from "./delivery-store.js";
import {
  createFeedbackStore,
  type FeedbackRecordParams,
  type FeedbackSnapshot,
  type FeedbackSnapshotEvent,
} from "./feedback-store.js";
import { createRunStore, type RunStore } from "./run-store.js";
import { createSettingsStore, type SettingsStore } from "./settings-store.js";
import { createSteeringStore, type SteeringStore } from "./steering-store.js";
import {
  createWorkStore,
  type WorkDelivery,
  type WorkItem,
} from "./work-store.js";
import type { PipelineInstance, PipelineInstanceSeed } from "../pipeline/store.js";
import type { Agent, TaskType } from "../pipeline/types.js";

export type TicketState = "active" | "closed" | "expired" | "error" | "stopped";
export type TerminalRunStatus = "completed" | "failed" | "timed_out" | "stopped";
export type RunStatus = "running" | "reaping" | "quarantined" | TerminalRunStatus;

export interface Ticket {
  linear_issue_id: string;
  linear_issue_identifier: string;
  linear_session_id: string;
  sandbox_id: string | null;
  branch: string;
  agent: Agent;
  repo: string;
  pr_url: string | null;
  state: TicketState;
  running_since: string | null;
  run_id: string | null;
  total_cost_usd: number;
  last_error: string | null;
  linear_context: string | null;
  base_branch: string;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  linear_issue_id: string;
  linear_session_id: string | null;
  session_generation: number | null;
  task_type: TaskType;
  token_hash: string;
  status: RunStatus;
  started_at: string;
  expires_at: string;
  completed_at: string | null;
  exit_code: number | null;
  cost_usd: number | null;
  pr_url: string | null;
  failure_tail: string | null;
  log_tail: string | null;
}

export interface AgentSession {
  id: string;
  linear_issue_id: string;
  generation: number;
  state: "current" | "stopping" | "stopped" | "superseded";
  provider_conversation_id: string | null;
  created_at: string;
  updated_at: string;
  superseded_at: string | null;
}

export type TicketUpsert = Pick<
  Ticket,
  | "linear_issue_id"
  | "linear_issue_identifier"
  | "linear_session_id"
  | "sandbox_id"
  | "branch"
  | "agent"
  | "repo"
  | "pr_url"
  | "state"
> & {
  base_branch?: string;
  pipeline?: Omit<PipelineInstanceSeed, "issueId" | "sessionId" | "generation" | "branch" | "agent">;
};

export interface RepositoryRegistration {
  linear_team_key: string;
  linear_team_id: string | null;
  github_repo: string;
  base_branch: string;
  webhook_id: number;
  snapshot: string;
  created_at: string;
  updated_at: string;
}

export interface RepositoryRegistrationInput {
  linearTeamKey: string;
  linearTeamId?: string;
  githubRepo: string;
  baseBranch: string;
  webhookId: number;
  snapshot: string;
}

export interface DeliveryClaim {
  deliveryId: string;
  source: "linear" | "github";
  sessionId?: string;
  action: string;
  activityId?: string;
  eventName?: string;
  payload?: string;
}

export interface WebhookDelivery {
  id: string;
  source: "linear" | "github";
  session_id: string | null;
  action: string;
  activity_id: string | null;
  event_name: string | null;
  payload: string | null;
  status: "pending" | "processing" | "failed" | "processed" | "dead";
  attempts: number;
  next_attempt_at: string | null;
  processed_at: string | null;
  last_error: string | null;
  received_at: string;
}

export interface SandboxEventRecord {
  event_id: string;
  run_id: string;
  sandbox_id: string;
  kind: "activity" | "plan" | "heartbeat" | "stage_result";
  payload: string;
  status: "pending" | "processing" | "failed" | "processed";
  attempts: number;
  next_attempt_at: string;
  processed_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface LinearOutboxRecord {
  id: string;
  linear_session_id: string | null;
  linear_issue_id: string | null;
  run_id: string | null;
  sequence: number;
  kind: "activity" | "session_update" | "pipeline_receipt";
  payload: string;
  payload_hash: string;
  status: "pending" | "processing" | "failed" | "processed" | "dead";
  attempts: number;
  next_attempt_at: string;
  processed_at: string | null;
  last_error: string | null;
  external_id: string | null;
  external_url: string | null;
  attachment_url: string | null;
  created_at: string;
}

export interface SteerInboxRecord {
  id: string;
  linear_issue_id: string;
  linear_session_id: string;
  run_id: string | null;
  source: "human" | "operator";
  body: string;
  status: "pending" | "dispatched" | "acknowledged" | "canceled";
  created_at: string | null;
  delivered_at: string | null;
  delivery_id: string | null;
  request_hash: string | null;
  generation: number | null;
  context_revision: number | null;
  native_session_id: string | null;
  lease_until: string | null;
}

export interface FinishRunParams {
  runId: string;
  status: TerminalRunStatus;
  exitCode?: number;
  costUsd?: number;
  prUrl?: string;
  failureTail?: string;
  logTail?: string;
  ticketState?: TicketState;
}

export interface FeedbackCapability {
  recordProviderFeedback(params: FeedbackRecordParams): {
    snapshot: FeedbackSnapshot;
    eventInserted: boolean;
    snapshotCreated: boolean;
  };
  listPendingFeedbackSnapshots(linearSessionId: string, limit?: number): FeedbackSnapshot[];
  claimFeedbackSnapshot(snapshotId: string, maxRounds: number):
    | { status: "claimed"; snapshot: FeedbackSnapshot; events: FeedbackSnapshotEvent[] }
    | { status: "exhausted"; completedRounds: number }
    | { status: "stale" };
  consumeFeedbackSnapshot(snapshotId: string): boolean;
}

export interface WorkCapability {
  getWorkItem(id: string): WorkItem | undefined;
  getWorkDelivery(id: string): WorkDelivery | undefined;
}

export type SupervisorStore =
  AdmissionStore &
  RunStore &
  DeliveryStore &
  SteeringStore &
  SettingsStore &
  FeedbackCapability &
  WorkCapability;

export interface PipelineAdmissionCapability {
  createInstance(seed: PipelineInstanceSeed): PipelineInstance;
  supersedeOtherInstances(issueId: string, currentSessionId: string): void;
}

export function createNoopPipelineAdmission(): PipelineAdmissionCapability {
  return {
    supersedeOtherInstances() {},
    createInstance() {
      throw new Error("pipeline admission capability is not configured");
    },
  };
}

export function createSupervisorStore(
  db: Database.Database,
  pipelineAdmission: PipelineAdmissionCapability = createNoopPipelineAdmission()
): SupervisorStore {
  const workStore = createWorkStore(db);
  const feedbackStore = createFeedbackStore(db);
  const feedbackCapability: FeedbackCapability = {
    recordProviderFeedback(params) {
      return feedbackStore.record(params);
    },
    listPendingFeedbackSnapshots(linearSessionId, limit = 50) {
      return db.prepare(`
        SELECT * FROM feedback_snapshots
        WHERE linear_session_id = ? AND status IN ('collecting', 'claimed')
        ORDER BY created_at, id LIMIT ?
      `).all(linearSessionId, limit) as FeedbackSnapshot[];
    },
    claimFeedbackSnapshot(snapshotId, maxRounds) {
      const snapshot = feedbackStore.get(snapshotId);
      if (!snapshot) return { status: "stale" as const };
      const events = feedbackStore.listEvents(snapshot.id);
      const isConversationSnapshot = events.length > 0 &&
        events.every((event) => event.kind === "issue_comment");
      const currentHead = (db.prepare("SELECT value FROM settings WHERE key = ?").get(
        `github-head:${snapshot.linear_issue_id}`
      ) as { value: string } | undefined)?.value;
      if (!isConversationSnapshot && currentHead && currentHead !== snapshot.head_sha) {
        db.prepare(`
          UPDATE feedback_snapshots SET status = 'stale'
          WHERE id = ? AND status IN ('collecting', 'claimed')
        `).run(snapshot.id);
        return { status: "stale" as const };
      }
      const claim = feedbackStore.claim(snapshot.id, maxRounds);
      return claim.status === "claimed" ? { ...claim, events } : claim;
    },
    consumeFeedbackSnapshot(snapshotId) {
      return feedbackStore.consume(snapshotId);
    },
  };
  return {
    ...createAdmissionStore(db, pipelineAdmission),
    ...createRunStore(db, workStore),
    ...createDeliveryStore(db),
    ...createSteeringStore(db, workStore),
    ...createSettingsStore(db),
    ...feedbackCapability,
    getWorkItem(id) {
      return workStore.get(id);
    },
    getWorkDelivery(id) {
      return workStore.getDelivery(id);
    },
  };
}
