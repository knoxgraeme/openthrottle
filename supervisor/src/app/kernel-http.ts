import {
  digestCanonicalJson,
  type JsonValue,
  type PipelineTerminalOutcome,
} from "@openthrottle/contracts";
import type {
  KernelHistoricalAnalysisPort,
  KernelHistoricalRecordMetadata,
  KernelHistoricalRun,
  KernelHistoricalRunQuery,
} from "../persistence/kernel-analysis-store.js";
import type {
  KernelIngressResponse,
  KernelActiveWorkReport,
} from "./kernel-control.js";
import type {
  KernelInboxEventInput,
  KernelMaintenanceFence,
} from "../persistence/kernel-inbox-store.js";
import type {
  KernelLogCursor,
  KernelLogPage,
  KernelProjectionPort,
  KernelStatusProjection,
} from "../persistence/kernel-projection-store.js";
import type {
  KernelRepositoryRegistration,
  KernelRepositoryRegistrationInput,
  KernelRepositoryRegistrationPort,
} from "../persistence/kernel-registration-store.js";
import { sanitizeText } from "../shared/sanitize.js";

export class KernelHttpNotFoundError extends Error {
  constructor(reference: string) {
    super(`pipeline run or source reference ${reference} was not found`);
    this.name = "KernelHttpNotFoundError";
  }
}

export class KernelHttpConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelHttpConflictError";
  }
}

export interface KernelHttpControlPort {
  ingestMutation(input: KernelInboxEventInput): KernelIngressResponse;
  closeMutatingIngress(expectedVersion?: number): KernelMaintenanceFence;
  openMutatingIngress(expectedVersion?: number): KernelMaintenanceFence;
  maintenanceState(): KernelMaintenanceFence;
  activeWorkReport(input?: { limit?: number }): Promise<KernelActiveWorkReport>;
}

export interface KernelRepositorySetupInput {
  repo: string;
  controlProvider: "linear" | "github";
  linearTeamKey?: string;
  linearTeamId?: string;
  baseBranch?: string;
}

export interface KernelRepositorySetupResult {
  registration: KernelRepositoryRegistrationInput;
  readiness: {
    github: "ready";
    webhook: "created" | "updated" | "unchanged";
    snapshot: { name: string; state: string };
    controlLabel?: string;
  };
}

export interface KernelRepositorySetupPort {
  prepare(input: KernelRepositorySetupInput): Promise<KernelRepositorySetupResult>;
}

export interface KernelProviderWebhookInput {
  provider: "linear" | "github";
  delivery_id: string;
  kind: string;
  event_group_key: string;
  delivery_attempt: number;
  route:
    | { github_repo: string; linear_team_id?: never; linear_team_key?: never }
    | { github_repo?: never; linear_team_id?: string; linear_team_key?: string };
  work_item_id?: string;
  pipeline_run_id?: string;
  attempt_id?: string;
  generation?: number;
  subject?: string;
  payload_schema: string;
  payload: JsonValue;
}

export type KernelProviderWebhookResponse = KernelIngressResponse | {
  accepted: false;
  acknowledge: true;
  retryable: false;
  ignored: "unregistered_route";
};

export interface KernelRunLogResponse extends KernelLogPage {
  pipeline_run_id: string;
}

export interface KernelRunAnalysisResponse {
  pipeline_run_id: string;
  records: readonly KernelHistoricalRecordMetadata[];
}

export interface KernelRunControlResponse {
  accepted: boolean;
  acknowledge: boolean;
  retryable: boolean;
  action: "stop" | "supersede";
  pipeline_run_id: string;
  inbox_event_id?: string;
  duplicate?: boolean;
  status_code?: number;
  retry_after_seconds?: number;
  reason?: string;
}

function boundedReason(reason: string | undefined): string {
  const value = sanitizeText(reason ?? "operator request").trim();
  if (value.length < 1 || value.length > 1_500) {
    throw new Error("control reason must contain between 1 and 1500 characters");
  }
  return value;
}

export class KernelHttpService {
  readonly #registrations: KernelRepositoryRegistrationPort;
  readonly #projections: KernelProjectionPort;
  readonly #analysis: KernelHistoricalAnalysisPort;
  readonly #control: KernelHttpControlPort;

  constructor(input: {
    registrations: KernelRepositoryRegistrationPort;
    projections: KernelProjectionPort;
    analysis: KernelHistoricalAnalysisPort;
    control: KernelHttpControlPort;
  }) {
    this.#registrations = input.registrations;
    this.#projections = input.projections;
    this.#analysis = input.analysis;
    this.#control = input.control;
  }

  status(reference: string, detailLimit?: number): KernelStatusProjection {
    const run = this.#run(reference);
    const status = this.#projections.getStatus(run.pipeline_run_id, detailLimit);
    if (!status) throw new KernelHttpNotFoundError(reference);
    return status;
  }

  logs(input: {
    reference: string;
    after?: KernelLogCursor;
    limit?: number;
  }): KernelRunLogResponse {
    const run = this.#run(input.reference);
    return {
      pipeline_run_id: run.pipeline_run_id,
      ...this.#projections.listLog({
        pipeline_run_id: run.pipeline_run_id,
        ...(input.after ? { after: input.after } : {}),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
    };
  }

