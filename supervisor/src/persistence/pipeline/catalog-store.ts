import type Database from "better-sqlite3";
import {
  canonicalJson,
  type ValidatedPipelineCatalog,
  type ValidatedRepositoryConfig,
} from "../../pipeline/manifest.js";
import type { ValidatedRuntimeCapabilityDescriptor } from "../../sandbox-runtime.js";
import type { PipelineStore, RepositoryConfigSnapshot } from "../../pipeline/store.js";
import { assertDigest, deterministicId } from "./helpers.js";

export function createCatalogStore(db: Database.Database, now: () => string): Pick<
  PipelineStore,
  "acceptCatalog" | "acceptRuntimeDescriptor" | "saveRepositoryConfigSnapshot"
> {
  const acceptCatalog = db.transaction((catalog: ValidatedPipelineCatalog) => {
    assertDigest("pipeline catalog", catalog.normalized, catalog.digest);
    const expectedCatalog = canonicalJson({
      aliases: catalog.aliases,
      manifests: [...catalog.manifests.values()].map((entry) => ({
        id: entry.manifest.id,
        version: entry.manifest.version,
        digest: entry.digest,
      })).sort((left, right) =>
        `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`)
      ),
    });
    if (catalog.normalized !== expectedCatalog) {
      throw new Error("pipeline catalog normalized content mismatch");
    }
    for (const validated of catalog.manifests.values()) {
      assertDigest(`${validated.manifest.id}@${validated.manifest.version}`, validated.normalized, validated.digest);
      if (canonicalJson(validated.manifest) !== validated.normalized) {
        throw new Error(`pipeline ${validated.manifest.id}@${validated.manifest.version} normalized content mismatch`);
      }
      const existing = db.prepare(
        "SELECT digest, normalized_manifest FROM pipeline_catalog_entries WHERE pipeline_id = ? AND version = ?"
      ).get(validated.manifest.id, validated.manifest.version) as
        | { digest: string; normalized_manifest: string }
        | undefined;
      if (existing && (existing.digest !== validated.digest || existing.normalized_manifest !== validated.normalized)) {
        throw new Error(`pipeline ${validated.manifest.id}@${validated.manifest.version} was already accepted with a different digest`);
      }
      db.prepare(`
        INSERT OR IGNORE INTO pipeline_catalog_entries (
          pipeline_id, version, digest, normalized_manifest, accepted_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(validated.manifest.id, validated.manifest.version, validated.digest, validated.normalized, now());
    }
    for (const [alias, reference] of Object.entries(catalog.aliases)) {
      const validated = catalog.manifests.get(`${reference.id}@${reference.version}`);
      if (!validated) throw new Error(`catalog alias ${alias} references an absent manifest`);
      db.prepare(`
        INSERT INTO pipeline_catalog_aliases(alias, pipeline_id, version, digest, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(alias) DO UPDATE SET
          pipeline_id = excluded.pipeline_id,
          version = excluded.version,
          digest = excluded.digest,
          updated_at = excluded.updated_at
      `).run(alias, reference.id, reference.version, validated.digest, now());
    }
  });

  const acceptRuntimeDescriptor = db.transaction((runtime: ValidatedRuntimeCapabilityDescriptor) => {
    assertDigest(`runtime ${runtime.descriptor.release}`, runtime.normalized, runtime.digest);
    if (canonicalJson(runtime.descriptor) !== runtime.normalized) {
      throw new Error(`runtime release ${runtime.descriptor.release} normalized content mismatch`);
    }
    const existing = db.prepare(
      "SELECT digest, normalized_descriptor FROM runtime_capability_descriptors WHERE runtime_release = ?"
    ).get(runtime.descriptor.release) as { digest: string; normalized_descriptor: string } | undefined;
    if (existing && (existing.digest !== runtime.digest || existing.normalized_descriptor !== runtime.normalized)) {
      throw new Error(`runtime release ${runtime.descriptor.release} was already accepted with a different digest`);
    }
    db.prepare(`
      INSERT OR IGNORE INTO runtime_capability_descriptors (
        runtime_release, digest, protocol, normalized_descriptor, accepted_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(runtime.descriptor.release, runtime.digest, runtime.descriptor.protocol, runtime.normalized, now());
  });

  const saveRepositoryConfigSnapshot = db.transaction((input: {
    id?: string;
    repository: string;
    baseCommit: string;
    blobSha: string;
    config: ValidatedRepositoryConfig;
  }): RepositoryConfigSnapshot => {
    assertDigest("repository config", input.config.normalized, input.config.digest);
    if (canonicalJson(input.config.config) !== input.config.normalized) {
      throw new Error("repository config normalized content mismatch");
    }
    const id = input.id ?? deterministicId("repo-config", [
      input.repository, input.baseCommit, input.blobSha, input.config.digest,
    ]);
    const existing = db.prepare("SELECT * FROM repository_config_snapshots WHERE id = ?").get(id) as RepositoryConfigSnapshot | undefined;
    if (existing) {
      if (
        existing.repository !== input.repository || existing.base_commit !== input.baseCommit ||
        existing.blob_sha !== input.blobSha || existing.digest !== input.config.digest ||
        existing.normalized_config !== input.config.normalized
      ) throw new Error(`repository config snapshot ${id} already exists with different content`);
      return existing;
    }
    db.prepare(`
      INSERT INTO repository_config_snapshots (
        id, repository, base_commit, blob_sha, digest, normalized_config, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.repository, input.baseCommit, input.blobSha, input.config.digest, input.config.normalized, now());
    return db.prepare("SELECT * FROM repository_config_snapshots WHERE id = ?").get(id) as RepositoryConfigSnapshot;
  });

  return { acceptCatalog, acceptRuntimeDescriptor, saveRepositoryConfigSnapshot };
}
