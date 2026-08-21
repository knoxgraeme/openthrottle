import Database from "better-sqlite3";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestCanonicalJson } from "@openthrottle/contracts";
import { createFreshEpochBootstrap } from "./epoch-database.js";
import {
  OFFLINE_REPLACEMENT_REPORT_SCHEMA,
  OFFLINE_REPLACEMENT_SCHEMA,
  runOfflineReplacement,
  type OfflineReplacementHooks,
  type OfflineReplacementInput,
  type OfflineReplacementReport,
} from "./offline-replacement.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { root: string; input: OfflineReplacementInput } {
  const root = mkdtempSync(join(tmpdir(), "openthrottle-offline-replacement-"));
  directories.push(root);
  const oldDatabase = join(root, "old.sqlite");
  const db = new Database(oldDatabase);
  db.exec("CREATE TABLE historical_runs (id TEXT PRIMARY KEY, outcome TEXT NOT NULL) STRICT");
  db.prepare("INSERT INTO historical_runs (id, outcome) VALUES (?, ?)").run("old-run", "completed");
  db.close();
  const oldBlobs = join(root, "old-blobs");
  mkdirSync(oldBlobs);
  writeFileSync(join(oldBlobs, "evidence.bin"), "durable evidence", { mode: 0o600 });
  const bootstrap = createFreshEpochBootstrap({
    schema: "openthrottle.fresh-epoch-bootstrap/v1",
    settings: [],
    repository_registrations: [{
      id: "repo",
      control_provider: "github",
      route_key: "owner/repo",
      linear_team_id: null,
      linear_team_key: null,
      github_repo: "owner/repo",
      github_installation_id: 1,
      base_branch: "main",
      webhook_id: 2,
      runtime_snapshot: "snapshot-v2",
    }],
  });
  return {
    root,
    input: {
      schema: OFFLINE_REPLACEMENT_SCHEMA,
      maintenance: {
        ingress_closed: true,
        supervisors_stopped: true,
        workers_stopped: true,
        storage_lock_absent: true,
        evidence: ["fly-machines:zero", "old-db-lock:absent"],
      },
      active_work: [{
        id: "old-run",
        kind: "runtime_resource",
        status: "completed",
        disposition: "terminal",
        resource_cleanup: "verified",
      }],
      old: {
        release_id: "release-v1",
        database_path: oldDatabase,
        blob_root: oldBlobs,
        archive_root: join(root, "archive-v1"),
      },
      fresh: {
        release_id: "release-v2",
        database_path: join(root, "fresh.sqlite"),
        blob_root: join(root, "fresh-blobs"),
        blob_store_id: "fresh-v2",
        bootstrap,
      },
      report_path: join(root, "replacement-report.json"),
    },
  };
}

function hooks(overrides: Partial<OfflineReplacementHooks> = {}): OfflineReplacementHooks {
  return {
    observePreconditions: async (input) => ({
      old_release_id: input.old.release_id,
      database_path: input.old.database_path,
      blob_root: input.old.blob_root,
      ingress_closed: true,
      active_work_clear: true,
      supervisors_stopped: true,
      workers_stopped: true,
      evidence: "maintenance fence and active-work report observed",
    }),
    startCandidate: async () => "candidate release-v2 started with ingress closed",
    runSmoke: async (kind) => ({ id: `${kind}-smoke`, status: "passed", evidence: `${kind} passed` }),
    reopenIngress: async () => "fresh ingress opened",
    stopCandidate: async () => "candidate stopped",
    restoreOld: async () => "old release/storage tuple restored",
    ...overrides,
  };
}

