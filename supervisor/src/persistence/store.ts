import type Database from "better-sqlite3";
import { createAdmissionStore, type AdmissionStore } from "./admission-store.js";
import {
  createDeliveryStore,
  type DeliveryStore,
} from "./delivery-store.js";
import {
  createFeedbackStore,
  type FeedbackRecordParams,
  type FeedbackSnapshot,
  type FeedbackSnapshotEvent,
} from "./feedback-store.js";
import { createRunStore, type RunStore } from "./run-store.js";
import { createSettingsStore, type SettingsStore } from "./settings-store.js";
import { createSteeringStore, type SteeringStore } from "./steering-store.js";
import { createWorkStore } from "./work-store.js";
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
  actor_state: "running" | "reaping" | "quarantined" | "settled" | null;
  last_heartbeat_at: string | null;
  settlement_owner: string | null;
  settlement_reason: string | null;
  termination_confirmed_at: string | null;
  quarantine_reason: string | null;
  actor_created_at: string | null;
  actor_updated_at: string | null;
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

export interface FinishRunParams {
  runId: string;
  status: TerminalRunStatus;
  exitCode?: number;
  costUsd?: number;
  prUrl?: string;
  failureTail?: string;
  ticketFailureTail?: string | null;
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
    | { status: "stale"; snapshot?: FeedbackSnapshot; eventCount?: number };
  carryForwardFeedbackSnapshot(snapshotId: string, headSha: string, workItemId: string): FeedbackSnapshot | undefined;
  markFeedbackSnapshotStaleWithNotice(params: {
    snapshotId: string;
    noticeId: string;
    payload: string;
  }): boolean;
  consumeFeedbackSnapshot(snapshotId: string): boolean;
}

export type SupervisorStore =
  AdmissionStore &
  RunStore &
  DeliveryStore &
  SteeringStore &
  SettingsStore &
  FeedbackCapability;

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
  const settingsStore = createSettingsStore(db);
  const deliveryStore = createDeliveryStore(db);
  const feedbackStore = createFeedbackStore(db, (issueId) =>
    settingsStore.getSetting(`github-head:${issueId}`)
  );
  const markFeedbackSnapshotStaleWithNotice = db.transaction((params: {
    snapshotId: string;
    noticeId: string;
    payload: string;
  }): boolean => {
    const snapshot = db.prepare("SELECT * FROM feedback_snapshots WHERE id = ?")
      .get(params.snapshotId) as FeedbackSnapshot | undefined;
    if (!snapshot) return false;
    const update = db.prepare(`
      UPDATE feedback_snapshots
      SET status = 'stale'
      WHERE id = ? AND status IN ('collecting', 'claimed', 'stale')
    `).run(params.snapshotId);
    if (update.changes !== 1) return false;
    deliveryStore.enqueueLinearOutbox({
      id: params.noticeId,
      linearSessionId: snapshot.linear_session_id,
      issueId: snapshot.linear_issue_id,
      kind: "activity",
      payload: params.payload,
    });
    return true;
  });
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
      return feedbackStore.claimWithEvents(snapshotId, maxRounds);
    },
    carryForwardFeedbackSnapshot(snapshotId, headSha, workItemId) {
      return feedbackStore.carryForward(snapshotId, headSha, workItemId);
    },
    markFeedbackSnapshotStaleWithNotice(params) {
      return markFeedbackSnapshotStaleWithNotice.immediate(params);
    },
    consumeFeedbackSnapshot(snapshotId) {
      return feedbackStore.consume(snapshotId);
    },
  };
  return {
    ...createAdmissionStore(db, pipelineAdmission),
    ...createRunStore(db, workStore),
    ...deliveryStore,
    ...createSteeringStore(db, workStore),
    ...settingsStore,
    ...feedbackCapability,
  };
}
