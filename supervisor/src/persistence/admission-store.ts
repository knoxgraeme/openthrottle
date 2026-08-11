import type Database from "better-sqlite3";
import type { PipelineStore } from "../pipeline/store.js";
import type {
  AgentSession,
  RepositoryRegistration,
  RepositoryRegistrationInput,
  Ticket,
  TicketState,
  TicketUpsert,
} from "./store.js";

export interface AdmissionStore {
  upsert(ticket: TicketUpsert): void;
  upsertUnpinned(ticket: Omit<TicketUpsert, "pipeline">): void;
  getByIssueId(issueId: string): Ticket | undefined;
  getByExternalThread(provider: Ticket["control_provider"], externalThreadId: string): Ticket | undefined;
  getByIdentifier(identifier: string): Ticket | undefined;
  getByBranch(repo: string, branch: string): Ticket | undefined;
  getByPrUrl(repo: string, prUrl: string): Ticket | undefined;
  getBySandboxId(sandboxId: string): Ticket | undefined;
  setSandboxId(issueId: string, sandboxId: string | null): void;
  setState(issueId: string, state: TicketState, lastError?: string): void;
  setPrUrl(issueId: string, prUrl: string): void;
  listAll(): Ticket[];
  getCurrentSession(issueId: string): AgentSession | undefined;
  getSession(sessionId: string): AgentSession | undefined;
  markSessionState(sessionId: string, state: AgentSession["state"]): void;
  registerRepository(input: RepositoryRegistrationInput): RepositoryRegistration;
  getRepositoryRegistration(
    teamId?: string,
    teamKey?: string,
    controlProvider?: RepositoryRegistration["control_provider"]
  ): RepositoryRegistration | undefined;
  listRepositoryRegistrations(): RepositoryRegistration[];
}

