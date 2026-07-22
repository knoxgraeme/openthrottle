import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTicketStore, openDb } from "./db.js";
import { reconcileSandboxAutostop } from "./sandbox-lifecycle.js";
import {
  STAGE_EXECUTOR_PROTOCOL,
  buildInstalledRuntimeDescriptor,
  createStageRequestHash,
  loadRuntimeCapabilityDescriptor,
  type StageRequestEnvelope,
} from "./sandbox-runtime.js";

describe("sandbox runtime port", () => {
  let db: Database.Database | undefined;
  afterEach(() => db?.close());

  it("builds independent, deterministic capability evidence", () => {
    const first = buildInstalledRuntimeDescriptor("snapshot/v1");
    const second = buildInstalledRuntimeDescriptor("snapshot/v1", {
      capabilities: [...first.descriptor.capabilities].reverse(),
    });
    expect(first.digest).toBe(second.digest);
    expect(buildInstalledRuntimeDescriptor("snapshot/v1", {
      capabilities: ["command/run@1"],
    }).digest).not.toBe(first.digest);
    expect(first.descriptor.generatedBy).toBe("sandbox-runtime-build");
  });

  it("loads the shipped descriptor and rejects a mismatched configured release", () => {
    const path = fileURLToPath(new URL("../pipelines/runtime-capabilities-v1.json", import.meta.url));
    const runtime = loadRuntimeCapabilityDescriptor(path, "openthrottle-snapshot/v1");
    expect(runtime.descriptor.capabilities).toContain("ce/implement@1");
    expect(() => loadRuntimeCapabilityDescriptor(path, "different-release/v1"))
      .toThrow(/does not match configured/);
  });

  it("hashes the complete immutable stage fence without credential material", () => {
    const request: Omit<StageRequestEnvelope, "requestHash" | "idempotencyKey"> = {
      protocol: STAGE_EXECUTOR_PROTOCOL,
      pipelineInstanceId: "pipeline-1",
      manifestDigest: "a".repeat(64),
      runtimeRelease: "snapshot/v1",
      capabilityDigest: "b".repeat(64),
      stageId: "command",
      attemptId: "attempt-1",
      runId: "run-1",
      issueId: "issue-1",
      sessionId: "session-1",
      generation: 1,
      repository: "owner/repo",
      baseCommit: "c".repeat(40),
      contextRevision: 0,
      expectedSubject: null,
      contextPolicy: "none" as const,
      capability: "command/run@1",
      requiredArtifacts: ["command_result" as const],
      credentialScopes: ["repo.read"],
    };
    expect(createStageRequestHash(request)).toEqual(createStageRequestHash({ ...request }));
    expect(createStageRequestHash({ ...request, generation: 2 }).requestHash)
      .not.toBe(createStageRequestHash(request).requestHash);
    expect(JSON.stringify(createStageRequestHash(request))).not.toContain("token");
  });

  it("reconciles lifecycle through opaque provider resource IDs", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-1",
      linear_issue_identifier: "ISSUE-1",
      linear_session_id: "session-1",
      sandbox_id: "opaque-resource",
      branch: "ot/issue-1",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    const runtime = { setActive: vi.fn(), setIdle: vi.fn() };
    await reconcileSandboxAutostop({
      runtime,
      store,
      issueId: "issue-1",
      providerResourceId: "opaque-resource",
    });
    expect(runtime.setIdle).toHaveBeenCalledWith("opaque-resource");
    expect(runtime.setActive).not.toHaveBeenCalled();
  });

  it("keeps provider SDK types outside the runtime port", () => {
    const source = readFileSync(fileURLToPath(new URL("./sandbox-runtime.ts", import.meta.url)), "utf8");
    expect(source).not.toContain("@daytona/sdk");
    expect(source).not.toMatch(/Daytona/);
  });
});
