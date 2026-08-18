import type Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  digestNormalized,
  loadPipelineCatalog,
  validatePipelineManifest,
} from "../../pipeline/manifest.js";
import { parseAndCompileExecutionGraph } from "../../pipeline/execution-graph.js";
import { buildInstalledRuntimeDescriptor, loadRuntimeCapabilityDescriptor } from "../../__fixtures__/runtime.js";
import { openDb } from "../database.js";
import { createPipelineStore } from "./create-store.js";
import {
  runtime,
  runtimeDescriptorPath,
  seedRetiredPipelineHistory,
  setupPipelineStore,
  shippedCatalogPath,
  ticket,
  type ValidatedPipelineCatalog,
} from "../../__fixtures__/pipeline-store.js";

describe("pipeline catalog store", () => {
  let db: Database.Database | undefined;
  const temporaryDirectories: string[] = [];
  const structuredV1GraphPath = fileURLToPath(new URL("../../../graphs/structured-v1.json", import.meta.url));
  const structuredV2GraphPath = fileURLToPath(new URL("../../../graphs/structured-v2.json", import.meta.url));
  const structuredV3GraphPath = fileURLToPath(new URL("../../../graphs/structured-v3.json", import.meta.url));
  const legacyStructuredV1Digest = "13f4b9ed94324317a78a2228a53f781d5f382b406063316bfeb85e53c37b0830";

  afterEach(() => {
    db?.close();
    db = undefined;
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects mutation of an accepted version while allowing aliases to move for future instances", () => {
    const setup = setupPipelineStore();
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
    const v1 = catalog.manifests.get("fixture/command@1")!;
    const mutatedValue = JSON.parse(v1.normalized) as Record<string, unknown>;
    mutatedValue.description = "Mutated after acceptance";
    const mutated = validatePipelineManifest(mutatedValue, { runtime: runtime.descriptor });
    const mutatedCatalog: ValidatedPipelineCatalog = {
      aliases: { fixture: { id: mutated.manifest.id, version: 1 } },
      manifests: new Map([["fixture/command@1", mutated]]),
      normalized: canonicalJson({
        aliases: { fixture: { id: mutated.manifest.id, version: 1 } },
        manifests: [{ id: mutated.manifest.id, version: 1, digest: mutated.digest }],
      }),
      digest: digestNormalized(canonicalJson({
        aliases: { fixture: { id: mutated.manifest.id, version: 1 } },
        manifests: [{ id: mutated.manifest.id, version: 1, digest: mutated.digest }],
      })),
    };
    expect(() => pipelines.acceptCatalog(mutatedCatalog)).toThrow(/different digest/);

    const v2Value = JSON.parse(v1.normalized) as Record<string, unknown>;
    v2Value.version = 3;
    v2Value.description = "A compatible future command fixture.";
    const v2 = validatePipelineManifest(v2Value, { runtime: runtime.descriptor });
    const moved: ValidatedPipelineCatalog = {
      aliases: { "fixture-command": { id: v2.manifest.id, version: 3 } },
      manifests: new Map([["fixture/command@1", v1], ["fixture/command@3", v2]]),
      normalized: canonicalJson({
        aliases: { "fixture-command": { id: v2.manifest.id, version: 3 } },
        manifests: [v1, v2].map((entry) => ({
          id: entry.manifest.id,
          version: entry.manifest.version,
          digest: entry.digest,
        })),
      }),
      digest: digestNormalized(canonicalJson({
        aliases: { "fixture-command": { id: v2.manifest.id, version: 3 } },
        manifests: [v1, v2].map((entry) => ({
          id: entry.manifest.id,
          version: entry.manifest.version,
          digest: entry.digest,
        })),
      })),
    };
    pipelines.acceptCatalog(moved);

    for (const [sessionId, manifest] of [["session-v1", v1], ["session-v2", v2]] as const) {
      tickets.upsert({
        ...ticket(sessionId),
        pipeline: {
          repository: "owner/repo",
          baseCommit: "a".repeat(40),
          manifest,
          repositoryConfig: snapshot,
          runtime,
          authorizedCapabilities: manifest.manifest.requires.capabilities,
          taskType: "implement",
        },
      });
    }
    expect(pipelines.getInstanceForSession("session-v1")?.pipeline_version).toBe(1);
    expect(pipelines.getInstanceForSession("session-v2")?.pipeline_version).toBe(3);
  });

  it("keeps accepted structured versions immutable while admitting graph-scoped lead v3", () => {
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const runtimeDescriptor = buildInstalledRuntimeDescriptor("structured-catalog-test/v1");
    pipelines.acceptRuntimeDescriptor(runtimeDescriptor);
    const legacyV1 = parseAndCompileExecutionGraph(readFileSync(structuredV1GraphPath, "utf8"), {
      source: "builtin:core/structured@1",
      id: "builtin/structured",
      version: 1,
      description: "Compiled execution graph structured from builtin core/structured@1.",
      maxAttempts: 200,
      runtime: runtimeDescriptor.descriptor,
    }).manifest;
    const repairedV2 = parseAndCompileExecutionGraph(readFileSync(structuredV2GraphPath, "utf8"), {
      source: "builtin:core/structured@2",
      id: "builtin/structured",
      version: 2,
      description: "Compiled execution graph structured from builtin core/structured@2.",
      maxAttempts: 200,
      runtime: runtimeDescriptor.descriptor,
      aggregatePublishContext: "prefer_resume",
    }).manifest;
    const graphScopedLeadV3 = parseAndCompileExecutionGraph(readFileSync(structuredV3GraphPath, "utf8"), {
      source: "builtin:core/structured@3",
      id: "builtin/structured",
      version: 3,
      description: "Compiled execution graph structured from builtin core/structured@3.",
      maxAttempts: 200,
      runtime: runtimeDescriptor.descriptor,
      aggregatePublishContext: "prefer_resume",
    }).manifest;
    expect(legacyV1.digest).toBe(legacyStructuredV1Digest);
    db.prepare(`
      INSERT INTO pipeline_catalog_entries (
        pipeline_id, version, digest, normalized_manifest, accepted_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run("builtin/structured", 1, legacyStructuredV1Digest, legacyV1.normalized, new Date(0).toISOString());

    expect(() => pipelines.acceptManifest(legacyV1)).not.toThrow();
    const changedLegacyManifest = JSON.parse(legacyV1.normalized) as Record<string, unknown>;
    const changedLegacyV1 = validatePipelineManifest({
      ...changedLegacyManifest,
      description: "Changed legacy structured v1 bytes.",
    }, { source: "builtin:core/structured@1", runtime: runtimeDescriptor.descriptor });
    expect(changedLegacyV1.digest).not.toBe(legacyStructuredV1Digest);
    expect(() => pipelines.acceptManifest(changedLegacyV1)).toThrow(/different digest/);
    pipelines.acceptManifest(repairedV2);
    expect(() => pipelines.acceptManifest(repairedV2)).not.toThrow();
    pipelines.acceptManifest(graphScopedLeadV3);
    expect(() => pipelines.acceptManifest(graphScopedLeadV3)).not.toThrow();

    expect(db.prepare(`
      SELECT pipeline_id, version, digest FROM pipeline_catalog_entries
      WHERE pipeline_id = 'builtin/structured'
      ORDER BY version
    `).all()).toEqual([
      { pipeline_id: "builtin/structured", version: 1, digest: legacyV1.digest },
      { pipeline_id: "builtin/structured", version: 2, digest: repairedV2.digest },
      { pipeline_id: "builtin/structured", version: 3, digest: graphScopedLeadV3.digest },
    ]);
    expect(legacyV1.digest).not.toBe(repairedV2.digest);
    expect(repairedV2.digest).not.toBe(graphScopedLeadV3.digest);
  });

  it("re-admits an unchanged repository graph with a direct aggregate publish edge", () => {
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const runtimeDescriptor = buildInstalledRuntimeDescriptor("repository-graph-catalog-test/v1", {
      capabilities: [
        ...buildInstalledRuntimeDescriptor("repository-graph-base/v1").descriptor.capabilities,
        "accept-unit@1",
        "graph/for-each-unit@1",
      ],
    });
    pipelines.acceptRuntimeDescriptor(runtimeDescriptor);
    const repositoryGraph = {
      schema: "openthrottle.graph/v1",
      id: "repository/direct-aggregate-publish",
      version: 3,
      entry_node: "units",
      workers: [{
        id: "worker",
        engine: "agent",
        skills: ["builtin://ce/implement@1"],
        allowed_mcp_servers: [],
        session_scope: "attempt",
        credentials: ["model.invoke", "provider.read", "repo.read"],
      }, {
        id: "lead-worker",
        engine: "agent",
        skills: ["builtin://accept-unit@1"],
        allowed_mcp_servers: [],
        session_scope: "fresh",
        credentials: ["model.invoke", "repo.read"],
      }],
      loops: [{
        id: "loop",
        worker: "worker",
        skill: "builtin://ce/implement@1",
        input_scope: "unit",
        receipt: "unit_completion",
        max_parallel: 1,
        max_rounds: 1,
        timeout_seconds: 60,
      }, {
        id: "lead-loop",
        worker: "lead-worker",
        skill: "builtin://accept-unit@1",
        input_scope: "unit",
        receipt: "unit_decision",
        max_parallel: 1,
        max_rounds: 1,
        timeout_seconds: 60,
      }],
      nodes: [{
        id: "units",
        kind: "for_each_unit",
        phases: [
          { id: "implement", kind: "agent", loop: "loop" },
          { id: "candidate", kind: "evidence" },
          { id: "lead", kind: "gate", loop: "lead-loop" },
          { id: "integrate", kind: "integrate" },
        ],
        depends_on: [],
        transitions: {
          success: { to: "publish" },
          repair_required: { terminal: "needs_human" },
          retryable_failure: { terminal: "failed" },
          failure: { terminal: "failed" },
        },
      }, {
        id: "publish",
        kind: "publish",
        depends_on: [],
        transitions: {
          success: { terminal: "completed" },
          repair_required: { terminal: "needs_human" },
          retryable_failure: { terminal: "failed" },
          failure: { terminal: "failed" },
        },
      }],
    };
    const manifest = parseAndCompileExecutionGraph(JSON.stringify(repositoryGraph), {
      source: "owner/repo@005a0a89783b92a72518ce0ab04e287c9a4ad31e:.openthrottle/graphs/structured.json",
      id: "repository/direct-aggregate-publish",
      version: 3,
      description: "Compiled repository graph direct aggregate publish fixture.",
      maxAttempts: 200,
      runtime: runtimeDescriptor.descriptor,
    }).manifest;

    expect(manifest.digest).toBe("fd1d1345f05a8bf8d77a2d867be7f47d462447862147e0e3a5af074b6ba34984");
    expect(manifest.manifest.stages.find((stage) => stage.id === "publish")?.context).toBe("resume_required");
    db.prepare(`
      INSERT INTO pipeline_catalog_entries (
        pipeline_id, version, digest, normalized_manifest, accepted_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(manifest.manifest.id, manifest.manifest.version, manifest.digest, manifest.normalized, new Date(0).toISOString());

    expect(() => pipelines.acceptManifest(manifest)).not.toThrow();
    expect(pipelines.getAcceptedManifestDigest(manifest.manifest.id, manifest.manifest.version)).toBe(manifest.digest);
  });

  it("revalidates pinned hashes and restricts deletion of audit-bearing parents", () => {
    const setup = setupPipelineStore();
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
    const manifest = catalog.manifests.get("fixture/agent@1")!;
    tickets.upsert({
      ...ticket("audit-session"),
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: snapshot,
        runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
      },
    });
    const instance = pipelines.getInstanceForSession("audit-session")!;
    expect(() => db!.prepare(
      "DELETE FROM pipeline_catalog_entries WHERE pipeline_id = ? AND version = ?"
    ).run(manifest.manifest.id, manifest.manifest.version)).toThrow(/FOREIGN KEY/);

    db!.prepare("UPDATE pipeline_instances SET normalized_manifest = ? WHERE id = ?")
      .run("{}", instance.id);
    expect(() => pipelines.getInstance(instance.id)).toThrow(/manifest digest mismatch/);
  });

  it("upgrades the current catalog and runtime without rewriting accepted v1 history", () => {
    const directory = mkdtempSync(join(tmpdir(), "openthrottle-pipeline-upgrade-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "supervisor.db");
    const changedV1Runtime = buildInstalledRuntimeDescriptor("openthrottle-snapshot/v1");

    db = openDb(path);
    const historical = seedRetiredPipelineHistory(db);
    db.close();

    db = openDb(path);
    const recovered = createPipelineStore(db);
    expect(changedV1Runtime.digest).not.toBe(historical.runtime.digest);
    expect(() => recovered.acceptRuntimeDescriptor(changedV1Runtime))
      .toThrow(/runtime release openthrottle-snapshot\/v1 was already accepted with a different digest/);

    const shippedRuntime = loadRuntimeCapabilityDescriptor(runtimeDescriptorPath, "openthrottle-snapshot/v14");
    const shippedCatalog = loadPipelineCatalog(shippedCatalogPath, shippedRuntime.descriptor);
    recovered.acceptRuntimeDescriptor(shippedRuntime);
    recovered.acceptCatalog(shippedCatalog);

    expect(db.prepare(`
      SELECT runtime_release, digest FROM runtime_capability_descriptors ORDER BY runtime_release
    `).all()).toEqual([
      { runtime_release: "openthrottle-snapshot/v1", digest: historical.runtime.digest },
      { runtime_release: "openthrottle-snapshot/v14", digest: shippedRuntime.digest },
    ]);
    expect(db.prepare(`
      SELECT pipeline_id, version, digest FROM pipeline_catalog_entries
      WHERE pipeline_id IN ('ce/implement', 'ce/investigate', 'core/implement', 'core/investigate')
      ORDER BY pipeline_id, version
    `).all()).toEqual([
      { pipeline_id: "ce/implement", version: 1, digest: historical.manifests.get("ce/implement@1")!.digest },
      { pipeline_id: "ce/investigate", version: 1, digest: historical.manifests.get("ce/investigate@1")!.digest },
      { pipeline_id: "core/implement", version: 4, digest: shippedCatalog.manifests.get("core/implement@4")!.digest },
      { pipeline_id: "core/investigate", version: 1, digest: shippedCatalog.manifests.get("core/investigate@1")!.digest },
    ]);
    expect(db.prepare(`
      SELECT alias, pipeline_id, version FROM pipeline_catalog_aliases
      WHERE alias IN ('implement', 'investigate') ORDER BY alias
    `).all()).toEqual([
      { alias: "implement", pipeline_id: "core/implement", version: 4 },
      { alias: "investigate", pipeline_id: "core/investigate", version: 1 },
    ]);
  });

  it("fails closed on boot when a prior runtime release row has a different digest", () => {
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const currentV2 = buildInstalledRuntimeDescriptor("openthrottle-snapshot/v2");
    const priorNormalized = canonicalJson({
      ...currentV2.descriptor,
      adapters: { ...currentV2.descriptor.adapters, codex: "prior-snapshot" },
    });
    const priorDigest = digestNormalized(priorNormalized);
    expect(priorDigest).not.toBe(currentV2.digest);
    db.prepare(`
      INSERT INTO runtime_capability_descriptors (
        runtime_release, digest, protocol, normalized_descriptor, accepted_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      currentV2.descriptor.release,
      priorDigest,
      currentV2.descriptor.protocol,
      priorNormalized,
      "2026-07-27T00:00:00.000Z"
    );

    expect(() => pipelines.acceptRuntimeDescriptor(currentV2))
      .toThrow(/runtime release openthrottle-snapshot\/v2 was already accepted with a different digest/);

    const bumped = buildInstalledRuntimeDescriptor("openthrottle-snapshot/v9");
    pipelines.acceptRuntimeDescriptor(bumped);

    expect(db.prepare(`
      SELECT runtime_release, digest FROM runtime_capability_descriptors ORDER BY runtime_release
    `).all()).toEqual([
      { runtime_release: "openthrottle-snapshot/v2", digest: priorDigest },
      { runtime_release: "openthrottle-snapshot/v9", digest: bumped.digest },
    ]);
  });
});
