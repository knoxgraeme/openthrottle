import type { GithubClient } from "./client.js";
import {
  parsePullRequestUrl,
  pinIssueComment,
  pipelineSummaryCommentMarker,
  upsertIssueStatusComment,
  upsertPullRequestComment,
} from "./client.js";
import {
  beginGithubSupervisorCommentWrite,
  settleGithubSupervisorCommentWrite,
} from "./comment-provenance.js";
import {
  pipelineStatusCommentMarker,
  parsePipelinePublication,
  renderGithubIssueStatusComment,
  renderGithubPipelineSummary,
} from "../../pipeline/publication.js";
import type { PipelinePublicationReceipt, PipelineStore } from "../../pipeline/store.js";
import { pipelineIsTerminal } from "../../app/provider-feedback.js";
import { classifyPermanentFailure, exponentialBackoffDelayMs } from "../../shared/backoff.js";

export interface GithubPublicationProcessor {
  process(id: string): Promise<void>;
  drain(limit?: number): Promise<void>;
}

interface GithubPublicationTicket {
  session_id: string;
  control_provider: "linear" | "github";
  external_thread_id: string;
  pr_url: string | null;
}

interface GithubPublicationTicketStore {
  getByIssueId(issueId: string): GithubPublicationTicket | undefined;
  acquireSupervisorLease(
    name: string,
    owner: string,
    nowIso: string,
    leaseUntilIso: string
  ): boolean;
  releaseSupervisorLease(name: string, owner: string): boolean;
  setSetting(key: string, value: string): void;
}

interface GithubIssueTarget {
  number: number;
  url: string;
}

