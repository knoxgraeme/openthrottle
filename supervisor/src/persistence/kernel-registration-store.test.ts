import { afterEach, describe, expect, it } from "vitest";
import {
  freshKernelFixture,
  seedKernelRun,
  type FreshKernelFixture,
} from "./__fixtures__/kernel-epoch.js";
import { SqliteKernelRegistrationStore } from "./kernel-registration-store.js";

const fixtures: FreshKernelFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function setup() {
  const fixture = freshKernelFixture();
  fixtures.push(fixture);
  return {
    fixture,
    store: new SqliteKernelRegistrationStore({
      db: fixture.db,
      now: () => "2026-08-20T13:00:00.000Z",
    }),
  };
}

describe("SqliteKernelRegistrationStore", () => {
  it("registers exact routes idempotently and updates preparation metadata with CAS", () => {
    const { store } = setup();
    const input = {
      id: "repo-github",
      control_provider: "github" as const,
      linear_team_id: null,
      linear_team_key: null,
      github_repo: "Acme/Widget",
      github_installation_id: 17,
      base_branch: "trunk",
      webhook_id: 23,
      runtime_snapshot: "snapshot-v1",
    };

    expect(store.put(input)).toMatchObject({
      disposition: "inserted",
      registration: {
        github_repo: "acme/widget",
        route_key: "acme/widget",
        version: 0,
      },
    });
    expect(store.put(input)).toMatchObject({ disposition: "unchanged", registration: { version: 0 } });
    expect(store.put({
      ...input,
      base_branch: "main",
      expected_version: 0,
    })).toMatchObject({ disposition: "updated", registration: { base_branch: "main", version: 1 } });
    expect(store.put({ ...input, base_branch: "main", expected_version: 0 }))
      .toMatchObject({ disposition: "unchanged", registration: { version: 1 } });
    expect(() => store.put({ ...input, base_branch: "release", expected_version: 0 }))
      .toThrow(/compare-and-set/);
  });

  it("refuses repository or provider-route authority transfer", () => {
    const { store } = setup();
    expect(() => store.put({
      id: "repo-other-id",
      control_provider: "github",
      linear_team_id: null,
      linear_team_key: null,
      github_repo: "OWNER/REPO",
      github_installation_id: null,
      base_branch: "main",
      webhook_id: null,
      runtime_snapshot: "snapshot",
    })).toThrow(/already registered/);
    expect(() => store.put({
      id: "repo-linear",
      control_provider: "linear",
      linear_team_id: "team",
      linear_team_key: "OTHER",
      github_repo: "owner/other",
      github_installation_id: null,
      base_branch: "main",
      webhook_id: null,
      runtime_snapshot: "snapshot",
    })).toThrow(/route.*already registered/);
  });

  it("resolves provider routes and run IDs from either run or source reference", () => {
    const { fixture, store } = setup();
    seedKernelRun({ db: fixture.db, run_id: "run-reference" });

    expect(store.findLinearRoute({ team_id: "team", team_key: "wrong" }))
      .toMatchObject({ id: "repo", linear_team_key: "OPE" });
    expect(store.findLinearRoute({ team_key: "ope" }))
      .toMatchObject({ id: "repo" });
    expect(store.findGithubRoute("OWNER/REPO")).toMatchObject({ id: "repo" });
    expect(store.resolveRun("run-reference")).toMatchObject({
      pipeline_run_id: "run-reference",
      source_reference: "OPE-run-reference",
    });
    expect(store.resolveRun("OPE-run-reference")).toMatchObject({
      pipeline_run_id: "run-reference",
      work_item_id: "work-run-reference",
    });
    expect(store.resolveRun("missing")).toBeUndefined();
  });

  it("resolves a promoted target instead of making its admission source ambiguous", () => {
    const { fixture, store } = setup();
    seedKernelRun({ db: fixture.db, run_id: "run-admission" });
    fixture.db.prepare("UPDATE pipeline_runs SET pipeline_id = 'core/admission' WHERE id = 'run-admission'").run();
    fixture.db.prepare(`
      INSERT INTO pipeline_runs (
        id, work_item_id, pipeline_id, definition_bundle_algorithm,
        definition_bundle_hash, definition_bundle_bytes, definition_bundle_encoding,
        definition_bundle_media_type, definition_bundle_payload_schema, current_subject,
        status, terminal_outcome, cursor_stage_id, cursor_version, cursor_reentries_json,
        cursor_frontier_json, cursor_completed_scope_keys_json, cursor_barrier_json,
        version, work_retry_limit, result_correction_limit, created_at, updated_at
      )
      SELECT 'run-target', work_item_id, 'core/structured', definition_bundle_algorithm,
        definition_bundle_hash, definition_bundle_bytes, definition_bundle_encoding,
        definition_bundle_media_type, definition_bundle_payload_schema, current_subject,
        status, terminal_outcome, 'ot_runtime_provision', cursor_version, cursor_reentries_json,
        cursor_frontier_json, cursor_completed_scope_keys_json, cursor_barrier_json,
        version, work_retry_limit, result_correction_limit, created_at, updated_at
      FROM pipeline_runs WHERE id = 'run-admission'
    `).run();

    expect(store.resolveRun("OPE-run-admission")).toEqual({
      pipeline_run_id: "run-target",
      work_item_id: "work-run-admission",
      source_provider: "linear",
      source_reference: "OPE-run-admission",
    });
    expect(store.resolveRun("run-admission")).toMatchObject({ pipeline_run_id: "run-admission" });
  });
});