export function createAdmissionStore(
  db: Database.Database,
  pipelineStore: Pick<PipelineStore, "createInstance" | "supersedeOtherInstances">
): AdmissionStore {
  const now = () => new Date().toISOString();
  const upsertStmt = db.prepare(`
    INSERT INTO tickets (
      ticket_id, ticket_reference, session_id, control_provider,
      external_thread_id, external_thread_reference,
      sandbox_id, branch, agent, repo, pr_url, state, base_branch, created_at, updated_at
    ) VALUES (
      @ticket_id, @ticket_reference, @session_id, @control_provider,
      @external_thread_id, @external_thread_reference,
      @sandbox_id, @branch, @agent, @repo, @pr_url, @state, @base_branch, @created_at, @updated_at
    )
    ON CONFLICT(ticket_id) DO UPDATE SET
      ticket_reference = excluded.ticket_reference,
      session_id = excluded.session_id,
      external_thread_id = excluded.external_thread_id,
      external_thread_reference = excluded.external_thread_reference,
      sandbox_id = excluded.sandbox_id,
      branch = excluded.branch,
      agent = excluded.agent,
      repo = excluded.repo,
      pr_url = excluded.pr_url,
      state = excluded.state,
      base_branch = excluded.base_branch,
      updated_at = excluded.updated_at
  `);
  const getByIssueIdStmt = db.prepare("SELECT * FROM tickets WHERE ticket_id = ?");
  const getByExternalThreadStmt = db.prepare(
    "SELECT * FROM tickets WHERE control_provider = ? AND external_thread_id = ?"
  );
  const getByIdentifierStmt = db.prepare(
    "SELECT * FROM tickets WHERE lower(ticket_reference) = lower(?) ORDER BY created_at, ticket_id"
  );
  const getByBranchStmt = db.prepare("SELECT * FROM tickets WHERE repo = ? AND branch = ?");
  const getByPrUrlStmt = db.prepare(
    "SELECT * FROM tickets WHERE lower(repo) = lower(?) AND lower(pr_url) = lower(?)"
  );
  const getBySandboxIdStmt = db.prepare("SELECT * FROM tickets WHERE sandbox_id = ?");
  const setSandboxIdStmt = db.prepare(
    "UPDATE tickets SET sandbox_id = ?, updated_at = ? WHERE ticket_id = ?"
  );
  const setStateStmt = db.prepare(
    "UPDATE tickets SET state = ?, last_error = ?, updated_at = ? WHERE ticket_id = ?"
  );
  const setPrUrlStmt = db.prepare(
    "UPDATE tickets SET pr_url = ?, updated_at = ? WHERE ticket_id = ?"
  );
  const listAllStmt = db.prepare("SELECT * FROM tickets ORDER BY created_at DESC");
  const getRepositoryByTeamIdStmt = db.prepare(
    "SELECT * FROM repository_registrations WHERE linear_team_id = ?"
  );
  const getRepositoryByTeamKeyStmt = db.prepare(
    "SELECT * FROM repository_registrations WHERE lower(linear_team_key) = lower(?)"
  );
  const listRepositoryRegistrationsStmt = db.prepare(
    "SELECT * FROM repository_registrations ORDER BY github_repo"
  );
  const getRepositoryByRepoStmt = db.prepare(
    "SELECT * FROM repository_registrations WHERE lower(github_repo) = lower(?)"
  );
  const upsertRepositoryRegistrationStmt = db.prepare(`
    INSERT INTO repository_registrations (
      github_repo, control_provider, linear_team_key, linear_team_id, base_branch,
      webhook_id, snapshot, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(github_repo) DO UPDATE SET
      linear_team_key = excluded.linear_team_key,
      linear_team_id = excluded.linear_team_id,
      base_branch = excluded.base_branch,
      webhook_id = excluded.webhook_id,
      snapshot = excluded.snapshot,
      updated_at = excluded.updated_at
    WHERE repository_registrations.control_provider = excluded.control_provider
  `);
  const getCurrentSessionStmt = db.prepare(
    "SELECT * FROM agent_sessions WHERE ticket_id = ? AND state = 'current'"
  );
  const getSessionStmt = db.prepare("SELECT * FROM agent_sessions WHERE id = ?");
  const maxSessionGenerationStmt = db.prepare(
    "SELECT COALESCE(MAX(generation), 0) AS generation FROM agent_sessions WHERE ticket_id = ?"
  );
  const insertSessionStmt = db.prepare(`
    INSERT OR IGNORE INTO agent_sessions (
      id, ticket_id, generation, state, created_at, updated_at
    ) VALUES (?, ?, ?, 'current', ?, ?)
  `);
  const supersedeSessionStmt = db.prepare(`
    UPDATE agent_sessions
    SET state = 'superseded', superseded_at = ?, updated_at = ?
    WHERE ticket_id = ? AND state = 'current' AND id <> ?
  `);
  const markSessionStateStmt = db.prepare(
    "UPDATE agent_sessions SET state = ?, updated_at = ? WHERE id = ?"
  );
  const supersedeCurrentSessionTransaction = db.transaction(
    (issueId: string, newSessionId: string): AgentSession => {
      const timestamp = now();
      const existing = getSessionStmt.get(newSessionId) as AgentSession | undefined;
      if (existing) {
        supersedeSessionStmt.run(timestamp, timestamp, issueId, newSessionId);
        markSessionStateStmt.run("current", timestamp, newSessionId);
        return getSessionStmt.get(newSessionId) as AgentSession;
      }
      const generation =
        ((maxSessionGenerationStmt.get(issueId) as { generation: number } | undefined)
          ?.generation ?? 0) + 1;
      supersedeSessionStmt.run(timestamp, timestamp, issueId, newSessionId);
      insertSessionStmt.run(newSessionId, issueId, generation, timestamp, timestamp);
      return getSessionStmt.get(newSessionId) as AgentSession;
    }
  );
  const registerRepositoryTransaction = db.transaction(
    (input: RepositoryRegistrationInput): RepositoryRegistration => {
      const timestamp = now();
      const controlProvider = input.controlProvider ?? "linear";
      if (controlProvider === "linear" && !input.linearTeamKey) {
        throw new Error("Linear repository registration requires a Linear team key");
      }
      const existing = getRepositoryByRepoStmt.get(input.githubRepo) as
        | RepositoryRegistration
        | undefined;
      if (existing && existing.control_provider !== controlProvider) {
        throw new Error(
          `Repository ${input.githubRepo} is already registered for ${existing.control_provider} control`
        );
      }
      if (controlProvider === "linear") {
        const byKey = input.linearTeamKey
          ? (getRepositoryByTeamKeyStmt.get(input.linearTeamKey) as RepositoryRegistration | undefined)
          : undefined;
        const byId = input.linearTeamId
          ? (getRepositoryByTeamIdStmt.get(input.linearTeamId) as RepositoryRegistration | undefined)
          : undefined;
        for (const route of [byKey, byId]) {
          if (route && route.github_repo.toLowerCase() !== input.githubRepo.toLowerCase()) {
            throw new Error(
              `Linear route is already registered for ${route.github_repo}; refusing to transfer authority to ${input.githubRepo}`
            );
          }
        }
      }
      upsertRepositoryRegistrationStmt.run(
        input.githubRepo,
        controlProvider,
        input.linearTeamKey ?? null,
        input.linearTeamId ?? null,
        input.baseBranch,
        input.webhookId,
        input.snapshot,
        existing?.created_at ?? timestamp,
        timestamp
      );
      return getRepositoryByRepoStmt.get(input.githubRepo) as RepositoryRegistration;
    }
  );
  return {
    upsert(ticket) {
      const existing = getByIssueIdStmt.get(ticket.ticket_id) as Ticket | undefined;
      db.transaction(() => {
        const { pipeline, ...ticketRow } = ticket;
        upsertStmt.run({
          ...ticketRow,
          control_provider: ticket.control_provider ?? existing?.control_provider ?? "linear",
          external_thread_id: ticket.external_thread_id ?? existing?.external_thread_id ?? ticket.ticket_id,
          external_thread_reference: ticket.external_thread_reference ?? existing?.external_thread_reference ?? ticket.ticket_reference,
          base_branch: ticket.base_branch ?? existing?.base_branch ?? "main",
          created_at: existing?.created_at ?? now(),
          updated_at: now(),
        });
        const session = supersedeCurrentSessionTransaction(
          ticket.ticket_id,
          ticket.session_id
        );
        pipelineStore.supersedeOtherInstances(ticket.ticket_id, ticket.session_id);
        if (pipeline) {
          pipelineStore.createInstance({
            ...pipeline,
            issueId: ticket.ticket_id,
            sessionId: ticket.session_id,
            generation: session.generation,
            branch: ticket.branch,
            agent: ticket.agent,
          });
        }
      })();
    },
    upsertUnpinned(ticket) {
      const existing = getByIssueIdStmt.get(ticket.ticket_id) as Ticket | undefined;
      db.transaction(() => {
        upsertStmt.run({
          ...ticket,
          control_provider: ticket.control_provider ?? existing?.control_provider ?? "linear",
          external_thread_id: ticket.external_thread_id ?? existing?.external_thread_id ?? ticket.ticket_id,
          external_thread_reference: ticket.external_thread_reference ?? existing?.external_thread_reference ?? ticket.ticket_reference,
          base_branch: ticket.base_branch ?? existing?.base_branch ?? "main",
          created_at: existing?.created_at ?? now(),
          updated_at: now(),
        });
        supersedeCurrentSessionTransaction(ticket.ticket_id, ticket.session_id);
        pipelineStore.supersedeOtherInstances(ticket.ticket_id, ticket.session_id);
      })();
    },
    getByIssueId(issueId) {
      return getByIssueIdStmt.get(issueId) as Ticket | undefined;
    },
    getByExternalThread(provider, externalThreadId) {
      return getByExternalThreadStmt.get(provider, externalThreadId) as Ticket | undefined;
    },
    getByIdentifier(identifier) {
      const matches = getByIdentifierStmt.all(identifier) as Ticket[];
      return matches.length === 1 ? matches[0] : undefined;
    },
    getByBranch(repo, branch) {
      return getByBranchStmt.get(repo, branch) as Ticket | undefined;
    },
    getByPrUrl(repo, prUrl) {
      return getByPrUrlStmt.get(repo, prUrl) as Ticket | undefined;
    },
    getBySandboxId(sandboxId) {
      return getBySandboxIdStmt.get(sandboxId) as Ticket | undefined;
    },
    setSandboxId(issueId, sandboxId) {
      setSandboxIdStmt.run(sandboxId, now(), issueId);
    },
    setState(issueId, state, lastError) {
      setStateStmt.run(state, lastError ?? null, now(), issueId);
    },
    setPrUrl(issueId, prUrl) {
      setPrUrlStmt.run(prUrl, now(), issueId);
    },
    listAll() {
      return listAllStmt.all() as Ticket[];
    },
    getCurrentSession(issueId) {
      return getCurrentSessionStmt.get(issueId) as AgentSession | undefined;
    },
    getSession(sessionId) {
      return getSessionStmt.get(sessionId) as AgentSession | undefined;
    },
    markSessionState(sessionId, state) {
      markSessionStateStmt.run(state, now(), sessionId);
    },
    registerRepository(input) {
      return registerRepositoryTransaction(input);
    },
    getRepositoryRegistration(teamId, teamKey, controlProvider = "linear") {
      if (teamId) {
        const byId = getRepositoryByTeamIdStmt.get(teamId) as RepositoryRegistration | undefined;
        if (byId?.control_provider === controlProvider) return byId;
      }
      const byKey = teamKey
        ? (getRepositoryByTeamKeyStmt.get(teamKey) as RepositoryRegistration | undefined)
        : undefined;
      return byKey?.control_provider === controlProvider ? byKey : undefined;
    },
    listRepositoryRegistrations() {
      return listRepositoryRegistrationsStmt.all() as RepositoryRegistration[];
    },
  };
}
