import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./database.js";
import { createDeploymentCutoverStore } from "./deployment-cutover-store.js";

describe("deployment cutover store", () => {
  it("persists one resumable cutover and rejects an ambiguous second candidate", () => {
    const db = openDb(":memory:");
    try {
      const store = createDeploymentCutoverStore(db, () => "2026-08-14T04:44:22.000Z");
      const cutover = store.beginDeploymentCutover({
        oldRuntimeRelease: "openthrottle-snapshot/v12",
        oldSnapshot: "openthrottle-ce-old",
        candidateSnapshot: "openthrottle-ce-new",
        evidence: "initial evidence",
      });

      expect(cutover).toMatchObject({
        status: "active",
        phase: "registered",
        old_runtime_release: "openthrottle-snapshot/v12",
        old_snapshot: "openthrottle-ce-old",
        candidate_snapshot: "openthrottle-ce-new",
      });
      expect(store.beginDeploymentCutover({
        oldRuntimeRelease: "openthrottle-snapshot/v12",
        oldSnapshot: "openthrottle-ce-old",
        candidateSnapshot: "openthrottle-ce-new",
      })).toEqual(cutover);
      expect(() => store.beginDeploymentCutover({
        oldRuntimeRelease: "openthrottle-snapshot/v12",
        oldSnapshot: "openthrottle-ce-old",
        candidateSnapshot: "openthrottle-ce-other",
      })).toThrow(/retry must adopt that transaction/);

      const restored = store.advanceDeploymentCutover({
        id: cutover.id,
        phase: "restored",
        status: "active",
        evidence: "old runtime and snapshot restored",
      });
      expect(restored).toMatchObject({
        status: "active",
        phase: "restored",
        completed_at: null,
      });
      expect(store.beginDeploymentCutover({
        oldRuntimeRelease: "openthrottle-snapshot/v12",
        oldSnapshot: "openthrottle-ce-old",
        candidateSnapshot: "openthrottle-ce-new",
      })).toEqual(restored);

      const completed = store.advanceDeploymentCutover({
        id: cutover.id,
        phase: "resumed",
        status: "completed",
        evidence: "candidate deployed and admission resumed",
      });
      expect(completed).toMatchObject({
        status: "completed",
        phase: "resumed",
        completed_at: "2026-08-14T04:44:22.000Z",
      });
      expect(store.getOpenDeploymentCutover()).toBeUndefined();

      const retry = store.beginDeploymentCutover({
        oldRuntimeRelease: "openthrottle-snapshot/v12",
        oldSnapshot: "openthrottle-ce-old",
        candidateSnapshot: "openthrottle-ce-new",
      });
      expect(retry).toMatchObject({
        id: "snapshot-cutover:openthrottle-ce-new:attempt-2",
        status: "active",
        phase: "registered",
        candidate_snapshot: "openthrottle-ce-new",
      });
      expect(store.beginDeploymentCutover({
        oldRuntimeRelease: "openthrottle-snapshot/v12",
        oldSnapshot: "openthrottle-ce-old",
        candidateSnapshot: "openthrottle-ce-new",
      })).toEqual(retry);
    } finally {
      db.close();
    }
  });

  it("advances inside one immediate transaction so a writer cannot interleave with its read", () => {
    const directory = mkdtempSync(join(tmpdir(), "openthrottle-cutover-txn-"));
    const path = join(directory, "supervisor.db");
    const db = openDb(path);
    const interloper = new Database(path);
    try {
      interloper.pragma("busy_timeout = 0");
      const cutoverId = createDeploymentCutoverStore(db, () => "2026-08-14T05:00:00.000Z")
        .beginDeploymentCutover({
          oldRuntimeRelease: "openthrottle-snapshot/v12",
          oldSnapshot: "openthrottle-ce-old",
          candidateSnapshot: "openthrottle-ce-new",
        }).id;

      // now() runs between advance's read and its update. A second connection
      // writing there must hit the held write lock; if advance ever loses its
      // immediate transaction, this write commits mid-advance and the
      // read-modify-write silently resurrects the state it read.
      let interleavedWrite: unknown;
      const store = createDeploymentCutoverStore(db, () => {
        try {
          interloper.prepare(
            "UPDATE deployment_cutovers SET evidence = 'interloper' WHERE id = ?"
          ).run(cutoverId);
          interleavedWrite = "committed";
        } catch (error) {
          interleavedWrite = error;
        }
        return "2026-08-14T05:00:01.000Z";
      });

      const advanced = store.advanceDeploymentCutover({
        id: cutoverId,
        phase: "resumed",
        status: "completed",
        evidence: "candidate deployed and admission resumed",
      });

      expect(interleavedWrite).toBeInstanceOf(Error);
      expect((interleavedWrite as { code?: string }).code).toBe("SQLITE_BUSY");
      expect(advanced).toMatchObject({
        status: "completed",
        phase: "resumed",
        evidence: "candidate deployed and admission resumed",
        completed_at: "2026-08-14T05:00:01.000Z",
      });
    } finally {
      interloper.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records recovery commands when restoration cannot be proven", () => {
    const db = openDb(":memory:");
    try {
      const store = createDeploymentCutoverStore(db, () => "2026-08-14T04:54:22.000Z");
      const cutover = store.beginDeploymentCutover({
        oldRuntimeRelease: "openthrottle-snapshot/v12",
        oldSnapshot: "openthrottle-ce-old",
        candidateSnapshot: "openthrottle-ce-new",
      });

      expect(store.advanceDeploymentCutover({
        id: cutover.id,
        phase: "recovery_required",
        status: "recovery_required",
        evidence: "restoration proof failed",
        recoveryCommand: "flyctl secrets set --stage --app app DAYTONA_SNAPSHOT=openthrottle-ce-old",
      })).toMatchObject({
        status: "recovery_required",
        phase: "recovery_required",
        recovery_command: "flyctl secrets set --stage --app app DAYTONA_SNAPSHOT=openthrottle-ce-old",
      });
      expect(() => store.beginDeploymentCutover({
        oldRuntimeRelease: "openthrottle-snapshot/v12",
        oldSnapshot: "openthrottle-ce-other-old",
        candidateSnapshot: "openthrottle-ce-other",
      })).toThrow(/retry must adopt that transaction/);
    } finally {
      db.close();
    }
  });

  it("keeps pre-stage and pre-deploy recovery evidence resumable for the same transaction", () => {
    const db = openDb(":memory:");
    try {
      const store = createDeploymentCutoverStore(db, () => "2026-08-14T04:49:22.000Z");
      const cutover = store.beginDeploymentCutover({
        oldRuntimeRelease: "openthrottle-snapshot/v12",
        oldSnapshot: "openthrottle-ce-old",
        candidateSnapshot: "openthrottle-ce-new",
      });

      const preStage = store.advanceDeploymentCutover({
        id: cutover.id,
        phase: "recovery_required",
        status: "recovery_required",
        evidence: "candidate not staged yet",
        recoveryCommand: "restore old snapshot and resume admission",
      });
      expect(preStage).toMatchObject({
        status: "recovery_required",
        phase: "recovery_required",
        recovery_command: "restore old snapshot and resume admission",
      });
      expect(store.getOpenDeploymentCutover()).toEqual(preStage);

      const staged = store.advanceDeploymentCutover({
        id: cutover.id,
        phase: "staged",
        status: "active",
        evidence: "candidate staged after drain clear",
      });
      expect(staged).toMatchObject({
        status: "active",
        phase: "staged",
        recovery_command: "restore old snapshot and resume admission",
      });

      const preDeploy = store.advanceDeploymentCutover({
        id: cutover.id,
        phase: "recovery_required",
        status: "recovery_required",
        evidence: "candidate staged before deploy",
        recoveryCommand: "restore old snapshot, deploy old runtime, and resume admission",
      });
      expect(preDeploy).toMatchObject({
        status: "recovery_required",
        phase: "recovery_required",
        recovery_command: "restore old snapshot, deploy old runtime, and resume admission",
      });

      const deployed = store.advanceDeploymentCutover({
        id: cutover.id,
        phase: "deployed",
        status: "active",
        evidence: "candidate deployed and ready for verification",
      });
      expect(deployed).toMatchObject({
        status: "active",
        phase: "deployed",
      });
    } finally {
      db.close();
    }
  });
});
