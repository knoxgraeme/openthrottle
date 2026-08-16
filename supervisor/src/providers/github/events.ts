// GitHub feedback is committed as typed provider evidence for the generation-
// pinned pipeline. There is no automatic task-resume fallback.

import { randomUUID } from "node:crypto";
import type { Config } from "../../app/config.js";
import type { SupervisorStore } from "../../persistence/store.js";
import {
  GITHUB_CONTROL_LABEL,
  compareGithubIssueActivationAndComment,
  getFailingGithubCheckDetails,
  fetchGithubIssueContext,
  fetchGithubIssueControlEvents,
  fetchGithubPullRequestHeadSha,
  fetchGithubPullRequestReviewComments,
  fetchGithubIssueLifecycle,
  getRepositoryCollaboratorPermission,
  githubIssueHasExactControlLabel,
  githubIssueControlEvent,
  githubIssuesEventCarriesExactControlLabel,
  classifyGithubIssueComment,
  isAuthorizedGithubControlPermission,
  isOpenthrottleBranch,
  type GithubIssueControlEventRecord,
  type GithubWebhookEvent,
} from "./client.js";
import type { ActivityPublicationPort } from "../../app/ports.js";
import type { PipelineStore } from "../../pipeline/store.js";
import { processProviderEvidence } from "../../pipeline/gates.js";
import { requestPipelineStop } from "../../pipeline/control.js";
import {
  acknowledgedPublicationHeadAt,
  pipelineIsTerminal,
  processPipelineFeedbackSnapshot,
  providerStageCanReceive,
  recordPipelineProviderEvent,
  type PipelineProviderOutcome,
} from "../../app/provider-feedback.js";
import { sanitizeText } from "../../shared/sanitize.js";
import { handleControlEvent, type PipelineCoordinatorContext, type SessionServicePorts } from "../../app/session-service.js";
import type { AdmissionPreflight } from "../../app/admission-preflight.js";
import { githubSupervisorCommentWriteIsPending } from "./comment-provenance.js";

type ProviderFinding = {
  severity: "P0" | "P1" | "P2" | "P3";
  code: string;
  summary: string;
};

const GITHUB_COMMENT_ORDERING_GUIDANCE =
  "OpenThrottle could not prove whether this same-second GitHub Issue comment followed the activation. " +
  "Please resend the comment after the activation is visible so it can be routed safely.";
const GITHUB_PR_COMMENT_ORDERING_GUIDANCE =
  "OpenThrottle could not prove which pull-request head this comment reviewed. " +
  "The comment was retained as stale evidence instead of being applied to another revision; " +
  "please resend it on the current PR head.";
const GITHUB_HISTORICAL_ACTOR_PERMISSION_LOOKUP_LIMIT = 32;
const GITHUB_HEAD_LIVE_RECONCILIATION_ATTEMPT_LIMIT = 3;

type GithubHeadObservationProvenance =
  | "provider_event"
  | "provider_projection"
  | "live_reconciliation";
type GithubHeadObservation = {
  headSha: string;
  observedAt: string;
  provenance: GithubHeadObservationProvenance;
};

type GithubHeadEvidenceKind = "head_transition" | "current_projection";
type GithubHeadReconciliationStep =
  | { kind: "done"; headSha: string }
  | { kind: "retry"; projectionRevision: string };

export function routePipelineProviderEvent(params: {
  pipelines: PipelineStore;
  store: SupervisorStore;
  ticket: NonNullable<ReturnType<SupervisorStore["getByIssueId"]>>;
  eventId: string;
  outcome: PipelineProviderOutcome;
  summary: string;
  evidence: string[];
  findings?: ProviderFinding[];
  payload: Record<string, unknown>;
  headSha: string | undefined;
  pullRequestUrl?: string;
  receivedAt?: string;
}): boolean {
  const instance = params.pipelines.getInstanceForSession(params.ticket.session_id);
  if (!instance) return false;
  if (params.pullRequestUrl && params.ticket.pr_url && params.pullRequestUrl !== params.ticket.pr_url) {
    return true;
  }
  const authoritativeHead = params.store.getSetting(`github-head:${params.ticket.ticket_id}`);
  if (pipelineIsTerminal(instance)) {
    const canceledMergeRecovery =
      instance.status === "canceled" &&
      instance.terminal_outcome === "canceled" &&
      params.outcome === "success" &&
      params.payload.kind === "pull_request" &&
      params.payload.action === "closed" &&
      params.payload.merged === true &&
      params.headSha !== undefined &&
      params.headSha === authoritativeHead &&
      params.headSha === instance.published_commit;
    if (!canceledMergeRecovery) return true;
    processProviderEvidence(params.pipelines, {
      id: params.eventId,
      instanceId: instance.id,
      outcome: params.outcome,
      summary: params.summary,
      evidence: params.evidence,
      findings: params.findings,
      providerPayload: {
        ...params.payload,
        expected_published_commit: instance.published_commit,
        observed_head_sha: params.headSha,
      },
    });
    return true;
  }
  if (params.headSha === undefined) return true;
  const canReceive = providerStageCanReceive(params.pipelines, instance);
  const revisionMatches = instance.published_commit !== null && params.headSha === instance.published_commit;
  if (params.outcome === "semantic_repair_required" || !canReceive) {
    const snapshot = recordPipelineProviderEvent({
      store: params.store,
      instance,
      ticket: params.ticket,
      provider: "github",
      eventId: params.eventId,
      outcome: params.outcome,
      summary: params.summary,
      evidence: params.evidence,
      findings: params.findings,
      payload: params.payload,
      headSha: params.headSha,
      pullRequestUrl: params.pullRequestUrl,
      receivedAt: params.receivedAt,
    });
    if (canReceive) {
      processPipelineFeedbackSnapshot({
        pipelines: params.pipelines,
        store: params.store,
        instance,
        snapshot,
        drainSource: "github-webhook",
      });
    }
    return true;
  }
  if (params.headSha !== authoritativeHead) return true;
  if (canReceive && !revisionMatches) {
    processProviderEvidence(params.pipelines, {
      id: params.eventId,
      instanceId: instance.id,
      outcome: "needs_human",
      summary: "GitHub's current pull-request head does not match the executor-verified published commit.",
      evidence: params.evidence,
      findings: params.findings,
      providerPayload: {
        ...params.payload,
        expected_published_commit: instance.published_commit,
        observed_head_sha: params.headSha,
      },
    });
    return true;
  }
  // A synchronize webhook for the exact commit sealed by the publish stage is
  // expected and carries no gate decision. Only drift from that revision (the
  // branch above) is a human-required safety event.
  if (params.outcome === "needs_human") return true;
  if (canReceive) {
    processProviderEvidence(params.pipelines, {
      id: params.eventId,
      instanceId: instance.id,
      outcome: params.outcome,
      summary: params.summary,
      evidence: params.evidence,
      findings: params.findings,
      providerPayload: {
        ...params.payload,
        expected_published_commit: instance.published_commit,
        observed_head_sha: params.headSha,
      },
    });
  }
  return true;
}

function setAuthoritativeGithubHead(
  store: SupervisorStore,
  issueId: string,
  headSha: string,
  providerObservedAt?: string,
  mode: "monotonic" | "force" | "history_only" = "monotonic",
  provenance: GithubHeadObservationProvenance = "provider_event"
): boolean {
  const headKey = `github-head:${issueId}`;
  const sourceKey = `github-head-source:${issueId}`;
  const observedAtKey = `github-head-observed-at:${issueId}`;
  const provenanceKey = `github-head-observed-provenance:${issueId}`;
  const generationKey = `github-head-projection-generation:${issueId}`;
  const observedAt = providerObservedAt ?? new Date().toISOString();
  const observedAtMs = Date.parse(observedAt);
  if (Number.isNaN(observedAtMs)) return false;
  const observationKey =
    `github-head-observation:${issueId}:${observedAt}:${headSha}:${provenance}`;
  const priorHead = store.getSetting(headKey);
  const priorSource = store.getSetting(sourceKey);
  const priorObservedAt = store.getSetting(observedAtKey);
  const rawPriorProvenance = store.getSetting(provenanceKey);
  const priorProvenance: GithubHeadObservationProvenance =
    rawPriorProvenance === "live_reconciliation" || rawPriorProvenance === "provider_projection"
      ? rawPriorProvenance
      : "provider_event";
  const priorObservedAtMs = priorObservedAt ? Date.parse(priorObservedAt) : Number.NaN;
  let promote = mode === "force";
  if (mode === "monotonic") {
    promote = priorSource !== "authoritative" || !priorHead;
    if (priorSource === "authoritative") {
      if (priorHead === headSha) {
        promote = Number.isNaN(priorObservedAtMs) ||
          (priorProvenance !== "provider_event" && provenance === "provider_event");
      } else if (!Number.isNaN(priorObservedAtMs)) {
        promote = observedAtMs > priorObservedAtMs;
      }
    }
  }
  const entries = [{
    key: observationKey,
    value: JSON.stringify({ headSha, observedAt, provenance }),
  }];
  if (priorSource === "authoritative" && !Number.isNaN(priorObservedAtMs) &&
      priorHead === headSha &&
      !(priorProvenance !== "provider_event" && provenance === "provider_event")) {
    // Keep the first durable observation of one head: later reviews/checks on
    // the same revision must not erase when that revision became visible.
    promote = false;
  }
  if (promote && mode !== "history_only") {
    entries.push(
      { key: observedAtKey, value: observedAt },
      { key: provenanceKey, value: provenance },
      { key: headKey, value: headSha },
      { key: sourceKey, value: "authoritative" },
      { key: generationKey, value: randomUUID() }
    );
  }
  // The observation, four-field current projection, and opaque generation
  // commit together, so restart and ABA races cannot hide a promotion.
  store.setSettings(entries);
  return priorHead === headSha || (promote && mode !== "history_only");
}

