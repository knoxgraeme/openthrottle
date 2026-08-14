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
        oldRuntimeCapabilityDigest: "sha256:old-runtime-digest",
        oldRuntimeImage: "registry.fly.io/openthrottle-supervisor@sha256:old",
        oldSnapshot: "openthrottle-v2-ce-old",
        candidateSnapshot: "openthrottle-v2-ce-new",
        evidence: "initial evidence",
      });

      expect(cutover).toMatchObject({
        status: "active",
        phase: "registered",
        old_runtime_release: "openthrottle-snapshot/v12",
        old_runtime_capability_digest: "sha256:old-runtime-digest",
        old_runtime_image: "registry.fly.io/openthrottle-supervisor@sha256:old",
        old_snapshot: "openthrottle-v2-ce-old",
        candidate_snapshot: "openthrottle-v2-ce-new",
      });
      expect(store.beginDeploymentCutover({
        oldRuntimeRelease: "openthrottle-snapshot/v12",
        oldRuntimeCapabilityDigest: "sha256:old-runtime-digest",
        oldRuntimeImage: "registry.fly.io/openthrottle-supervisor@sha256:old",
        oldSnapshot: "openthrottle-v2-ce-old",
        candidateSnapshot: "openthrottle-v2-ce-new",
      })).toEqual(cutover);
      expect(() => store.beginDeploymentCutover({
        oldRuntimeRelease: "openthrottle-snapshot/v12",
        oldRuntimeCapabilityDigest: "sha256:old-runtime-digest",
        oldRuntimeImage: "registry.fly.io/openthrottle-supervisor@sha256:old",
        oldSnapshot: "openthrottle-v2-ce-old",
        candidateSnapshot: "openthrottle-v2-ce-other",
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
        oldRuntimeCapabilityDigest: "sha256:old-runtime-digest",
        oldRuntimeImage: "registry.fly.io/openthrottle-supervisor@sha256:old",
        oldSnapshot: "openthrottle-v2-ce-old",
        candidateSnapshot: "openthrottle-v2-ce-new",
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
    } finally {
      db.close();
    }
  });

  it("records recovery commands when restoration cannot be proven", () => {
    const db = openDb(":memory:");
    try {
      const store = createDeploymentCutoverStore(db, () => "2026-08-14T04:54:22.000Z");
      const cutover = store.beginDeploymentCutover({
        oldRuntimeRelease: "openthrottle-snapshot/v12",
        oldRuntimeCapabilityDigest: "sha256:old-runtime-digest",
        oldRuntimeImage: "registry.fly.io/openthrottle-supervisor@sha256:old",
        oldSnapshot: "openthrottle-v2-ce-old",
        candidateSnapshot: "openthrottle-v2-ce-new",
      });

      expect(store.advanceDeploymentCutover({
        id: cutover.id,
        phase: "recovery_required",
        status: "recovery_required",
        evidence: "restoration proof failed",
        recoveryCommand: "flyctl secrets set --stage --app app DAYTONA_SNAPSHOT=openthrottle-v2-ce-old",
      })).toMatchObject({
        status: "recovery_required",
        phase: "recovery_required",
        recovery_command: "flyctl secrets set --stage --app app DAYTONA_SNAPSHOT=openthrottle-v2-ce-old",
      });
      expect(() => store.beginDeploymentCutover({
        oldRuntimeRelease: "openthrottle-snapshot/v12",
        oldRuntimeCapabilityDigest: "sha256:old-runtime-digest",
        oldRuntimeImage: "registry.fly.io/openthrottle-supervisor@sha256:other",
        oldSnapshot: "openthrottle-v2-ce-other-old",
        candidateSnapshot: "openthrottle-v2-ce-other",
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
        oldRuntimeCapabilityDigest: "sha256:old-runtime-digest",
        oldRuntimeImage: "registry.fly.io/openthrottle-supervisor@sha256:old",
        oldSnapshot: "openthrottle-v2-ce-old",
        candidateSnapshot: "openthrottle-v2-ce-new",
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
