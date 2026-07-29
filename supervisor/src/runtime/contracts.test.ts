import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { reconcileSandboxAutostop } from "./lifecycle.js";
import {
  loadRuntimeCapabilityDescriptor,
} from "./contracts.js";
import { buildInstalledRuntimeDescriptor } from "../__fixtures__/runtime.js";

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
    const path = fileURLToPath(new URL("../../pipelines/runtime-capabilities-v1.json", import.meta.url));
    const runtime = loadRuntimeCapabilityDescriptor(path, "openthrottle-snapshot/v4");
    expect(runtime.descriptor.capabilities).toContain("ce/implement@1");
    expect(() => loadRuntimeCapabilityDescriptor(path, "different-release/v1"))
      .toThrow(/does not match configured/);
  });

  it("reconciles lifecycle through opaque provider resource IDs", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
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
    const source = readFileSync(fileURLToPath(new URL("./contracts.ts", import.meta.url)), "utf8");
    expect(source).not.toContain("@daytona/sdk");
    expect(source).not.toMatch(/Daytona/);
  });
});