function currentGithubHeadObservation(
  store: SupervisorStore,
  issueId: string
): GithubHeadObservation | undefined {
  if (store.getSetting(`github-head-source:${issueId}`) !== "authoritative") return undefined;
  const head = githubCommitSha(store.getSetting(`github-head:${issueId}`));
  const headObservedAt = store.getSetting(`github-head-observed-at:${issueId}`);
  const rawProvenance = store.getSetting(`github-head-observed-provenance:${issueId}`);
  const provenance: GithubHeadObservationProvenance =
    rawProvenance === "live_reconciliation" || rawProvenance === "provider_projection"
      ? rawProvenance
      : "provider_event";
  const headObservedAtMs = headObservedAt ? Date.parse(headObservedAt) : Number.NaN;
  return head && headObservedAt && !Number.isNaN(headObservedAtMs)
    ? { headSha: head, observedAt: headObservedAt, provenance }
    : undefined;
}

function providerTimestampedGithubHeads(
  store: SupervisorStore,
  issueId: string
): GithubHeadObservation[] {
  const observations = store.listSettings(`github-head-observation:${issueId}:`)
    .flatMap(({ value }) => {
      try {
        const parsed = JSON.parse(value) as {
          headSha?: unknown;
          observedAt?: unknown;
          provenance?: unknown;
        };
        const headSha = typeof parsed.headSha === "string"
          ? githubCommitSha(parsed.headSha)
          : undefined;
        const observedAt = typeof parsed.observedAt === "string" ? parsed.observedAt : undefined;
        const provenance: GithubHeadObservationProvenance =
          parsed.provenance === "live_reconciliation" ||
            parsed.provenance === "provider_projection"
            ? parsed.provenance
            : "provider_event";
        return headSha && observedAt && !Number.isNaN(Date.parse(observedAt))
          ? [{ headSha, observedAt, provenance }]
          : [];
      } catch {
        return [];
      }
    });
  const current = currentGithubHeadObservation(store, issueId);
  if (current && !observations.some((observation) =>
    observation.headSha === current.headSha && observation.observedAt === current.observedAt &&
      observation.provenance === current.provenance
  )) {
    observations.push(current);
  }
  return observations.filter((observation) => observation.provenance === "provider_event");
}

function githubHeadProjectionRevision(store: SupervisorStore, issueId: string): string {
  return JSON.stringify([
    store.getSetting(`github-head:${issueId}`) ?? null,
    store.getSetting(`github-head-source:${issueId}`) ?? null,
    store.getSetting(`github-head-observed-at:${issueId}`) ?? null,
    store.getSetting(`github-head-observed-provenance:${issueId}`) ?? null,
    store.getSetting(`github-head-projection-generation:${issueId}`) ?? null,
  ]);
}

function withGithubHeadProjectionLease<T>(
  store: SupervisorStore,
  issueId: string,
  operation: () => T
): T {
  const owner = `github-head-reconciliation:${process.pid}:${randomUUID()}`;
  const now = new Date();
  const acquired = store.acquireSupervisorLease(
    `github-head-reconciliation:${issueId}`,
    owner,
    now.toISOString(),
    new Date(now.getTime() + 30_000).toISOString()
  );
  if (!acquired) throw new Error("GitHub head projection reconciliation is already in progress");
  try {
    return operation();
  } finally {
    store.releaseSupervisorLease(`github-head-reconciliation:${issueId}`, owner);
  }
}

async function reconcileAuthoritativeGithubHead(params: {
  cfg: Config;
  store: SupervisorStore;
  issueId: string;
  repository: string;
  pullNumber: number;
  eventHeadSha: string;
  providerObservedAt?: string;
  evidenceKind: GithubHeadEvidenceKind;
}): Promise<string> {
  const priorHead = githubCommitSha(params.store.getSetting(`github-head:${params.issueId}`));
  const priorSource = params.store.getSetting(`github-head-source:${params.issueId}`);
  if (priorSource === "authoritative" && priorHead && priorHead !== params.eventHeadSha &&
      params.cfg.githubReadToken) {
    const priorObservation = currentGithubHeadObservation(params.store, params.issueId);
    if (priorObservation) {
      // Backfill legacy/current projections into the durable timeline before a
      // promotion can replace them. This also preserves equal-time ambiguity.
      setAuthoritativeGithubHead(
        params.store,
        params.issueId,
        priorObservation.headSha,
        priorObservation.observedAt,
        "history_only",
        priorObservation.provenance
      );
    }
    if (params.evidenceKind === "head_transition") {
      // Retain a signed head-transition timestamp even when its delivery
      // arrived out of order. Generic PR/review updated_at values are not
      // transition cursors and must never enter this temporal evidence set.
      setAuthoritativeGithubHead(
        params.store,
        params.issueId,
        params.eventHeadSha,
        params.providerObservedAt,
        "history_only"
      );
    }
    let expectedProjectionRevision = githubHeadProjectionRevision(
      params.store,
      params.issueId
    );
    let retriedAfterConcurrentChange = false;
    for (let attempt = 0; attempt < GITHUB_HEAD_LIVE_RECONCILIATION_ATTEMPT_LIMIT; attempt += 1) {
      const liveHeadSha = githubCommitSha(await fetchGithubPullRequestHeadSha(
        { token: params.cfg.githubReadToken },
        params.repository,
        params.pullNumber
      ));
      if (!liveHeadSha) throw new Error("GitHub pull request returned an invalid current head");
      const step: GithubHeadReconciliationStep = withGithubHeadProjectionLease(
        params.store,
        params.issueId,
        () => {
          const currentProjectionRevision = githubHeadProjectionRevision(
            params.store,
            params.issueId
          );
          if (currentProjectionRevision !== expectedProjectionRevision) {
            // The provider read began against an older projection. Refetch
            // against the newly committed revision instead of deciding that
            // either the response or the concurrent projection is newer.
            return {
              kind: "retry",
              projectionRevision: currentProjectionRevision,
            };
          }
          const currentHead = githubCommitSha(
            params.store.getSetting(`github-head:${params.issueId}`)
          );
          const currentSource = params.store.getSetting(`github-head-source:${params.issueId}`);
          if (currentSource === "authoritative" && liveHeadSha === currentHead) {
            // The live resource confirms the current projection. Do not replace
            // its earlier provenance with a generic or handler-time observation.
            return { kind: "done", headSha: liveHeadSha };
          }
          if (!retriedAfterConcurrentChange && liveHeadSha === params.eventHeadSha) {
            const transitionEvidence = params.evidenceKind === "head_transition";
            setAuthoritativeGithubHead(
              params.store,
              params.issueId,
              liveHeadSha,
              params.providerObservedAt ?? new Date().toISOString(),
              "force",
              transitionEvidence ? "provider_event" : "provider_projection"
            );
          } else {
            // A live resource read proves only handler-time state. After a
            // concurrent projection change, even a head matching this event is
            // causally a fresh read rather than evidence from the old snapshot.
            setAuthoritativeGithubHead(
              params.store,
              params.issueId,
              liveHeadSha,
              new Date().toISOString(),
              "force",
              "live_reconciliation"
            );
          }
          return { kind: "done", headSha: liveHeadSha };
        }
      );
      if (step.kind === "done") return step.headSha;
      if (attempt === GITHUB_HEAD_LIVE_RECONCILIATION_ATTEMPT_LIMIT - 1) {
        throw new Error("GitHub head projection changed repeatedly during live reconciliation");
      }
      expectedProjectionRevision = step.projectionRevision;
      retriedAfterConcurrentChange = true;
    }
    throw new Error("GitHub head live reconciliation attempt limit exhausted");
  }
  return withGithubHeadProjectionLease(params.store, params.issueId, () => {
    const currentHead = githubCommitSha(
      params.store.getSetting(`github-head:${params.issueId}`)
    );
    const currentSource = params.store.getSetting(`github-head-source:${params.issueId}`);
    if (currentSource === "authoritative" && currentHead === params.eventHeadSha) {
      if (params.evidenceKind === "head_transition") {
        setAuthoritativeGithubHead(
          params.store,
          params.issueId,
          params.eventHeadSha,
          params.providerObservedAt,
          "monotonic",
          "provider_event"
        );
      }
      return currentHead;
    }
    setAuthoritativeGithubHead(
      params.store,
      params.issueId,
      params.eventHeadSha,
      params.providerObservedAt ?? new Date().toISOString(),
      "monotonic",
      params.evidenceKind === "head_transition" ? "provider_event" : "provider_projection"
    );
    return githubCommitSha(params.store.getSetting(`github-head:${params.issueId}`)) ??
      params.eventHeadSha;
  });
}

