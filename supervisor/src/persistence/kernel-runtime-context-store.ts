import type Database from "better-sqlite3";

const SUBJECT = /^[a-f0-9]{40,64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface KernelRunEnvironment {
  pipeline_run_id: string;
  work_item_id: string;
  repository_registration_id: string;
  repository: string;
  base_branch: string;
  runtime_snapshot: string;
  control_provider: "linear" | "github";
  source_provider: "linear" | "github" | "operator";
  source_id: string;
  source_reference: string;
  title: string;
  current_subject: string;
}

export interface KernelRunEnvironmentPort {
  loadExactRunEnvironment(pipelineRunId: string): KernelRunEnvironment;
}

function bounded(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > maximum ||
    value.includes("\0")
  ) throw new Error(`persisted ${label} is invalid`);
  return value;
}

/** The only production read joining a run to its immutable launch authority. */
export class SqliteKernelRunEnvironmentStore implements KernelRunEnvironmentPort {
  readonly #db: Database.Database;

  constructor(input: { db: Database.Database }) {
    this.#db = input.db;
  }

  loadExactRunEnvironment(pipelineRunId: string): KernelRunEnvironment {
    bounded(pipelineRunId, "pipeline run ID", 200);
    const row = this.#db.prepare(`
      SELECT r.id AS pipeline_run_id, r.work_item_id, r.current_subject,
        w.repository_registration_id, w.source_provider, w.source_id,
        w.source_reference, w.title, registration.control_provider,
        registration.github_repo AS repository, registration.base_branch,
        registration.runtime_snapshot
      FROM pipeline_runs r
      JOIN work_items w ON w.id = r.work_item_id
      JOIN repository_registrations registration
        ON registration.id = w.repository_registration_id
      WHERE r.id = ?
    `).get(pipelineRunId) as KernelRunEnvironment | undefined;
    if (!row) throw new Error(`pipeline run ${pipelineRunId} has no exact execution environment`);
    if (!REPOSITORY.test(row.repository) || !SUBJECT.test(row.current_subject)) {
      throw new Error(`pipeline run ${pipelineRunId} has invalid persisted repository authority`);
    }
    bounded(row.work_item_id, "work item ID", 200);
    bounded(row.repository_registration_id, "repository registration ID", 200);
    bounded(row.base_branch, "base branch", 300);
    bounded(row.runtime_snapshot, "runtime snapshot", 300);
    bounded(row.source_id, "source ID", 300);
    bounded(row.source_reference, "source reference", 300);
    bounded(row.title, "work item title", 1_000);
    if (
      !["linear", "github"].includes(row.control_provider) ||
      !["linear", "github", "operator"].includes(row.source_provider)
    ) throw new Error(`pipeline run ${pipelineRunId} has invalid persisted provider authority`);
    return row;
  }
}
