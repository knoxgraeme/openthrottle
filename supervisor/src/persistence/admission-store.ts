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
  getByIdentifier(identifier: string): Ticket | undefined;
  getByBranch(repo: string, branch: string): Ticket | undefined;
  getByPrUrl(repo: string, prUrl: string): Ticket | undefined;
  getBySandboxId(sandboxId: string): Ticket | undefined;
  setSandboxId(issueId: string, sandboxId: string | null): void;
  setState(issueId: string, state: TicketState, lastError?: string): void;
  setPrUrl(issueId: string, prUrl: string): void;
  setLinearContext(issueId: string, context: string): void;
  listAll(): Ticket[];
  getCurrentSession(issueId: string): AgentSession | undefined;
  getSession(sessionId: string): AgentSession | undefined;
  markSessionState(sessionId: string, state: AgentSession["state"]): void;
  registerRepository(input: RepositoryRegistrationInput): RepositoryRegistration;
  getRepositoryRegistration(teamId?: string, teamKey?: string): RepositoryRegistration | undefined;
  listRepositoryRegistrations(): RepositoryRegistration[];
}

export function createAdmissionStore(
  db: Database.Database,
  pipelineStore: Pick<PipelineStore, "createInstance" | "supersedeOtherInstances">
): AdmissionStore {
  const now = () => new Date().toISOString();
  const upsertStmt = db.prepare(`
    INSERT INTO tickets (
      linear_issue_id, linear_issue_identifier, linear_session_id,
      sandbox_id, branch, agent, repo, pr_url, state, base_branch, created_at, updated_at
    ) VALUES (
      @linear_issue_id, @linear_issue_identifier, @linear_session_id,
      @sandbox_id, @branch, @agent, @repo, @pr_url, @state, @base_branch, @created_at, @updated_at
    )
    ON CONFLICT(linear_issue_id) DO UPDATE SET
      linear_issue_identifier = excluded.linear_issue_identifier,
      linear_session_id = excluded.linear_session_id,
      sandbox_id = excluded.sandbox_id,
      branch = excluded.branch,
      agent = excluded.agent,
      repo = excluded.repo,
      pr_url = excluded.pr_url,
      state = excluded.state,
      base_branch = excluded.base_branch,
      updated_at = excluded.updated_at
  `);
  const getByIssueIdStmt = db.prepare("SELECT * FROM tickets WHERE linear_issue_id = ?");
  const getByIdentifierStmt = db.prepare(
    "SELECT * FROM tickets WHERE lower(linear_issue_identifier) = lower(?)"
  );
  const getByBranchStmt = db.prepare("SELECT * FROM tickets WHERE repo = ? AND branch = ?");
  const getByPrUrlStmt = db.prepare(
    "SELECT * FROM tickets WHERE lower(repo) = lower(?) AND lower(pr_url) = lower(?)"
  );
  const getBySandboxIdStmt = db.prepare("SELECT * FROM tickets WHERE sandbox_id = ?");
  const setSandboxIdStmt = db.prepare(
    "UPDATE tickets SET sandbox_id = ?, updated_at = ? WHERE linear_issue_id = ?"
  );
  const setStateStmt = db.prepare(
    "UPDATE tickets SET state = ?, last_error = ?, updated_at = ? WHERE linear_issue_id = ?"
  );
  const setPrUrlStmt = db.prepare(
    "UPDATE tickets SET pr_url = ?, updated_at = ? WHERE linear_issue_id = ?"
  );
  const setLinearContextStmt = db.prepare(
    "UPDATE tickets SET linear_context = ?, updated_at = ? WHERE linear_issue_id = ?"
  );
  const listAllStmt = db.prepare("SELECT * FROM tickets ORDER BY created_at DESC");
  const getRepositoryByTeamIdStmt = db.prepare(
    "SELECT * FROM repository_registrations WHERE linear_team_id = ?"
  );
  const getRepositoryByTeamKeyStmt = db.prepare(
    "SELECT * FROM repository_registrations WHERE lower(linear_team_key) = lower(?)"
  );
  const listRepositoryRegistrationsStmt = db.prepare(
    "SELECT * FROM repository_registrations ORDER BY linear_team_key"
  );
  const upsertRepositoryRegistrationStmt = db.prepare(`
    INSERT INTO repository_registrations (
      linear_team_key, linear_team_id, github_repo, base_branch,
      webhook_id, snapshot, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(linear_team_key) DO UPDATE SET
      linear_team_id = excluded.linear_team_id,
      github_repo = excluded.github_repo,
      base_branch = excluded.base_branch,
      webhook_id = excluded.webhook_id,
      snapshot = excluded.snapshot,
      updated_at = excluded.updated_at
  `);
  const getCurrentSessionStmt = db.prepare(
    "SELECT * FROM agent_sessions WHERE linear_issue_id = ? AND state = 'current'"
  );
  const getSessionStmt = db.prepare("SELECT * FROM agent_sessions WHERE id = ?");
  const maxSessionGenerationStmt = db.prepare(
    "SELECT COALESCE(MAX(generation), 0) AS generation FROM agent_sessions WHERE linear_issue_id = ?"
  );
  const insertSessionStmt = db.prepare(`
    INSERT OR IGNORE INTO agent_sessions (
      id, linear_issue_id, generation, state, created_at, updated_at
    ) VALUES (?, ?, ?, 'current', ?, ?)
  `);
  const supersedeSessionStmt = db.prepare(`
    UPDATE agent_sessions
    SET state = 'superseded', superseded_at = ?, updated_at = ?
    WHERE linear_issue_id = ? AND state = 'current' AND id <> ?
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
      const existing = getRepositoryByTeamKeyStmt.get(input.linearTeamKey) as
        | RepositoryRegistration
        | undefined;
      if (input.linearTeamId) {
        db.prepare(`
          DELETE FROM repository_registrations
          WHERE linear_team_id = ? AND lower(linear_team_key) <> lower(?)
        `).run(input.linearTeamId, input.linearTeamKey);
      }
      upsertRepositoryRegistrationStmt.run(
        input.linearTeamKey,
        input.linearTeamId ?? null,
        input.githubRepo,
        input.baseBranch,
        input.webhookId,
        input.snapshot,
        existing?.created_at ?? timestamp,
        timestamp
      );
      return getRepositoryByTeamKeyStmt.get(input.linearTeamKey) as RepositoryRegistration;
    }
  );
  return {
    upsert(ticket) {
      const existing = getByIssueIdStmt.get(ticket.linear_issue_id) as Ticket | undefined;
      db.transaction(() => {
        const { pipeline, ...ticketRow } = ticket;
        upsertStmt.run({
          ...ticketRow,
          base_branch: ticket.base_branch ?? existing?.base_branch ?? "main",
          created_at: existing?.created_at ?? now(),
          updated_at: now(),
        });
        const session = supersedeCurrentSessionTransaction(
          ticket.linear_issue_id,
          ticket.linear_session_id
        );
        pipelineStore.supersedeOtherInstances(ticket.linear_issue_id, ticket.linear_session_id);
        if (pipeline) {
          pipelineStore.createInstance({
            ...pipeline,
            issueId: ticket.linear_issue_id,
            sessionId: ticket.linear_session_id,
            generation: session.generation,
            branch: ticket.branch,
            agent: ticket.agent,
          });
        }
      })();
    },
    upsertUnpinned(ticket) {
      const existing = getByIssueIdStmt.get(ticket.linear_issue_id) as Ticket | undefined;
      db.transaction(() => {
        upsertStmt.run({
          ...ticket,
          base_branch: ticket.base_branch ?? existing?.base_branch ?? "main",
          created_at: existing?.created_at ?? now(),
          updated_at: now(),
        });
        supersedeCurrentSessionTransaction(ticket.linear_issue_id, ticket.linear_session_id);
        pipelineStore.supersedeOtherInstances(ticket.linear_issue_id, ticket.linear_session_id);
      })();
    },
    getByIssueId(issueId) {
      return getByIssueIdStmt.get(issueId) as Ticket | undefined;
    },
    getByIdentifier(identifier) {
      return getByIdentifierStmt.get(identifier) as Ticket | undefined;
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
    setLinearContext(issueId, context) {
      setLinearContextStmt.run(context, now(), issueId);
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
    getRepositoryRegistration(teamId, teamKey) {
      if (teamId) {
        const byId = getRepositoryByTeamIdStmt.get(teamId) as RepositoryRegistration | undefined;
        if (byId) return byId;
      }
      return teamKey
        ? (getRepositoryByTeamKeyStmt.get(teamKey) as RepositoryRegistration | undefined)
        : undefined;
    },
    listRepositoryRegistrations() {
      return listRepositoryRegistrationsStmt.all() as RepositoryRegistration[];
    },
  };
}