function githubPullEventId(
  action: "closed" | "closed-stop" | "synchronize",
  repository: string,
  pullNumber: number,
  headSha: string
): string {
  return `github-pull-${action}:${repository}:${pullNumber}:${headSha}`;
}

async function authorizedGithubControlActor(
  cfg: Config,
  repository: string,
  author: string | undefined
): Promise<boolean> {
  if (!author) return false;
  const permission = await getRepositoryCollaboratorPermission(
    { token: cfg.githubReadToken },
    repository,
    author
  );
  return isAuthorizedGithubControlPermission(permission);
}

type GithubIssueLifecycle = {
  state: "open" | "closed";
  observedAt: string;
};

function githubIssueLifecycleKey(repository: string, issueNumber: number): string {
  return `github-issue-lifecycle:${repository.toLowerCase()}#${issueNumber}`;
}

function readGithubIssueLifecycle(
  store: SupervisorStore,
  repository: string,
  issueNumber: number
): GithubIssueLifecycle | undefined {
  const raw = store.getSetting(githubIssueLifecycleKey(repository, issueNumber));
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<GithubIssueLifecycle>;
    if ((value.state !== "open" && value.state !== "closed") ||
        typeof value.observedAt !== "string" || Number.isNaN(Date.parse(value.observedAt))) {
      return undefined;
    }
    return value as GithubIssueLifecycle;
  } catch {
    return undefined;
  }
}

function recordGithubIssueLifecycle(
  store: SupervisorStore,
  repository: string,
  issueNumber: number,
  lifecycle: GithubIssueLifecycle,
  providerAuthoritative = false
): GithubIssueLifecycle {
  const prior = readGithubIssueLifecycle(store, repository, issueNumber);
  const nextTime = Date.parse(lifecycle.observedAt);
  if (Number.isNaN(nextTime)) return prior ?? lifecycle;
  if (prior) {
    const priorTime = Date.parse(prior.observedAt);
    if (nextTime < priorTime ||
        (!providerAuthoritative && nextTime === priorTime &&
          prior.state === "closed" && lifecycle.state === "open")) {
      return prior;
    }
  }
  store.setSetting(
    githubIssueLifecycleKey(repository, issueNumber),
    JSON.stringify(lifecycle)
  );
  return lifecycle;
}

function githubIssueEventTimestamp(event: Extract<GithubWebhookEvent, { kind: "issues" }>): string | undefined {
  if (event.action === "closed") return event.issue.closed_at ?? event.issue.updated_at;
  if (event.action === "opened") return event.issue.created_at ?? event.issue.updated_at;
  return event.issue.updated_at ?? event.issue.created_at;
}

// Shared session-recency predicate: resolves the current session (falling
// back to the ticket's bound session) and compares a caller-chosen provider
// timestamp against its activation time. http/server.ts's GitHub control
// webhook dedupe uses this too, with its own timestamp chooser -- keep the
// resolution and comparison rules here so they cannot silently diverge.
export function eventPredatesCurrentSession(
  store: SupervisorStore,
  ticket: NonNullable<ReturnType<SupervisorStore["getByIssueId"]>>,
  providerTimestamp: string | undefined
): boolean {
  if (!providerTimestamp || Number.isNaN(Date.parse(providerTimestamp))) return false;
  const session = store.getCurrentSession(ticket.ticket_id) ?? store.getSession(ticket.session_id);
  const providerActivatedAt = session?.provider_activated_at ?? session?.created_at;
  return providerActivatedAt !== undefined &&
    Date.parse(providerTimestamp) < Date.parse(providerActivatedAt);
}

function githubIssueCommentTimestampOrder(
  store: SupervisorStore,
  ticket: NonNullable<ReturnType<SupervisorStore["getByIssueId"]>>,
  providerTimestamp: string | undefined
): "before" | "equal" | "after" | "unknown" {
  const session = store.getCurrentSession(ticket.ticket_id) ?? store.getSession(ticket.session_id);
  const providerActivatedAt = session?.provider_activated_at ?? session?.created_at;
  if (!providerActivatedAt || !providerTimestamp ||
      Number.isNaN(Date.parse(providerActivatedAt)) ||
      Number.isNaN(Date.parse(providerTimestamp))) return "unknown";
  const commentTime = Date.parse(providerTimestamp);
  const activationTime = Date.parse(providerActivatedAt);
  if (commentTime < activationTime) return "before";
  if (commentTime > activationTime) return "after";
  return "equal";
}

function lifecycleFromIssueEvent(
  event: Extract<GithubWebhookEvent, { kind: "issues" }>
): GithubIssueLifecycle | undefined {
  const observedAt = githubIssueEventTimestamp(event);
  if (!observedAt) return undefined;
  const state = event.action === "closed" || event.issue.state === "closed" ? "closed" : "open";
  return { state, observedAt };
}

export function githubIssueAdmissionPreflight(input: {
  cfg: Config;
  store: SupervisorStore;
  repository: string;
  issueNumber: number;
  expectedProviderActivation: Pick<GithubIssueControlEventRecord, "id" | "actorLogin">;
  upstream?: AdmissionPreflight;
}): AdmissionPreflight {
  return async (target) => {
    if (input.upstream) {
      const verdict = await input.upstream(target);
      if (!verdict.ok) return verdict;
    }
    const live = await fetchGithubIssueLifecycle(
      { token: input.cfg.githubReadToken },
      input.repository,
      input.issueNumber
    );
    const current = recordGithubIssueLifecycle(
      input.store,
      input.repository,
      input.issueNumber,
      { state: live.state, observedAt: live.updatedAt },
      true
    );
    if (current.state === "closed") {
      return {
        ok: false,
        reason: `GitHub Issue ${input.repository}#${input.issueNumber} is closed, so no pipeline was admitted. Reopen it to start a new generation.`,
      };
    }
    if (!githubIssueHasExactControlLabel(live.labels)) {
      return {
        ok: false,
        reason: `GitHub Issue ${input.repository}#${input.issueNumber} no longer has the exact ${GITHUB_CONTROL_LABEL} control label, so no pipeline was admitted.`,
      };
    }
    if (!await authorizedGithubControlActor(
      input.cfg,
      input.repository,
      input.expectedProviderActivation.actorLogin
    )) {
      return {
        ok: false,
        reason: `GitHub Issue ${input.repository}#${input.issueNumber}'s activation actor is no longer authorized, so no pipeline was admitted.`,
      };
    }
    // Make the body-free Issue Event stream the last provider read before the
    // synchronous admission transaction. Live state and label alone cannot
    // prove that a slow selection still belongs to the same activation epoch.
    const controlEvents = await fetchGithubIssueControlEvents(
      { token: input.cfg.githubReadToken },
      input.repository,
      input.issueNumber
    );
    const currentActivation = currentGithubIssueActivation(controlEvents);
    if (!currentActivation ||
        currentActivation.id !== input.expectedProviderActivation.id ||
        currentActivation.actorLogin.toLowerCase() !==
          input.expectedProviderActivation.actorLogin.toLowerCase()) {
      return {
        ok: false,
        reason: `GitHub Issue ${input.repository}#${input.issueNumber}'s activation epoch changed while admission was prepared, so this stale delivery admitted no pipeline.`,
      };
    }
    return { ok: true };
  };
}

function latestGithubIssueControlEvent(
  events: GithubIssueControlEventRecord[],
  kinds: ReadonlySet<GithubIssueControlEventRecord["kind"]>
): GithubIssueControlEventRecord | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (!kinds.has(event.kind)) continue;
    return event;
  }
  return undefined;
}

function currentGithubIssueActivation(
  events: GithubIssueControlEventRecord[]
): GithubIssueControlEventRecord | undefined {
  let latestDeactivationIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.kind === "closed" || events[index]!.kind === "unlabeled") {
      latestDeactivationIndex = index;
      break;
    }
  }
  for (let index = events.length - 1; index > latestDeactivationIndex; index -= 1) {
    const event = events[index]!;
    if (event.kind === "labeled" || event.kind === "reopened") return event;
  }
  return undefined;
}

