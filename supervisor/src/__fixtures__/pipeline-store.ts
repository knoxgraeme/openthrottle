import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import {
  canonicalJson,
  digestNormalized,
  loadPipelineCatalog,
  parseRepositoryConfig,
  type ValidatedPipelineCatalog,
} from "../pipeline/manifest.js";
import { createPipelineStore } from "../persistence/pipeline/create-store.js";
import { buildInstalledRuntimeDescriptor } from "../sandbox-runtime.js";

export const catalogPath = fileURLToPath(new URL("./pipelines/catalog.yaml", import.meta.url));
export const shippedCatalogPath = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));
export const runtimeDescriptorPath = fileURLToPath(new URL("../../pipelines/runtime-capabilities-v1.json", import.meta.url));
export const retiredHistoryPath = fileURLToPath(new URL("./retired-pipeline-history-v1.json", import.meta.url));
export const runtime = buildInstalledRuntimeDescriptor("test-runtime/v1");

export function seedRetiredPipelineHistory(database: Database.Database) {
  const fixture = JSON.parse(readFileSync(retiredHistoryPath, "utf8")) as {
    runtime: { release: string; protocol: string };
    aliases: Record<string, { id: string; version: number }>;
    manifests: Array<{ id: string; version: number }>;
  };
  const runtimeNormalized = canonicalJson(fixture.runtime);
  const historicalRuntime = { normalized: runtimeNormalized, digest: digestNormalized(runtimeNormalized) };
  database.prepare(`
    INSERT INTO runtime_capability_descriptors (
      runtime_release, digest, protocol, normalized_descriptor, accepted_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(fixture.runtime.release, historicalRuntime.digest, fixture.runtime.protocol, runtimeNormalized, "2026-07-21T00:00:00.000Z");
  const manifests = new Map<string, { digest: string }>();
  for (const manifest of fixture.manifests) {
    const normalized = canonicalJson(manifest);
    const digest = digestNormalized(normalized);
    database.prepare(`
      INSERT INTO pipeline_catalog_entries (
        pipeline_id, version, digest, normalized_manifest, accepted_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(manifest.id, manifest.version, digest, normalized, "2026-07-21T00:00:00.000Z");
    manifests.set(`${manifest.id}@${manifest.version}`, { digest });
  }
  for (const [alias, reference] of Object.entries(fixture.aliases)) {
    const manifest = manifests.get(`${reference.id}@${reference.version}`)!;
    database.prepare(`
      INSERT INTO pipeline_catalog_aliases(alias, pipeline_id, version, digest, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(alias, reference.id, reference.version, manifest.digest, "2026-07-21T00:00:00.000Z");
  }
  return { runtime: historicalRuntime, manifests };
}

export function setupPipelineStore(dbPath = ":memory:", selectedCatalogPath = catalogPath) {
  const db = openDb(dbPath);
  const pipelines = createPipelineStore(db);
  const tickets = createSupervisorStore(db, pipelines);
  const catalog = loadPipelineCatalog(selectedCatalogPath, runtime.descriptor);
  pipelines.acceptRuntimeDescriptor(runtime);
  pipelines.acceptCatalog(catalog);
  const config = parseRepositoryConfig("pipelines: { implement: implement }\n");
  const snapshot = pipelines.saveRepositoryConfigSnapshot({
    repository: "owner/repo",
    baseCommit: "a".repeat(40),
    blobSha: "b".repeat(40),
    config,
  });
  return { db, tickets, pipelines, catalog, snapshot, runtime };
}

export function ticket(sessionId: string, issueId = `issue-${sessionId}`) {
  return {
    linear_issue_id: issueId,
    linear_issue_identifier: issueId.toUpperCase(),
    linear_session_id: sessionId,
    sandbox_id: null,
    branch: `ot/${issueId}`,
    agent: "codex" as const,
    repo: "owner/repo",
    pr_url: null,
    state: "active" as const,
  };
}

export type { ValidatedPipelineCatalog };
