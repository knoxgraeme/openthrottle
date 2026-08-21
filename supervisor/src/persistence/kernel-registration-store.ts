import type Database from "better-sqlite3";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TEAM_KEY = /^[A-Za-z0-9_-]+$/;

export interface KernelRepositoryRegistration {
  id: string;
  control_provider: "linear" | "github";
  route_key: string;
  linear_team_id: string | null;
  linear_team_key: string | null;
  github_repo: string;
  github_installation_id: number | null;
  base_branch: string;
  webhook_id: number | null;
  runtime_snapshot: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface KernelRepositoryRegistrationInput {
  id: string;
  control_provider: "linear" | "github";
  linear_team_id: string | null;
  linear_team_key: string | null;
  github_repo: string;
  github_installation_id: number | null;
  base_branch: string;
  webhook_id: number | null;
  runtime_snapshot: string;
  expected_version?: number;
}

export interface KernelRunReference {
  pipeline_run_id: string;
  work_item_id: string;
  source_provider: string;
  source_reference: string;
}

export interface KernelRunReferencePort {
  resolveRun(reference: string): KernelRunReference | undefined;
}

export interface KernelRepositoryRegistrationPort extends KernelRunReferencePort {
  put(input: KernelRepositoryRegistrationInput): {
    disposition: "inserted" | "unchanged" | "updated";
    registration: KernelRepositoryRegistration;
  };
  list(): readonly KernelRepositoryRegistration[];
  findLinearRoute(input: {
    team_id?: string;
    team_key?: string;
  }): KernelRepositoryRegistration | undefined;
  findGithubRoute(repository: string): KernelRepositoryRegistration | undefined;
}

function bounded(value: string, name: string, maximum: number, pattern?: RegExp): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > maximum ||
    value.includes("\0") || (pattern !== undefined && !pattern.test(value))
  ) throw new Error(`${name} is invalid`);
  return value;
}

