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

  it("keeps the exact legacy structured v1 catalog entry immutable while admitting repaired structured v2", () => {
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

    expect(db.prepare(`
      SELECT pipeline_id, version, digest FROM pipeline_catalog_entries
      WHERE pipeline_id = 'builtin/structured'
      ORDER BY version
    `).all()).toEqual([
      { pipeline_id: "builtin/structured", version: 1, digest: legacyV1.digest },
      { pipeline_id: "builtin/structured", version: 2, digest: repairedV2.digest },
    ]);
    expect(legacyV1.digest).not.toBe(repairedV2.digest);
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

    const shippedRuntime = loadRuntimeCapabilityDescriptor(runtimeDescriptorPath, "openthrottle-snapshot/v9");
    const shippedCatalog = loadPipelineCatalog(shippedCatalogPath, shippedRuntime.descriptor);
    recovered.acceptRuntimeDescriptor(shippedRuntime);
    recovered.acceptCatalog(shippedCatalog);

    expect(db.prepare(`
      SELECT runtime_release, digest FROM runtime_capability_descriptors ORDER BY runtime_release
    `).all()).toEqual([
      { runtime_release: "openthrottle-snapshot/v1", digest: historical.runtime.digest },
      { runtime_release: "openthrottle-snapshot/v9", digest: shippedRuntime.digest },
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