function githubIssueControlEventIsAfterSession(
  events: GithubIssueControlEventRecord[],
  event: GithubIssueControlEventRecord,
  session: NonNullable<ReturnType<SupervisorStore["getSession"]>>,
  allowEqualTimestampWithoutCursor = false
): boolean {
  if (session.provider_activation_id) {
    const sessionIndex = events.findIndex((candidate) => candidate.id === session.provider_activation_id);
    if (sessionIndex < 0) {
      throw new Error("GitHub Issue activation cursor is outside the bounded event history");
    }
    return events.findIndex((candidate) => candidate.id === event.id) > sessionIndex;
  }
  const activatedAt = session.provider_activated_at ?? session.created_at;
  return allowEqualTimestampWithoutCursor
    ? Date.parse(event.createdAt) >= Date.parse(activatedAt)
    : Date.parse(event.createdAt) > Date.parse(activatedAt);
}

export function githubIssueControlSessionId(input: {
  store: SupervisorStore;
  pipelines: PipelineStore;
  event: Extract<GithubWebhookEvent, { kind: "issues" }>;
  deliveryId?: string;
  providerActivationId?: string;
}): string | undefined {
  const externalThreadId = `${input.event.repository.full_name}#${input.event.issue.number}`;
  const ticket = input.store.getByExternalThread("github", externalThreadId);
  const current = ticket
    ? input.pipelines.getInstanceForSession(ticket.session_id)
    : undefined;
  if (current && !pipelineIsTerminal(current)) return ticket!.session_id;
  if (input.event.action === "reopened") {
    return `github:${externalThreadId}:reopened:${input.providerActivationId ?? input.deliveryId ?? "current"}`;
  }
  if (ticket && input.event.action === "labeled") {
    return `github:${externalThreadId}:label:${input.providerActivationId ?? input.deliveryId ?? "current"}`;
  }
  if (ticket) return undefined;
  return `github:${externalThreadId}:initial`;
}

export function considerCiGithubHead(
  store: SupervisorStore,
  issueId: string,
  headSha: string,
  source: "workflow_run" | "check_suite",
  sequence: number
): void {
  const headKey = `github-head:${issueId}`;
  const sourceKey = `github-head-source:${issueId}`;
  const generationKey = `github-head-projection-generation:${issueId}`;
  const watermarkKey = `github-head-watermark:${issueId}:${source}`;
  const currentHead = store.getSetting(headKey);
  const rawSource = store.getSetting(sourceKey);
  const priorSequence = Number(store.getSetting(watermarkKey));
  if (rawSource === "authoritative" ||
      (Number.isSafeInteger(priorSequence) && sequence <= priorSequence)) return;
  const canAdvance =
    !currentHead ||
    currentHead.startsWith("unknown:") ||
    currentHead === headSha ||
    rawSource !== "authoritative";
  if (!canAdvance) return;
  store.setSettings([
    { key: watermarkKey, value: String(sequence) },
    { key: headKey, value: headSha },
    { key: sourceKey, value: JSON.stringify({ source, sequence }) },
    { key: generationKey, value: randomUUID() },
  ]);
}

// Known Linear↔GitHub bridge identities whose PR comments are linkage
// artifacts, never human repair requests.
const LINEAR_BRIDGE_BOT_LOGINS = new Set(["linear-code[bot]", "linear[bot]"]);

// Unambiguous machine linkback marker for bridge deployments that comment
// under a different app identity. Comment bodies are untrusted data, so the
// filter accepts only this exact self-identifying prefix — never keyword
// heuristics, which would silently drop substantive automated review feedback
// (e.g. an app comment that merely says "linear issue" in prose) before it is
// recorded as provider evidence.
const LINEAR_LINKBACK_MARKER = "<!-- linear-linkback -->";
const CODEX_REVIEW_COMMAND = "@codex review";
const CODEX_CONNECTOR_AUTHOR = "chatgpt-codex-connector[bot]";
const CODEX_CLEAN_REVIEW_PATTERN =
  /^Codex Review: Didn't find any major issues\. [^\n]{1,120}\n\n\*\*Reviewed commit:\*\* `([a-f0-9]{7,40})`\n\n<details> <summary>ℹ️ About Codex in GitHub<\/summary>\n<br\/>\n\n\[Your team has set up Codex to review pull requests in this repo\]\(https:\/\/chatgpt\.com\/codex\/cloud\/settings\/general\)\. Reviews are triggered when you\n- Open a pull request for review\n- Mark a draft as ready\n- Comment "@codex review"\.\n\nIf Codex has suggestions, it will comment; otherwise it will react with 👍\.\s+Codex can also answer questions or update the PR\. Try commenting "@codex address that feedback"\.\s*<\/details>$/i;
const CODEX_CONNECTOR_SETUP_REQUIRED_NOTICE =
  "To use Codex here, [create an environment for this repo](https://chatgpt.com/codex/cloud/settings/environments).";
const GITHUB_COMMIT_SHA = /^[a-f0-9]{40}$/;
const REVIEWED_COMMIT = /^[a-f0-9]{7,40}$/;

function isGithubBotLinkback(author: string, body: string | undefined): boolean {
  const normalizedAuthor = author.toLowerCase();
  if (LINEAR_BRIDGE_BOT_LOGINS.has(normalizedAuthor)) return true;
  if (!normalizedAuthor.endsWith("[bot]")) return false;
  return (body ?? "").startsWith(LINEAR_LINKBACK_MARKER);
}

function recordIgnoredGithubProviderNoise(params: {
  pipelines: PipelineStore;
  ticket: NonNullable<ReturnType<SupervisorStore["getByIssueId"]>>;
  eventId: string;
  eventKind: string;
  reason: string;
  headSha?: string;
}): void {
  const instance = params.pipelines.getInstanceForSession(params.ticket.session_id);
  if (!instance || pipelineIsTerminal(instance)) return;
  params.pipelines.recordJournalEntry({
    id: `github-provider-noise:${params.eventId}`,
    issueId: params.ticket.ticket_id,
    instanceId: instance.id,
    actor: "supervisor",
    kind: "run_note",
    trigger: "GitHub provider feedback normalization",
    action: "Ignored non-actionable GitHub provider event before repair admission.",
    outcome: params.reason,
    refs: {
      provider: "github",
      event_kind: params.eventKind,
      provider_event_id: params.eventId,
      reason: params.reason,
      ...(params.headSha ? { head_sha: params.headSha } : {}),
    },
  });
}

function isExactCodexReviewCommand(body: string | undefined): boolean {
  return body?.trim() === CODEX_REVIEW_COMMAND;
}

function reviewedCommitFromCodexCleanReview(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const normalized = body.replaceAll("\r\n", "\n").trim();
  const match = CODEX_CLEAN_REVIEW_PATTERN.exec(normalized);
  const commit = match?.[1]?.toLowerCase();
  return commit && REVIEWED_COMMIT.test(commit) ? commit : undefined;
}

function githubCommitSha(value: string | undefined): string | undefined {
  const normalized = value?.toLowerCase();
  return normalized && GITHUB_COMMIT_SHA.test(normalized) ? normalized : undefined;
}

function isTrustedCodexConnectorAuthor(input: {
  author: string;
  authorType?: string;
}): boolean {
  return input.author.toLowerCase() === CODEX_CONNECTOR_AUTHOR &&
    (input.authorType === undefined || input.authorType === "Bot");
}

function reviewedCommitFromTrustedCodexCleanReview(input: {
  author: string;
  authorType?: string;
  body: string | undefined;
}): string | undefined {
  if (!isTrustedCodexConnectorAuthor(input)) return undefined;
  return reviewedCommitFromCodexCleanReview(input.body);
}

function isCodexConnectorSetupRequiredNotice(input: {
  author: string;
  authorType?: string;
  body: string | undefined;
}): boolean {
  return isTrustedCodexConnectorAuthor(input) &&
    input.body?.trim() === CODEX_CONNECTOR_SETUP_REQUIRED_NOTICE;
}

function boundedSanitized(value: string, maxChars: number): string {
  return sanitizeText(value).slice(0, maxChars);
}