  analysis(query: KernelHistoricalRunQuery = {}): readonly KernelHistoricalRun[] {
    return this.#analysis.listSettledRuns(query);
  }

  runAnalysis(input: {
    reference: string;
    kind?: "result" | "decision" | "delivery";
    limit?: number;
  }): KernelRunAnalysisResponse {
    const run = this.#run(input.reference);
    return {
      pipeline_run_id: run.pipeline_run_id,
      records: this.#analysis.listSettledRecordMetadata({
        pipeline_run_id: run.pipeline_run_id,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
    };
  }

  requestRunControl(input: {
    reference: string;
    action: "stop" | "supersede";
    reason?: string;
  }): KernelRunControlResponse {
    if (input.action !== "stop" && input.action !== "supersede") {
      throw new Error("run control action must be stop or supersede");
    }
    const run = this.#run(input.reference);
    const status = this.#projections.getStatus(run.pipeline_run_id);
    if (!status) throw new KernelHttpNotFoundError(input.reference);
    if (status.status !== "pending" && status.status !== "running") {
      throw new KernelHttpConflictError(`pipeline run ${run.pipeline_run_id} is already ${status.status}`);
    }
    const reason = boundedReason(input.reason);
    const identity = {
      schema: "openthrottle.operator-control/v1",
      pipeline_run_id: run.pipeline_run_id,
      action: input.action,
      cursor_version: status.cursor_version,
      reason,
    } as const;
    const result = this.#control.ingestMutation({
      source_provider: "operator",
      delivery_id: `operator-${digestCanonicalJson(identity)}`,
      kind: `control/${input.action}@1`,
      work_item_id: run.work_item_id,
      pipeline_run_id: run.pipeline_run_id,
      generation: status.cursor_version,
      event_group_key: `control:${run.pipeline_run_id}:${input.action}:${status.cursor_version}`,
      delivery_attempt: 1,
      subject: status.current_subject,
      payload_schema: identity.schema,
      payload: identity,
    });
    if (!result.accepted) {
      return {
        ...result,
        action: input.action,
        pipeline_run_id: run.pipeline_run_id,
      };
    }
    return {
      accepted: true,
      acknowledge: true,
      retryable: false,
      action: input.action,
      pipeline_run_id: run.pipeline_run_id,
      inbox_event_id: result.event.id,
      duplicate: result.duplicate,
    };
  }

  ingestProviderWebhook(input: KernelProviderWebhookInput): KernelProviderWebhookResponse {
    if (this.#control.maintenanceState().closed) {
      return {
        accepted: false,
        acknowledge: false,
        retryable: true,
        status_code: 503,
        retry_after_seconds: 30,
        reason: "maintenance",
      };
    }
    const registration = input.provider === "github"
      ? this.#registrations.findGithubRoute(input.route.github_repo ?? "")
      : this.#registrations.findLinearRoute({
        ...(input.route.linear_team_id === undefined
          ? {}
          : { team_id: input.route.linear_team_id }),
        ...(input.route.linear_team_key === undefined
          ? {}
          : { team_key: input.route.linear_team_key }),
      });
    if (!registration) {
      return {
        accepted: false,
        acknowledge: true,
        retryable: false,
        ignored: "unregistered_route",
      };
    }
    return this.#control.ingestMutation({
      source_provider: input.provider,
      delivery_id: input.delivery_id,
      kind: input.kind,
      ...(input.work_item_id === undefined ? {} : { work_item_id: input.work_item_id }),
      ...(input.pipeline_run_id === undefined ? {} : { pipeline_run_id: input.pipeline_run_id }),
      ...(input.attempt_id === undefined ? {} : { attempt_id: input.attempt_id }),
      generation: input.generation ?? 0,
      event_group_key: input.event_group_key,
      delivery_attempt: input.delivery_attempt,
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      payload_schema: input.payload_schema,
      payload: input.payload,
    });
  }

  registrations(): readonly KernelRepositoryRegistration[] {
    return this.#registrations.list();
  }

  registerPrepared(input: KernelRepositorySetupResult): {
    disposition: "inserted" | "unchanged" | "updated";
    registration: KernelRepositoryRegistration;
    readiness: KernelRepositorySetupResult["readiness"];
  } {
    const stored = this.#registrations.put(input.registration);
    return { ...stored, readiness: input.readiness };
  }

  maintenanceState(): KernelMaintenanceFence {
    return this.#control.maintenanceState();
  }

  closeMaintenance(expectedVersion?: number): KernelMaintenanceFence {
    return this.#control.closeMutatingIngress(expectedVersion);
  }

  openMaintenance(expectedVersion?: number): KernelMaintenanceFence {
    return this.#control.openMutatingIngress(expectedVersion);
  }

  activeWork(limit?: number): Promise<KernelActiveWorkReport> {
    return this.#control.activeWorkReport(limit === undefined ? {} : { limit });
  }

  #run(reference: string) {
    const run = this.#registrations.resolveRun(reference);
    if (!run) throw new KernelHttpNotFoundError(reference);
    return run;
  }
}

export type KernelAnalysisTerminalOutcome = PipelineTerminalOutcome;