describe("one-shot offline epoch replacement", () => {
  it("refuses unresolved active work before creating archive or fresh storage", async () => {
    const { input } = fixture();
    input.active_work = [{
      id: "live-attempt",
      kind: "attempt",
      status: "running",
      disposition: "terminal",
      resource_cleanup: "not_applicable",
    }];

    await expect(runOfflineReplacement(input, hooks())).rejects.toThrow(/not terminal/);
    expect(() => readFileSync(input.old.archive_root)).toThrow();
    expect(() => readFileSync(input.fresh.database_path)).toThrow();
  });

  it("preflights the report path and its parent before archiving old storage", async () => {
    const occupied = fixture();
    writeFileSync(occupied.input.report_path, "already claimed", { mode: 0o600 });

    await expect(runOfflineReplacement(occupied.input, hooks())).rejects.toThrow(/report path already exists/);
    expect(existsSync(occupied.input.old.archive_root)).toBe(false);
    expect(existsSync(occupied.input.fresh.database_path)).toBe(false);

    const missingParent = fixture();
    missingParent.input.report_path = join(missingParent.root, "missing", "replacement-report.json");
    await expect(runOfflineReplacement(missingParent.input, hooks())).rejects.toThrow(/report parent/);
    expect(existsSync(missingParent.input.old.archive_root)).toBe(false);
    expect(existsSync(missingParent.input.fresh.database_path)).toBe(false);
  });

  it("requires an observed precondition bound to the exact old tuple before archiving", async () => {
    const { input } = fixture();
    await expect(runOfflineReplacement(input, hooks({
      observePreconditions: async () => ({
        old_release_id: "different-release",
        database_path: input.old.database_path,
        blob_root: input.old.blob_root,
        ingress_closed: true,
        active_work_clear: true,
        supervisors_stopped: true,
        workers_stopped: true,
        evidence: "stale observation",
      }),
    }))).rejects.toThrow(/does not match the exact old tuple/);
    expect(existsSync(input.old.archive_root)).toBe(false);
    expect(existsSync(input.fresh.database_path)).toBe(false);
  });

  it("requires an exclusive old-database lock probe before archiving", async () => {
    const { input } = fixture();
    const writer = new Database(input.old.database_path);
    writer.exec("BEGIN EXCLUSIVE");
    try {
      await expect(runOfflineReplacement(input, hooks())).rejects.toThrow(/exclusive old-database lock/);
      expect(existsSync(input.old.archive_root)).toBe(false);
      expect(existsSync(input.fresh.database_path)).toBe(false);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  it("archives the old tuple, initializes exactly one fresh epoch, smokes both modes, and seals a report", async () => {
    const { input } = fixture();
    const report = await runOfflineReplacement(input, hooks(), {
      now: () => "2026-08-20T15:00:00.000Z",
    });

    expect(report).toMatchObject({
      schema: OFFLINE_REPLACEMENT_REPORT_SCHEMA,
      status: "completed",
      old_release_id: "release-v1",
      fresh_release_id: "release-v2",
      smoke: {
        ordinary: { id: "ordinary-smoke", status: "passed" },
        structured: { id: "structured-smoke", status: "passed" },
      },
      fresh_epoch: { release_id: "release-v2", integrity: "ok" },
      observed_preconditions: {
        old_release_id: "release-v1",
        exclusive_database_lock: "acquired",
      },
    });
    expect(report.ready_report_digest).toMatch(/^[0-9a-f]{64}$/);
    const { report_digest: digest, ...content } = report;
    expect(digest).toBe(digestCanonicalJson(content));
    const reconstructedReady = {
      ...content,
      status: "ready_to_reopen",
      finished_at: report.ready_at,
      reopen_evidence: null,
      ready_report_digest: null,
    };
    expect(report.ready_at).toBe("2026-08-20T15:00:00.000Z");
    expect(report.ready_report_digest).toBe(digestCanonicalJson(reconstructedReady));
    const persisted = JSON.parse(readFileSync(input.report_path, "utf8")) as OfflineReplacementReport;
    expect(persisted).toEqual(report);
    const archiveManifest = JSON.parse(readFileSync(
      join(input.old.archive_root, "archive-manifest.json"),
      "utf8",
    )) as { old_release_id: string; blobs: Array<{ path: string }> };
    expect(archiveManifest).toMatchObject({ old_release_id: "release-v1" });
    expect(archiveManifest.blobs.map(({ path }) => path)).toEqual(["evidence.bin"]);

    const db = new Database(input.fresh.database_path, { readonly: true });
    try {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
      `).all() as Array<{ name: string }>;
      expect(tables).toHaveLength(12);
      expect(db.prepare("SELECT COUNT(*) AS count FROM pipeline_runs").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("seals candidate-ready evidence before reopening and chains the completion report to it", async () => {
    const { input } = fixture();
    let readyDigest = "";
    const report = await runOfflineReplacement(input, hooks({
      reopenIngress: async () => {
        const ready = JSON.parse(readFileSync(input.report_path, "utf8")) as OfflineReplacementReport;
        expect(ready.status).toBe("ready_to_reopen");
        expect(ready.reopen_evidence).toBeNull();
        const { report_digest: digest, ...content } = ready;
        expect(digest).toBe(digestCanonicalJson(content));
        readyDigest = digest;
        return "fresh ingress opened";
      },
    }));

    expect(report.status).toBe("completed");
    expect(report.ready_report_digest).toBe(readyDigest);
    expect(report.reopen_evidence).toBe("fresh ingress opened");
  });

  it("rejects duplicate ordinary and structured smoke IDs before reopening", async () => {
    const { input } = fixture();
    const calls: string[] = [];
    await expect(runOfflineReplacement(input, hooks({
      runSmoke: async (kind) => ({ id: "same-smoke", status: "passed", evidence: `${kind} passed` }),
      reopenIngress: async () => {
        calls.push("reopen");
        return "fresh ingress opened";
      },
      stopCandidate: async () => {
        calls.push("stop");
        return "candidate stopped";
      },
      restoreOld: async () => {
        calls.push("restore");
        return "old tuple restored";
      },
    }))).rejects.toThrow(/smoke IDs must be distinct/);

    expect(calls).toEqual(["stop", "restore"]);
    expect(JSON.parse(readFileSync(input.report_path, "utf8"))).toMatchObject({ status: "rolled_back" });
  });

  it("stops the candidate and restores the matching old tuple when a smoke fails", async () => {
    const { input } = fixture();
    const calls: string[] = [];
    await expect(runOfflineReplacement(input, hooks({
      runSmoke: async (kind) => {
        calls.push(kind);
        if (kind === "structured") throw new Error("structured smoke failed");
        return { id: "ordinary-smoke", status: "passed", evidence: "ordinary passed" };
      },
      stopCandidate: async (reason) => {
        calls.push(`stop:${reason}`);
        return "candidate stopped";
      },
      restoreOld: async (reason) => {
        calls.push(`restore:${reason}`);
        return "release-v1 with old paths restored";
      },
    }))).rejects.toThrow(/rolled back: structured smoke failed/);

    expect(calls).toEqual([
      "ordinary",
      "structured",
      "stop:structured smoke failed",
      "restore:structured smoke failed",
    ]);
    const report = JSON.parse(readFileSync(input.report_path, "utf8")) as OfflineReplacementReport;
    expect(report).toMatchObject({
      status: "rolled_back",
      failure: "structured smoke failed",
      rollback_evidence: [
        "candidate_stopped:candidate stopped",
        "old_tuple_restored:release-v1 with old paths restored",
      ],
    });
  });

  it("blocks restore and reports rollback_failed when candidate stop fails", async () => {
    const { input } = fixture();
    const calls: string[] = [];
    await expect(runOfflineReplacement(input, hooks({
      runSmoke: async () => {
        throw new Error("smoke failed");
      },
      stopCandidate: async () => {
        calls.push("stop");
        throw new Error("candidate still running");
      },
      restoreOld: async () => {
        calls.push("restore");
        return "must not be called";
      },
    }))).rejects.toThrow(/rollback failed/);

    expect(calls).toEqual(["stop"]);
    expect(JSON.parse(readFileSync(input.report_path, "utf8"))).toMatchObject({
      status: "rollback_failed",
      rollback_evidence: ["candidate_stop_failed:candidate still running"],
      rollback_failure: "candidate still running",
    });
  });

  it("reports rollback_failed without claiming restoration when restore fails", async () => {
    const { input } = fixture();
    await expect(runOfflineReplacement(input, hooks({
      runSmoke: async () => {
        throw new Error("smoke failed");
      },
      restoreOld: async () => {
        throw new Error("restore command failed");
      },
    }))).rejects.toThrow(/rollback failed/);

    expect(JSON.parse(readFileSync(input.report_path, "utf8"))).toMatchObject({
      status: "rollback_failed",
      rollback_evidence: [
        "candidate_stopped:candidate stopped",
        "old_tuple_restore_failed:restore command failed",
      ],
      rollback_failure: "restore command failed",
    });
  });

  it("never restores old storage after the candidate-ready boundary", async () => {
    const { input } = fixture();
    const calls: string[] = [];
    await expect(runOfflineReplacement(input, hooks({
      reopenIngress: async () => {
        calls.push("reopen");
        throw new Error("reopen outcome unknown");
      },
      stopCandidate: async () => {
        calls.push("stop");
        return "candidate stopped";
      },
      restoreOld: async () => {
        calls.push("restore");
        return "old tuple restored";
      },
    }))).rejects.toThrow(/operator resolution.*reopen outcome unknown/);

    expect(calls).toEqual(["reopen"]);
    expect(JSON.parse(readFileSync(input.report_path, "utf8"))).toMatchObject({
      status: "ready_to_reopen",
      reopen_evidence: null,
      rollback_evidence: [],
    });
  });

  it("does not roll back when completion-report finalization fails after ingress reopened", async () => {
    const { input } = fixture();
    const calls: string[] = [];
    let clockCalls = 0;
    await expect(runOfflineReplacement(input, hooks({
      reopenIngress: async () => {
        calls.push("reopen");
        return "fresh ingress opened";
      },
      stopCandidate: async () => {
        calls.push("stop");
        return "candidate stopped";
      },
      restoreOld: async () => {
        calls.push("restore");
        return "old tuple restored";
      },
    }), {
      now: () => {
        clockCalls += 1;
        if (clockCalls === 3) throw new Error("completion clock failed");
        return `2026-08-20T15:00:0${clockCalls}.000Z`;
      },
    })).rejects.toThrow(/operator resolution.*completion clock failed/);

    expect(calls).toEqual(["reopen"]);
    expect(JSON.parse(readFileSync(input.report_path, "utf8"))).toMatchObject({
      status: "ready_to_reopen",
      ready_at: "2026-08-20T15:00:02.000Z",
      reopen_evidence: null,
    });
  });
});