async function enrichCiFailure(input: {
  cfg: Config;
  repository: string;
  headSha: string;
  workflowRunId?: number;
  workflowName: string;
}): Promise<{
  failures: Array<{
    workflow_name: string;
    job_name: string;
    step_names: string[];
    log_tail: string | null;
    html_url: string | null;
  }>;
  findings: ProviderFinding[];
  note: string | null;
}> {
  try {
    const details = await getFailingGithubCheckDetails(
      { token: input.cfg.githubReadToken },
      input.repository,
      {
        headSha: input.headSha,
        workflowRunId: input.workflowRunId,
        workflowName: input.workflowName,
      }
    );
    const failures = details.map((detail) => {
      const stepNames = detail.stepNames.map((name) => boundedSanitized(name, 200));
      return {
        workflow_name: boundedSanitized(detail.workflowName, 200),
        job_name: boundedSanitized(detail.jobName, 200),
        step_names: stepNames,
        log_tail: detail.logTail === null ? null : sanitizeText(detail.logTail).slice(-2_000),
        html_url: detail.htmlUrl === null ? null : boundedSanitized(detail.htmlUrl, 1_000),
      };
    }).slice(0, 3);
    return {
      failures,
      findings: failures.map((failure) => {
        const step = failure.step_names.length > 0 ? failure.step_names.join(", ") : "unknown failing step";
        return {
          severity: "P1",
          code: "ci-check-failed",
          summary: `${failure.workflow_name} / ${failure.job_name} failed at ${step}.`,
        };
      }),
      note: null,
    };
  } catch (error) {
    // Enrichment stays non-fatal, but its absence must be legible: a 403 here
    // almost always means GITHUB_READ_TOKEN lacks the Actions read permission
    // that the jobs/job-log endpoints require on fine-grained PATs.
    const message = error instanceof Error ? error.message : String(error);
    const note = message.includes("(403)")
      ? "CI failure details are unavailable: GitHub returned 403 for the Actions jobs/logs lookup. " +
        "Grant the fine-grained GITHUB_READ_TOKEN Actions read permission to restore failing-job and log-tail enrichment."
      : `CI failure details are unavailable: ${boundedSanitized(message, 300)}`;
    return { failures: [], findings: [], note };
  }
}