function positiveInteger(value: number | null, name: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer or null`);
  return value;
}

function safeBranch(value: string): string {
  bounded(value, "repository base branch", 300);
  if (
    value === "@" || /^[./-]|[/.]$/.test(value) ||
    /\.\.|@\{|\/\/|[~^:?*\[\\\s]/.test(value) ||
    value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) throw new Error("repository base branch is unsafe");
  return value;
}

function iso(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("registration timestamp must be canonical ISO");
  }
  return value;
}

function normalized(input: KernelRepositoryRegistrationInput): Omit<
  KernelRepositoryRegistration,
  "version" | "created_at" | "updated_at"
> {
  const id = bounded(input.id, "repository registration ID", 200, ID);
  if (input.control_provider !== "linear" && input.control_provider !== "github") {
    throw new Error("repository control provider is invalid");
  }
  const githubRepo = bounded(
    input.github_repo,
    "GitHub repository",
    300,
    REPOSITORY,
  ).toLowerCase();
  const linear = input.control_provider === "linear";
  const teamId = input.linear_team_id === null
    ? null
    : bounded(input.linear_team_id, "Linear team ID", 300);
  const teamKey = input.linear_team_key === null
    ? null
    : bounded(input.linear_team_key, "Linear team key", 300, TEAM_KEY).toUpperCase();
  if ((linear && (teamId === null || teamKey === null)) || (!linear && (teamId !== null || teamKey !== null))) {
    throw new Error("repository registration routing fields are inconsistent");
  }
  return {
    id,
    control_provider: input.control_provider,
    route_key: linear ? teamId! : githubRepo,
    linear_team_id: teamId,
    linear_team_key: teamKey,
    github_repo: githubRepo,
    github_installation_id: positiveInteger(input.github_installation_id, "GitHub installation ID"),
    base_branch: safeBranch(input.base_branch),
    webhook_id: positiveInteger(input.webhook_id, "GitHub webhook ID"),
    runtime_snapshot: bounded(input.runtime_snapshot, "runtime snapshot", 300),
  };
}

function sameRegistration(
  left: KernelRepositoryRegistration,
  right: ReturnType<typeof normalized>,
): boolean {
  return (
    left.id === right.id &&
    left.control_provider === right.control_provider &&
    left.route_key === right.route_key &&
    left.linear_team_id === right.linear_team_id &&
    left.linear_team_key === right.linear_team_key &&
    left.github_repo === right.github_repo &&
    left.github_installation_id === right.github_installation_id &&
    left.base_branch === right.base_branch &&
    left.webhook_id === right.webhook_id &&
    left.runtime_snapshot === right.runtime_snapshot
  );
}

export class SqliteKernelRegistrationStore implements KernelRepositoryRegistrationPort {
  readonly #db: Database.Database;
  readonly #now: () => string;

  constructor(input: { db: Database.Database; now?: () => string }) {
    this.#db = input.db;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  put(input: KernelRepositoryRegistrationInput): {
    disposition: "inserted" | "unchanged" | "updated";
    registration: KernelRepositoryRegistration;
  } {
    const intended = normalized(input);
    return this.#db.transaction(() => {
      const byId = this.#getById(intended.id);
      const byRepository = this.findGithubRoute(intended.github_repo);
      const byRoute = intended.control_provider === "linear"
        ? this.findLinearRoute({ team_id: intended.route_key })
        : byRepository;
      for (const [authority, existing] of [
        ["repository", byRepository],
        ["route", byRoute],
      ] as const) {
        if (existing && existing.id !== intended.id) {
          throw new Error(`${authority} is already registered by ${existing.id}`);
        }
      }
      if (byId && (
        byId.control_provider !== intended.control_provider ||
        byId.route_key !== intended.route_key ||
        byId.github_repo !== intended.github_repo
      )) {
        throw new Error(`repository registration ${intended.id} cannot transfer authority`);
      }
      if (byId && sameRegistration(byId, intended)) {
        return { disposition: "unchanged", registration: byId } as const;
      }
      if (input.expected_version !== undefined && input.expected_version !== (byId?.version ?? 0)) {
        throw new Error("repository registration compare-and-set failed");
      }
      const timestamp = iso(this.#now());
      if (!byId) {
        this.#db.prepare(`
          INSERT INTO repository_registrations (
            id, control_provider, route_key, linear_team_id, linear_team_key,
            github_repo, github_installation_id, base_branch, webhook_id,
            runtime_snapshot, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).run(
          intended.id,
          intended.control_provider,
          intended.route_key,
          intended.linear_team_id,
          intended.linear_team_key,
          intended.github_repo,
          intended.github_installation_id,
          intended.base_branch,
          intended.webhook_id,
          intended.runtime_snapshot,
          timestamp,
          timestamp,
        );
        return { disposition: "inserted", registration: this.#getById(intended.id)! } as const;
      }
      const changed = this.#db.prepare(`
        UPDATE repository_registrations SET
          linear_team_key = ?, github_installation_id = ?, base_branch = ?,
          webhook_id = ?, runtime_snapshot = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(
        intended.linear_team_key,
        intended.github_installation_id,
        intended.base_branch,
        intended.webhook_id,
        intended.runtime_snapshot,
        timestamp,
        intended.id,
        byId.version,
      );
      if (changed.changes !== 1) throw new Error("repository registration compare-and-set failed");
      return { disposition: "updated", registration: this.#getById(intended.id)! } as const;
    }).immediate();
  }

  list(): readonly KernelRepositoryRegistration[] {
    return this.#db.prepare(`
      SELECT * FROM repository_registrations ORDER BY github_repo, id
    `).all() as KernelRepositoryRegistration[];
  }

  findLinearRoute(input: {
    team_id?: string;
    team_key?: string;
  }): KernelRepositoryRegistration | undefined {
    const byId = input.team_id === undefined
      ? undefined
      : this.#db.prepare(`
        SELECT * FROM repository_registrations
        WHERE control_provider = 'linear' AND route_key = ?
      `).get(input.team_id) as KernelRepositoryRegistration | undefined;
    const byKey = input.team_key === undefined
      ? undefined
      : this.#db.prepare(`
        SELECT * FROM repository_registrations
        WHERE control_provider = 'linear' AND upper(linear_team_key) = upper(?)
      `).get(input.team_key) as KernelRepositoryRegistration | undefined;
    if (byId && byKey && byId.id !== byKey.id) {
      throw new Error("Linear team ID and key resolve to different registrations");
    }
    return byId ?? byKey;
  }

  findGithubRoute(repository: string): KernelRepositoryRegistration | undefined {
    if (!REPOSITORY.test(repository)) return undefined;
    return this.#db.prepare(`
      SELECT * FROM repository_registrations WHERE lower(github_repo) = lower(?)
    `).get(repository) as KernelRepositoryRegistration | undefined;
  }

  resolveRun(reference: string): KernelRunReference | undefined {
    bounded(reference, "run reference", 300);
    const exact = this.#db.prepare(`
      SELECT r.id AS pipeline_run_id, r.work_item_id, w.source_provider, w.source_reference
      FROM pipeline_runs r JOIN work_items w ON w.id = r.work_item_id
      WHERE r.id = ?
    `).get(reference) as KernelRunReference | undefined;
    if (exact) return exact;
    const matches = this.#db.prepare(`
      SELECT r.id AS pipeline_run_id, r.work_item_id, w.source_provider, w.source_reference
        , r.pipeline_id
      FROM pipeline_runs r JOIN work_items w ON w.id = r.work_item_id
      WHERE w.source_reference = ?
      ORDER BY r.created_at, r.id
    `).all(reference) as Array<KernelRunReference & { pipeline_id: string }>;
    if (matches.length === 0) return undefined;
    if (matches.length === 1) {
      const { pipeline_id: _pipelineId, ...resolved } = matches[0]!;
      return resolved;
    }
    const executable = matches.filter(({ pipeline_id }) => pipeline_id !== "core/admission");
    if (executable.length !== 1) throw new Error(`source reference ${reference} is ambiguous`);
    const { pipeline_id: _pipelineId, ...resolved } = executable[0]!;
    return resolved;
  }

  #getById(id: string): KernelRepositoryRegistration | undefined {
    return this.#db.prepare(`
      SELECT * FROM repository_registrations WHERE id = ?
    `).get(id) as KernelRepositoryRegistration | undefined;
  }
}