function githubIssueTargetForTicket(
  ticket: GithubPublicationTicket | undefined,
  repository: string
): GithubIssueTarget | undefined {
  if (ticket?.control_provider !== "github") return undefined;
  const match = ticket.external_thread_id.match(/^(.+)#(\d+)$/);
  if (!match || match[1].toLowerCase() !== repository.toLowerCase()) return undefined;
  const issueNumber = Number(match[2]);
  return Number.isSafeInteger(issueNumber) && issueNumber > 0
    ? { number: issueNumber, url: `https://github.com/${repository}/issues/${issueNumber}` }
    : undefined;
}

function githubRetry(error: unknown): { retry: boolean; message: string } {
  return classifyPermanentFailure(
    error,
    /unauthorized|forbidden|invalid|API error \((?:400|401|403|404|422)\)/i
  );
}

export function createGithubPublicationProcessor(params: {
  store: PipelineStore;
  tickets: GithubPublicationTicketStore;
  client: GithubClient;
  leaseMs?: number;
}): GithubPublicationProcessor {
  const leaseMs = params.leaseMs ?? 30_000;

  async function deliver(publication: PipelinePublicationReceipt): Promise<void> {
    const instance = params.store.getInstance(publication.pipeline_instance_id);
    if (!instance) throw new Error(`unknown pipeline instance ${publication.pipeline_instance_id}`);
    const ticket = params.tickets.getByIssueId(instance.ticket_id);
    if (ticket && ticket.session_id !== instance.session_id) {
      throw new Error("pipeline publication no longer has its original session binding");
    }
    const issueTarget = githubIssueTargetForTicket(ticket, instance.repository);
    let bound = publication;
    if (!bound.target_url) {
      if (issueTarget) {
        const persisted = params.store.bindGithubPublicationTarget(
          publication.id,
          publication.payload_hash,
          issueTarget.url
        );
        if (!persisted) throw new Error("pipeline publication target binding is stale");
        bound = persisted;
      } else if (!ticket?.pr_url) {
        if (pipelineIsTerminal(instance)) {
          if (!params.store.markGithubPublicationSkipped(publication.id, publication.payload_hash)) {
            throw new Error("terminal pipeline publication changed before it could be skipped");
          }
          return;
        }
        throw new Error("pipeline pull request is not available yet");
      } else {
        const persisted = params.store.bindGithubPublicationTarget(
          publication.id,
          publication.payload_hash,
          ticket.pr_url
        );
        if (!persisted) throw new Error("pipeline publication target binding is stale");
        bound = persisted;
      }
    }
    const current = params.store.getPublication(publication.id);
    if (!current || current.pipeline_instance_id !== publication.pipeline_instance_id ||
        current.payload_hash !== publication.payload_hash || current.status !== "processing" ||
        current.target_url !== bound.target_url) {
      throw new Error("pipeline publication changed before delivery");
    }
    const envelope = parsePipelinePublication(publication.payload);
    let result: { id: number; html_url: string };
    if (issueTarget && bound.target_url === issueTarget.url) {
      const marker = pipelineStatusCommentMarker(instance.ticket_id);
      const writeIntent = beginGithubSupervisorCommentWrite(
        params.tickets,
        instance.repository,
        issueTarget.number,
        marker
      );
      result = await upsertIssueStatusComment(
        params.client,
        instance.repository,
        issueTarget.number,
        marker,
        renderGithubIssueStatusComment(envelope, ticket?.pr_url)
      );
      // Persist exact output provenance before pinning or acknowledging the
      // publication. Webhook delivery can race either later operation; an
      // author/type or marker heuristic would let unrelated bots suppress
      // genuine feedback by copying machine-looking text.
      params.tickets.setSetting(`github-supervisor-comment:${result.id}`, "pipeline-status");
      settleGithubSupervisorCommentWrite(
        params.tickets,
        writeIntent,
        result.id
      );
      await pinIssueComment(params.client, instance.repository, result.id);
    } else {
      const pull = parsePullRequestUrl(bound.target_url!);
      if (pull.host !== "github.com" || pull.repo.toLowerCase() !== instance.repository.toLowerCase()) {
        throw new Error("invalid pipeline pull request binding for the pinned instance");
      }
      const marker = pipelineSummaryCommentMarker(instance.ticket_id);
      const writeIntent = beginGithubSupervisorCommentWrite(
        params.tickets,
        instance.repository,
        pull.number,
        marker
      );
      result = await upsertPullRequestComment(
        params.client,
        instance.repository,
        pull.number,
        instance.ticket_id,
        renderGithubPipelineSummary(envelope, bound.target_url)
      );
      params.tickets.setSetting(`github-supervisor-comment:${result.id}`, "pipeline-summary");
      settleGithubSupervisorCommentWrite(
        params.tickets,
        writeIntent,
        result.id
      );
    }
    const processed = params.store.markGithubPublicationProcessed(
      publication.id,
      publication.payload_hash,
      String(result.id),
      result.html_url
    );
    if (!processed) {
      const latest = params.store.getPublication(publication.id);
      if (latest?.payload_hash !== publication.payload_hash && params.store.requeueGithubPublicationAfterStaleWrite(
        publication.id,
        publication.payload_hash,
        String(result.id),
        result.html_url
      )) {
        return;
      }
      if (latest?.status === "processing" && latest.payload_hash === publication.payload_hash) {
        params.store.markGithubPublicationFailed(
          publication.id,
          publication.payload_hash,
          "GitHub summary acknowledgement CAS failed after comment upsert; manual reconciliation required.",
          null
        );
      }
    }
  }

  async function processRows(rows: PipelinePublicationReceipt[]): Promise<void> {
    for (const publication of rows) {
      try {
        await deliver(publication);
      } catch (error) {
        const classified = githubRetry(error);
        params.store.markGithubPublicationFailed(
          publication.id,
          publication.payload_hash,
          classified.message,
          classified.retry
            ? new Date(Date.now() + exponentialBackoffDelayMs(publication.attempts)).toISOString()
            : null
        );
      }
    }
  }

  return {
    async process(id) {
      const now = new Date();
      const rows = params.store.claimGithubPublications(
        now.toISOString(),
        new Date(now.getTime() + leaseMs).toISOString(),
        50
      );
      if (!rows.some((row) => row.id === id)) return;
      await processRows(rows);
    },
    async drain(limit = 50) {
      const now = new Date();
      await processRows(params.store.claimGithubPublications(
        now.toISOString(),
        new Date(now.getTime() + leaseMs).toISOString(),
        limit
      ));
    },
  };
}