export async function handleGithubEvent(
  // Retained for signature stability at the composition/HTTP call sites; the
  // solo-mode feedback filter no longer needs a token-account lookup.
  _cfg: Config,
  store: SupervisorStore,
  activityPublisher: ActivityPublicationPort,
  event: GithubWebhookEvent,
  pipelines: PipelineStore,
  control?: {
    ports: SessionServicePorts;
    coordinator: PipelineCoordinatorContext;
    preflight?: AdmissionPreflight;
    deliveryId?: string;
    receivedAt?: string;
  }
): Promise<void> {
  if (event.kind === "pull_request") {
    const branch = event.pull_request.head.ref;
    if (!isOpenthrottleBranch(branch)) return;
    const ticket = store.getByBranch(event.repository.full_name, branch);
    if (!ticket) return;
    const pipelineInstance = pipelines.getInstanceForSession(ticket.session_id);
    if (!pipelineInstance) return;
    if (ticket.pr_url && ticket.pr_url !== event.pull_request.html_url) return;
    if (event.action === "opened" || event.action === "reopened" || event.action === "synchronize") {
      store.setPrUrl(ticket.ticket_id, event.pull_request.html_url);
      if (event.pull_request.head.sha) {
        await reconcileAuthoritativeGithubHead({
          cfg: _cfg,
          store,
          issueId: ticket.ticket_id,
          repository: event.repository.full_name,
          pullNumber: event.pull_request.number,
          eventHeadSha: event.pull_request.head.sha,
          providerObservedAt: event.pull_request.updated_at,
          evidenceKind: event.action === "opened" || event.action === "synchronize"
            ? "head_transition"
            : "current_projection",
        });
      }
    }
    if (event.action === "synchronize" && event.pull_request.head.sha) {
      routePipelineProviderEvent({
        pipelines,
        store,
        ticket,
        eventId: githubPullEventId(
          "synchronize",
          event.repository.full_name,
          event.pull_request.number,
          event.pull_request.head.sha
        ),
        outcome: "needs_human",
        summary: "The pull-request head changed after the pipeline entered provider wait.",
        evidence: [event.pull_request.html_url],
        payload: { kind: "pull_request", action: "synchronize" },
        headSha: event.pull_request.head.sha,
        pullRequestUrl: event.pull_request.html_url,
        receivedAt: control?.receivedAt,
      });
    }
    if (event.action === "closed") {
      const providerEventId = githubPullEventId(
        "closed",
        event.repository.full_name,
        event.pull_request.number,
        event.pull_request.head.sha ?? "unknown"
      );
      if (event.pull_request.head.sha) {
        await reconcileAuthoritativeGithubHead({
          cfg: _cfg,
          store,
          issueId: ticket.ticket_id,
          repository: event.repository.full_name,
          pullNumber: event.pull_request.number,
          eventHeadSha: event.pull_request.head.sha,
          providerObservedAt: event.pull_request.updated_at,
          evidenceKind: "current_projection",
        });
      }
      store.setPrUrl(ticket.ticket_id, event.pull_request.html_url);
      const routedPipeline = routePipelineProviderEvent({
        pipelines,
        store,
        ticket,
        eventId: providerEventId,
        outcome: event.pull_request.merged ? "success" : "no_change",
        summary: event.pull_request.merged ? "GitHub reports the pull request merged." : "GitHub reports the pull request closed without merge.",
        evidence: [event.pull_request.html_url],
        payload: { kind: "pull_request", action: "closed", merged: event.pull_request.merged },
        headSha: event.pull_request.head.sha ?? store.getSetting(`github-head:${ticket.ticket_id}`),
        pullRequestUrl: event.pull_request.html_url,
        receivedAt: control?.receivedAt,
      });
      const currentPipeline = routedPipeline
        ? pipelines.getInstanceForSession(ticket.session_id)
        : undefined;
      const providerEvidenceDeferred =
        pipelines.getInboxEvent(providerEventId)?.status === "pending";
      if (currentPipeline && !pipelineIsTerminal(currentPipeline) && !providerEvidenceDeferred) {
        requestPipelineStop({
          store: pipelines,
          sessionId: ticket.session_id,
          eventId: githubPullEventId(
            "closed-stop",
            event.repository.full_name,
            event.pull_request.number,
            event.pull_request.head.sha ?? "unknown"
          ),
          reason: event.pull_request.merged
            ? "Pull request merged while a pipeline stage was active."
            : "Pull request closed while a pipeline stage was active.",
          ticketState: "closed",
        });
      }
      if (event.pull_request.merged) {
        const observed = currentPipeline ?? pipelineInstance;
        pipelines.recordJournalEntry({
          id: `journal-github-merged-${observed.repository}-${event.pull_request.number}-${event.pull_request.head.sha ?? "unknown"}`,
          issueId: ticket.ticket_id,
          instanceId: observed.id,
          actor: "supervisor",
          kind: "merged",
          trigger: "GitHub pull_request closed webhook",
          action: "Observed the pull request merged.",
          outcome: "merged",
          refs: {
            pr: event.pull_request.html_url,
            commit: event.pull_request.head.sha ?? null,
            pull_number: event.pull_request.number,
          },
        });
      }
      // GitHub close is authoritative even when a stage already settled and
      // has no live attempt left for a stop event to cancel.
      store.setState(ticket.ticket_id, "closed");
      store.markSessionState(ticket.session_id, "stopped");
      store.cancelPendingInbox(ticket.ticket_id);
    }
    return;
  }

  if (event.kind === "pull_request_review") {
    const ticket = store.getByPrUrl(event.repository.full_name, event.pull_request.html_url);
    if (!ticket || event.action !== "submitted") return;
    const reviewState = event.review.state.toLowerCase();
    const author = event.review.user?.login;
    if ((reviewState === "changes_requested" || reviewState === "commented") && !author) return;
    const prHeadSha = githubCommitSha(event.pull_request.head.sha);
    if (prHeadSha) {
      await reconcileAuthoritativeGithubHead({
        cfg: _cfg,
        store,
        issueId: ticket.ticket_id,
        repository: event.repository.full_name,
        pullNumber: event.pull_request.number,
        eventHeadSha: prHeadSha,
        providerObservedAt: event.pull_request.updated_at,
        evidenceKind: "current_projection",
      });
    }
    await activityPublisher.publishActivity({
      sessionId: ticket.session_id,
      type: "action",
      action: "PR review submitted",
      parameter: `${event.review.user?.login ?? "reviewer"}: ${event.review.state}`,
      result: event.review.html_url,
    }, ticket.ticket_id);
    if (reviewState !== "changes_requested" && reviewState !== "commented") return;
    if (!author) return;
    // A review without an attested author cannot be trusted feedback. The
    // supervisor never authors pull-request reviews, so no machine-output
    // filtering applies here — every attested review is human.
    const reviewedHeadSha = githubCommitSha(event.review.commit_id);
    const headSha = reviewedHeadSha ??
      prHeadSha ??
      store.getSetting(`github-head:${ticket.ticket_id}`) ??
      `unknown:${event.pull_request.head.ref}`;
    if (!prHeadSha && !store.getSetting(`github-head:${ticket.ticket_id}`)) {
      store.setSettings([
        { key: `github-head:${ticket.ticket_id}`, value: headSha },
        {
          key: `github-head-projection-generation:${ticket.ticket_id}`,
          value: randomUUID(),
        },
      ]);
    }
    const reviewBody = event.review.body?.trim() ?? "";
    const pullRequestAuthor = event.pull_request.user?.login;
    if (reviewState === "commented" && reviewBody.length === 0 &&
        pullRequestAuthor &&
        pullRequestAuthor.toLowerCase() === author.toLowerCase()) {
      const comments = await fetchGithubPullRequestReviewComments(
        { token: _cfg.githubReadToken },
        event.repository.full_name,
        event.pull_request.number,
        event.review.id
      );
      if (comments && comments.length > 0 && comments.every((comment) => comment.inReplyToId !== undefined)) {
        recordIgnoredGithubProviderNoise({
          pipelines,
          ticket,
          eventId: `github-review:${event.review.id}`,
          eventKind: "pull_request_review",
          reason: "author_empty_reply_only_review",
          headSha,
        });
        return;
      }
    }
    routePipelineProviderEvent({
      pipelines,
      store,
      ticket,
      eventId: `github-review:${event.review.id}`,
      outcome: "semantic_repair_required",
      summary: `GitHub review from ${author ?? "reviewer"} requires another implementation pass.`,
      evidence: [event.review.html_url],
      payload: { kind: "pull_request_review", state: event.review.state, head_sha: headSha },
      headSha,
      pullRequestUrl: event.pull_request.html_url,
      receivedAt: control?.receivedAt,
    });
    return;
  }

  if (event.kind === "issue_comment") {
    if (pipelines.isSupervisorGithubComment(String(event.comment.id))) return;
    if (store.getSetting(`github-supervisor-comment:${event.comment.id}`)) return;
    if (githubSupervisorCommentWriteIsPending(
      store,
      event.repository.full_name,
      event.issue.number,
      event.comment.body
    )) {
      // Do not decide provenance from caller-controlled marker text. A durable
      // write intent only defers this delivery until the GitHub mutation has
      // returned and the exact supervisor-authored comment id is persisted.
      throw new Error("GitHub supervisor comment publication is still in flight");
    }
    if (classifyGithubIssueComment(event) === "plain_issue_comment") {
      if (!control || event.action !== "created") return;
      const author = event.comment.user?.login;
      if (!await authorizedGithubControlActor(_cfg, event.repository.full_name, author)) return;
      const externalThreadId = `${event.repository.full_name}#${event.issue.number}`;
      const existingTicket = store.getByExternalThread(
        "github",
        externalThreadId
      );
      const currentPipeline = existingTicket
        ? pipelines.getInstanceForSession(existingTicket.session_id)
        : undefined;
      const currentSession = existingTicket
        ? store.getCurrentSession(existingTicket.ticket_id) ??
          store.getSession(existingTicket.session_id)
        : undefined;
      if (existingTicket && currentSession) {
        const timestampOrder = githubIssueCommentTimestampOrder(
          store,
          existingTicket,
          event.comment.created_at
        );
        if (timestampOrder === "before") return;
        if (timestampOrder === "equal" || timestampOrder === "unknown") {
          const providerActivatedAt = currentSession.provider_activated_at ??
            currentSession.created_at;
          const exactOrder = timestampOrder === "equal" &&
              currentSession.provider_activation_id && providerActivatedAt &&
              event.comment.created_at
            ? await compareGithubIssueActivationAndComment(
                { token: _cfg.githubReadToken },
                event.repository.full_name,
                event.issue.number,
                {
                  activation: {
                    id: currentSession.provider_activation_id,
                    createdAt: providerActivatedAt,
                  },
                  comment: {
                    id: String(event.comment.id),
                    createdAt: event.comment.created_at,
                    actorLogin: author!,
                  },
                }
              )
            : "unresolved";
          if (exactOrder === "comment_before_activation") return;
          if (exactOrder === "unresolved" && currentPipeline &&
              !pipelineIsTerminal(currentPipeline)) {
            await activityPublisher.publishError(
              currentSession.id,
              existingTicket.ticket_id,
              GITHUB_COMMENT_ORDERING_GUIDANCE
            );
            return;
          }
        }
      }
      if (
        (!existingTicket || !currentPipeline || pipelineIsTerminal(currentPipeline)) &&
        store.githubIssueAdmissionInFlight(
          event.repository.full_name,
          event.issue.number
        )
      ) {
        // Admission fetches and validates provider/repository state before its
        // ticket transaction. A retained terminal ticket may still be awaiting
        // a reopened/relabel successor, while a durable nonterminal generation
        // is already safe to receive the comment immediately.
        throw new Error("GitHub Issue admission is still in flight");
      }
      if (!existingTicket) {
        const live = await fetchGithubIssueLifecycle(
          { token: _cfg.githubReadToken },
          event.repository.full_name,
          event.issue.number
        );
        if (live.state === "open" && githubIssueHasExactControlLabel(live.labels)) {
          // GitHub does not guarantee webhook delivery order. The activation
          // webhook may not have been claimed yet even though the provider's
          // Issue already reflects it. Leave this durable comment retryable so
          // it cannot acknowledge a missing workspace ahead of admission.
          throw new Error("GitHub Issue activation is not durable yet");
        }
      } else if (!currentPipeline || pipelineIsTerminal(currentPipeline)) {
        const session = currentSession;
        const providerActivatedAt = session?.provider_activated_at ?? session?.created_at;
        const live = await fetchGithubIssueLifecycle(
          { token: _cfg.githubReadToken },
          event.repository.full_name,
          event.issue.number
        );
        if (providerActivatedAt && event.comment.created_at && live.state === "open" &&
            githubIssueHasExactControlLabel(live.labels)) {
          const controlEvents = await fetchGithubIssueControlEvents(
              { token: _cfg.githubReadToken },
              event.repository.full_name,
              event.issue.number
          );
          const latestActivation = currentGithubIssueActivation(controlEvents);
          const activationFollowsSession = Boolean(session && latestActivation &&
            githubIssueControlEventIsAfterSession(controlEvents, latestActivation, session));
          const activationIsAuthorized = latestActivation
            ? await authorizedGithubControlActor(
                _cfg,
                event.repository.full_name,
                latestActivation.actorLogin
              )
            : false;
          let activationPrecedesComment = false;
          if (session && latestActivation && activationFollowsSession && activationIsAuthorized) {
            const activationTime = Date.parse(latestActivation.createdAt);
            const commentTime = Date.parse(event.comment.created_at);
            if (activationTime < commentTime) {
              activationPrecedesComment = true;
            } else if (activationTime === commentTime && author) {
              const exactOrder = await compareGithubIssueActivationAndComment(
                { token: _cfg.githubReadToken },
                event.repository.full_name,
                event.issue.number,
                {
                  activation: latestActivation,
                  comment: {
                    id: String(event.comment.id),
                    createdAt: event.comment.created_at,
                    actorLogin: author,
                  },
                }
              );
              if (exactOrder === "unresolved") {
                await activityPublisher.publishError(
                  session.id,
                  existingTicket.ticket_id,
                  GITHUB_COMMENT_ORDERING_GUIDANCE
                );
                return;
              }
              activationPrecedesComment = exactOrder === "activation_before_comment";
            }
          }
          if (activationPrecedesComment) {
            // A provider-authoritative activation newer than the retained
            // terminal session exists, but its delivery has not become durable.
            // Keep the comment retryable without treating a merely still-labeled
            // terminal Issue as evidence of a successor generation.
            throw new Error("GitHub Issue activation is not durable yet");
          }
        }
      }
      await handleControlEvent(
        _cfg,
        store,
        control.ports,
        githubIssueControlEvent(event),
        control.coordinator,
        control.preflight,
        control.receivedAt
      );
      await control.coordinator.drainEffects?.();
      return;
    }
    if (event.action !== "created") return;
    const ticket = store.getByPrUrl(
      event.repository.full_name,
      `https://github.com/${event.repository.full_name}/pull/${event.issue.number}`
    );
    if (!ticket) return;
    const author = event.comment.user?.login;
    if (!author) return;
    const authorType = event.comment.user?.type;
    // Provenance first: comment IDs persisted by supervisor publication are
    // the machine's own output. Body markup never establishes that provenance;
    // this separate check recognizes only explicit Linear bridge artifacts.
    if (isGithubBotLinkback(author, event.comment.body)) return;
    const instance = pipelines.getInstanceForSession(ticket.session_id);
    if (instance && pipelineIsTerminal(instance)) return;
    const currentHeadObservation = currentGithubHeadObservation(store, ticket.ticket_id);
    const providerObservations = providerTimestampedGithubHeads(store, ticket.ticket_id);
    const commentAtMs = event.comment.created_at
      ? Date.parse(event.comment.created_at)
      : Number.NaN;
    const observationsBeforeComment = Number.isNaN(commentAtMs)
      ? []
      : providerObservations
        .filter((observation) => Date.parse(observation.observedAt) < commentAtMs)
        .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
    const latestObservationBeforeComment = observationsBeforeComment.at(-1);
    const latestProviderObservationAtMs = latestObservationBeforeComment
      ? Date.parse(latestObservationBeforeComment.observedAt)
      : undefined;
    const providerTimestampAmbiguous = latestProviderObservationAtMs !== undefined &&
      new Set(observationsBeforeComment
        .filter((observation) =>
          Date.parse(observation.observedAt) === latestProviderObservationAtMs
        )
        .map((observation) => observation.headSha)).size > 1;
    const observedTransitionBeforeComment = latestObservationBeforeComment !== undefined &&
      observationsBeforeComment.some((observation) =>
        observation.headSha !== latestObservationBeforeComment.headSha
      );
    const inferredHeadSha = instance && !pipelineIsTerminal(instance)
      ? acknowledgedPublicationHeadAt(
        pipelines,
        instance,
        event.comment.created_at,
        providerObservations
      )
      : undefined;
    let headSha = inferredHeadSha ?? `unknown:${ticket.branch}`;
    let headOrderingAmbiguous = inferredHeadSha === undefined && providerTimestampAmbiguous;
    if (isExactCodexReviewCommand(event.comment.body)) {
      recordIgnoredGithubProviderNoise({
        pipelines,
        ticket,
        eventId: `github-comment:${event.comment.id}`,
        eventKind: "issue_comment",
        reason: "exact_codex_review_command",
        headSha,
      });
      return;
    }
    if (isCodexConnectorSetupRequiredNotice({
      author,
      authorType,
      body: event.comment.body,
    })) {
      recordIgnoredGithubProviderNoise({
        pipelines,
        ticket,
        eventId: `github-comment:${event.comment.id}`,
        eventKind: "issue_comment",
        reason: "codex_connector_setup_required_notice",
        headSha,
      });
      return;
    }
    const reviewedCommit = reviewedCommitFromTrustedCodexCleanReview({
      author,
      authorType,
      body: event.comment.body,
    });
    if (reviewedCommit !== undefined) {
      const instance = pipelines.getInstanceForSession(ticket.session_id);
      if (!instance || pipelineIsTerminal(instance)) return;
      const liveHeadSha = await fetchGithubPullRequestHeadSha(
        { token: _cfg.githubReadToken },
        event.repository.full_name,
        event.issue.number
      );
      if (instance?.published_commit === liveHeadSha && liveHeadSha.startsWith(reviewedCommit)) {
        routePipelineProviderEvent({
          pipelines,
          store,
          ticket,
          eventId: `github-comment:${event.comment.id}`,
          outcome: "success",
          summary: "Trusted Codex review completed for the current head with no findings.",
          evidence: [event.comment.html_url],
          payload: {
            kind: "issue_comment",
            classification: "codex_clean_review_completion",
            head_sha: liveHeadSha,
          },
          headSha: liveHeadSha,
          receivedAt: control?.receivedAt,
        });
        return;
      }
    }
    if (instance && !pipelineIsTerminal(instance) && inferredHeadSha && _cfg.githubReadToken) {
      const liveHeadSha = githubCommitSha(await fetchGithubPullRequestHeadSha(
        { token: _cfg.githubReadToken },
        event.repository.full_name,
        event.issue.number
      ));
      if (!liveHeadSha) {
        throw new Error("GitHub pull request returned an invalid current head");
      }
      if (liveHeadSha !== inferredHeadSha) {
        const providerObservedAtMs = currentHeadObservation
          ? Date.parse(currentHeadObservation.observedAt)
          : Number.NaN;
        if (currentHeadObservation?.provenance === "provider_event" &&
            currentHeadObservation.headSha === liveHeadSha &&
            !Number.isNaN(commentAtMs) && !Number.isNaN(providerObservedAtMs)) {
          if (providerObservedAtMs < commentAtMs) {
            // A provider-authoritative observation proves the live head was
            // already visible before this comment. Prefer it over a delayed
            // older publication receipt whose local creation time is newer.
            headSha = liveHeadSha;
          } else if (providerObservedAtMs > commentAtMs &&
              latestObservationBeforeComment?.headSha === inferredHeadSha &&
              observedTransitionBeforeComment) {
            // A delayed synchronize/review can arrive after the successor but
            // still append its provider timestamp. A recorded A -> B transition
            // before this comment and C after it binds the comment to B without
            // ever promoting B back to the mutable current projection.
            headSha = inferredHeadSha;
          } else {
            // A later (or same-instant) current-head observation does not prove
            // the inferred predecessor was still current when the comment was
            // created: an intermediate push may have arrived out of order.
            // Persist visible stale evidence instead of retrying to dead-letter
            // or silently carrying the comment onto the live head.
            headSha = `unknown:${ticket.branch}`;
            headOrderingAmbiguous = true;
          }
        } else {
          const projectedHead = githubCommitSha(
            store.getSetting(`github-head:${ticket.ticket_id}`)
          );
          const projectedSource = store.getSetting(`github-head-source:${ticket.ticket_id}`);
          if (projectedSource === "authoritative" && projectedHead === liveHeadSha) {
            // Legacy state may know the live head without a usable timestamp.
            // Its temporal subject is unprovable, but retrying cannot create
            // that missing history, so settle it visibly as ambiguous.
            headSha = `unknown:${ticket.branch}`;
            headOrderingAmbiguous = true;
          } else {
            // A push may be visible through the live PR API before either its
            // synchronize delivery or immutable publish receipt. Persisting the
            // older inferred head would permanently misclassify fresh feedback;
            // leave the webhook retryable until provider ordering is durable.
            throw new Error("GitHub pull-request head transition is not durable yet");
          }
        }
      }
    }
    await activityPublisher.publishActivity({
      sessionId: ticket.session_id,
      type: "action",
      action: "PR comment",
      parameter: author,
      result: event.comment.html_url,
    }, ticket.ticket_id);
    routePipelineProviderEvent({
      pipelines,
      store,
      ticket,
      eventId: `github-comment:${event.comment.id}`,
      outcome: "semantic_repair_required",
      summary: headOrderingAmbiguous
        ? GITHUB_PR_COMMENT_ORDERING_GUIDANCE
        : `GitHub comment from ${author} requires another implementation pass.`,
      evidence: [event.comment.html_url],
      payload: {
        kind: "issue_comment",
        head_sha: headSha,
        ...(headOrderingAmbiguous ? { classification: "head_ordering_ambiguous" } : {}),
      },
      headSha,
      receivedAt: control?.receivedAt,
    });
    return;
  }

  if (event.kind === "issues") {
    const carriesControl = githubIssuesEventCarriesExactControlLabel(event);
    const needsProviderOrdering = event.action === "closed" || carriesControl;
    const sender = event.sender?.login;
    const authorizedActors = new Map<string, Promise<boolean>>();
    if (needsProviderOrdering) {
      if (!sender ||
          !await authorizedGithubControlActor(_cfg, event.repository.full_name, sender)) return;
      authorizedActors.set(sender.toLowerCase(), Promise.resolve(true));
    }
    let historicalActorPermissionLookups = 0;
    const authorizeHistoricalActor = (actorLogin: string): Promise<boolean> => {
      const key = actorLogin.toLowerCase();
      const cached = authorizedActors.get(key);
      if (cached) return cached;
      if (historicalActorPermissionLookups >= GITHUB_HISTORICAL_ACTOR_PERMISSION_LOOKUP_LIMIT) {
        throw new Error("GitHub Issue close authorization exceeded the bounded actor lookup limit");
      }
      historicalActorPermissionLookups += 1;
      const lookup = authorizedGithubControlActor(
        _cfg,
        event.repository.full_name,
        actorLogin
      );
      authorizedActors.set(key, lookup);
      return lookup;
    };
    const eventLifecycle = lifecycleFromIssueEvent(event);
    const priorLifecycle = readGithubIssueLifecycle(
      store,
      event.repository.full_name,
      event.issue.number
    );
    const live = needsProviderOrdering
      ? await fetchGithubIssueLifecycle(
          { token: _cfg.githubReadToken },
          event.repository.full_name,
          event.issue.number
        )
      : undefined;
    const controlEvents = needsProviderOrdering
      ? await fetchGithubIssueControlEvents(
          { token: _cfg.githubReadToken },
          event.repository.full_name,
          event.issue.number
        )
      : [];
    if (event.action === "closed") {
      const eventTimestamp = githubIssueEventTimestamp(event);
      const providerClose = eventTimestamp && sender
        ? [...controlEvents].reverse().find((candidate) =>
            candidate.kind === "closed" &&
            candidate.actorLogin.toLowerCase() === sender.toLowerCase() &&
            Date.parse(candidate.createdAt) === Date.parse(eventTimestamp)
          )
        : undefined;
      if (!providerClose) {
        throw new Error("GitHub Issue close is not yet durable in provider event history");
      }
    }
    const externalThreadId = `${event.repository.full_name}#${event.issue.number}`;
    let ticket = store.getByExternalThread("github", externalThreadId);
    const currentSession = ticket
      ? store.getCurrentSession(ticket.ticket_id) ?? store.getSession(ticket.session_id)
      : undefined;
    let latestAuthorizedClose: GithubIssueControlEventRecord | undefined;
    if (currentSession) {
      for (let index = controlEvents.length - 1; index >= 0; index -= 1) {
        const candidate = controlEvents[index]!;
        if (candidate.kind !== "closed" ||
            !githubIssueControlEventIsAfterSession(
              controlEvents,
              candidate,
              currentSession,
              true
            )) continue;
        if (await authorizeHistoricalActor(candidate.actorLogin)) {
          latestAuthorizedClose = candidate;
          break;
        }
      }
    }
    const latestLifecycleEvent = latestGithubIssueControlEvent(
      controlEvents,
      new Set(["closed", "reopened"])
    );
    const lifecycle = live
      ? recordGithubIssueLifecycle(
          store,
          event.repository.full_name,
          event.issue.number,
          { state: live.state, observedAt: latestLifecycleEvent?.createdAt ?? live.updatedAt },
          true
        )
      : eventLifecycle
        ? recordGithubIssueLifecycle(
            store,
            event.repository.full_name,
            event.issue.number,
            eventLifecycle
          )
        : priorLifecycle;
    const closeCrossesCurrentSession = latestAuthorizedClose !== undefined;
    if (ticket && latestAuthorizedClose) {
      const pipelineInstance = pipelines.getInstanceForSession(ticket.session_id);
      if (pipelineInstance && !pipelineIsTerminal(pipelineInstance)) {
        requestPipelineStop({
          store: pipelines,
          sessionId: ticket.session_id,
          eventId: `github-issue-closed:${pipelineInstance.id}:${latestAuthorizedClose.id}`,
          reason: "GitHub Issue closed while a pipeline stage was active.",
          ticketState: "closed",
        });
      }
      store.setState(ticket.ticket_id, "closed");
      store.markSessionState(ticket.session_id, "stopped");
      store.cancelPendingInbox(ticket.ticket_id);
      await control?.coordinator.drainEffects?.();
      ticket = store.getByExternalThread("github", externalThreadId);
    }
    if (event.action === "closed") {
      // A delayed close older than the current activation must never cancel
      // that successor. If GitHub is currently open, the authoritative event
      // stream still closes the crossed older generation, then leaves the
      // matching reopen delivery to admit its successor.
      return;
    }
    if (!control || !carriesControl) return;
    if (lifecycle?.state === "closed" || live?.state === "closed" ||
        !live || !githubIssueHasExactControlLabel(live.labels)) return;
    if (ticket && !closeCrossesCurrentSession && eventPredatesCurrentSession(
      store,
      ticket,
      githubIssueEventTimestamp(event)
    )) return;
    const providerActivatedAt = githubIssueEventTimestamp(event);
    const activationKind = event.action === "reopened" ? "reopened" : "labeled";
    const providerActivation = providerActivatedAt && sender
      ? [...controlEvents].reverse().find((candidate) =>
          candidate.kind === activationKind &&
          candidate.actorLogin.toLowerCase() === sender.toLowerCase() &&
          Date.parse(candidate.createdAt) === Date.parse(providerActivatedAt)
        )
      : undefined;
    if (!providerActivation) {
      throw new Error("GitHub Issue activation is not yet durable in provider event history");
    }
    const currentProviderActivation = currentGithubIssueActivation(controlEvents);
    if (!currentProviderActivation) {
      throw new Error("GitHub Issue current activation epoch is not yet durable in provider event history");
    }
    if (providerActivation.id !== currentProviderActivation.id) {
      // The signed delivery is authentic but stale: a later provider epoch is
      // already authoritative and its independently authorized webhook owns
      // admission. Never let this delivery borrow that later epoch's cursor.
      return;
    }
    const providerActivationAdvances = Boolean(
      currentSession && providerActivation &&
      githubIssueControlEventIsAfterSession(controlEvents, providerActivation, currentSession, true)
    );
    const sessionId = githubIssueControlSessionId({
      store,
      pipelines,
      event,
      deliveryId: control.deliveryId,
      providerActivationId: providerActivation.id,
    });
    if (!sessionId) return;
    const promptContext = await fetchGithubIssueContext(
        { token: _cfg.githubReadToken },
        event.repository.full_name,
        event.issue.number
      );
    const finalIssuePreflight = githubIssueAdmissionPreflight({
      cfg: _cfg,
      store,
      repository: event.repository.full_name,
      issueNumber: event.issue.number,
      expectedProviderActivation: {
        id: providerActivation.id,
        actorLogin: providerActivation.actorLogin,
      },
      upstream: control.preflight,
    });
    await handleControlEvent(
      _cfg,
      store,
      control.ports,
      githubIssueControlEvent(event, {
        promptContext,
        sessionId,
        ...(providerActivatedAt ? { providerActivatedAt } : {}),
        ...(providerActivation ? { providerActivationId: providerActivation.id } : {}),
        ...(providerActivationAdvances ? { providerActivationAdvances: true } : {}),
        ...(providerActivationAdvances && currentSession?.provider_activation_id
          ? { providerActivationPreviousId: currentSession.provider_activation_id }
          : {}),
      }),
      control.coordinator,
      finalIssuePreflight,
      control.receivedAt
    );
    await control.coordinator.drainEffects?.();
    return;
  }

  // workflow_run / check_suite: mirror every completion to Linear (success and
  // failure alike); a failed/timed-out completion on an active, PR-backed
  // ticket additionally becomes queued feedback work (Phase 1 item 1, new).
  const ci = event.kind === "workflow_run"
    ? {
        branch: event.workflow_run.head_branch,
        conclusion: event.workflow_run.conclusion,
        url: event.workflow_run.html_url,
        headSha: event.workflow_run.head_sha,
        sequence: event.workflow_run.id,
        eventId: `github-workflow:${event.workflow_run.id}`,
        name: event.workflow_run.name,
        workflowRunId: event.workflow_run.id,
      }
    : {
        branch: event.check_suite.head_branch,
        conclusion: event.check_suite.conclusion,
        url: event.check_suite.url,
        headSha: event.check_suite.head_sha,
        sequence: event.check_suite.id,
        eventId: `github-check-suite:${event.check_suite.id}`,
        name: "GitHub check suite",
        workflowRunId: undefined,
      };
  if (!isOpenthrottleBranch(ci.branch) || event.action !== "completed") return;
  const ticket = store.getByBranch(event.repository.full_name, ci.branch);
  if (!ticket) return;
  await activityPublisher.publishActivity({
    sessionId: ticket.session_id,
    type: "action",
    action: "CI completed",
    parameter: ci.conclusion ?? "unknown",
    result: ci.url,
  }, ticket.ticket_id);
  considerCiGithubHead(
    store,
    ticket.ticket_id,
    ci.headSha,
    event.kind,
    ci.sequence
  );

  // A single green workflow/check is not proof that the provider wait has
  // settled: another required check may still be pending. GitHub's merged PR
  // event is the authoritative success boundary. Red checks can immediately
  // re-enter the bounded repair path, while every pipeline CI completion stays
  // out of the deterministic coordinator.
  if (!pipelines.getInstanceForSession(ticket.session_id)) return;
  if (ci.conclusion === "failure" || ci.conclusion === "timed_out") {
    const enrichment = await enrichCiFailure({
      cfg: _cfg,
      repository: event.repository.full_name,
      headSha: ci.headSha,
      workflowRunId: ci.workflowRunId,
      workflowName: ci.name,
    });
    routePipelineProviderEvent({
      pipelines,
      store,
      ticket,
      eventId: ci.eventId,
      outcome: "semantic_repair_required",
      summary: enrichment.note === null
        ? `${ci.name} concluded ${ci.conclusion}.`
        : `${ci.name} concluded ${ci.conclusion}. ${enrichment.note}`,
      evidence: [
        ci.url,
        ...enrichment.failures
          .map((failure) => failure.html_url)
          .filter((url): url is string => typeof url === "string" && url.length > 0),
      ],
      findings: enrichment.findings,
      payload: {
        kind: event.kind,
        conclusion: ci.conclusion,
        head_sha: ci.headSha,
        url: ci.url,
        failures: enrichment.failures,
        findings: enrichment.findings,
        ...(enrichment.note === null ? {} : { enrichment_note: enrichment.note }),
      },
      headSha: ci.headSha,
      receivedAt: control?.receivedAt,
    });
  }
}
