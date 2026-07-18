import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Schema verbatim from docs/SPEC.md "Supervisor contract > DB schema".
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  linear_issue_id TEXT PRIMARY KEY,
  linear_issue_identifier TEXT NOT NULL,   -- e.g. ENG-123
  linear_session_id TEXT NOT NULL,
  sandbox_id TEXT,
  branch TEXT NOT NULL,                    -- ot/eng-123
  agent TEXT NOT NULL DEFAULT 'claude',    -- claude | codex
  repo TEXT NOT NULL,                      -- owner/name
  pr_url TEXT,
  state TEXT NOT NULL DEFAULT 'active',    -- active | closed | expired | error
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

export type Agent = "claude" | "codex";
export type TicketState = "active" | "closed" | "expired" | "error";

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
  created_at: string;
  updated_at: string;
}

export function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

export interface TicketStore {
  db: Database.Database;
  upsert(t: Omit<Ticket, "created_at" | "updated_at">): void;
  getByIssueId(issueId: string): Ticket | undefined;
  getByBranch(branch: string): Ticket | undefined;
  getBySandboxId(sandboxId: string): Ticket | undefined;
  setSandboxId(issueId: string, sandboxId: string): void;
  setState(issueId: string, state: TicketState): void;
  setPrUrl(issueId: string, prUrl: string): void;
  listActive(): Ticket[];
  listAll(): Ticket[];
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
}

export function createTicketStore(db: Database.Database): TicketStore {
  const now = () => new Date().toISOString();

  const upsertStmt = db.prepare(`
    INSERT INTO tickets (
      linear_issue_id, linear_issue_identifier, linear_session_id,
      sandbox_id, branch, agent, repo, pr_url, state, created_at, updated_at
    ) VALUES (
      @linear_issue_id, @linear_issue_identifier, @linear_session_id,
      @sandbox_id, @branch, @agent, @repo, @pr_url, @state, @created_at, @updated_at
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
      updated_at = excluded.updated_at
  `);

  const getByIssueIdStmt = db.prepare(
    `SELECT * FROM tickets WHERE linear_issue_id = ?`
  );
  const getByBranchStmt = db.prepare(`SELECT * FROM tickets WHERE branch = ?`);
  const getBySandboxIdStmt = db.prepare(
    `SELECT * FROM tickets WHERE sandbox_id = ?`
  );
  const setSandboxIdStmt = db.prepare(
    `UPDATE tickets SET sandbox_id = ?, updated_at = ? WHERE linear_issue_id = ?`
  );
  const setStateStmt = db.prepare(
    `UPDATE tickets SET state = ?, updated_at = ? WHERE linear_issue_id = ?`
  );
  const setPrUrlStmt = db.prepare(
    `UPDATE tickets SET pr_url = ?, updated_at = ? WHERE linear_issue_id = ?`
  );
  const listActiveStmt = db.prepare(
    `SELECT * FROM tickets WHERE state = 'active'`
  );
  const listAllStmt = db.prepare(`SELECT * FROM tickets ORDER BY created_at DESC`);
  const getSettingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
  const setSettingStmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );

  return {
    db,
    upsert(t) {
      const existing = getByIssueIdStmt.get(t.linear_issue_id) as
        | Ticket
        | undefined;
      upsertStmt.run({
        ...t,
        created_at: existing?.created_at ?? now(),
        updated_at: now(),
      });
    },
    getByIssueId(issueId) {
      return getByIssueIdStmt.get(issueId) as Ticket | undefined;
    },
    getByBranch(branch) {
      return getByBranchStmt.get(branch) as Ticket | undefined;
    },
    getBySandboxId(sandboxId) {
      return getBySandboxIdStmt.get(sandboxId) as Ticket | undefined;
    },
    setSandboxId(issueId, sandboxId) {
      setSandboxIdStmt.run(sandboxId, now(), issueId);
    },
    setState(issueId, state) {
      setStateStmt.run(state, now(), issueId);
    },
    setPrUrl(issueId, prUrl) {
      setPrUrlStmt.run(prUrl, now(), issueId);
    },
    listActive() {
      return listActiveStmt.all() as Ticket[];
    },
    listAll() {
      return listAllStmt.all() as Ticket[];
    },
    getSetting(key) {
      const row = getSettingStmt.get(key) as { value: string } | undefined;
      return row?.value;
    },
    setSetting(key, value) {
      setSettingStmt.run(key, value);
    },
  };
}
