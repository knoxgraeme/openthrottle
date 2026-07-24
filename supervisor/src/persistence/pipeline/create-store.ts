import type Database from "better-sqlite3";
import type { PipelineInstance, PipelineStore } from "../../pipeline/store.js";
import { createCatalogStore } from "./catalog-store.js";
import { createEffectStore } from "./effect-store.js";
import { persistSelectionPublications } from "./helpers.js";
import { createInstanceStore } from "./instance-store.js";
import { createPublicationStore } from "./publication-store.js";
import { createResourceStore } from "./resource-store.js";
import { createStatusStore } from "./status-store.js";
import { createTransitionStore } from "./transition-store.js";

function seedMissingSelectionPublications(db: Database.Database, now: () => string): void {
  db.transaction(() => {
    const timestamp = now();
    const instances = db.prepare(`
      SELECT * FROM pipeline_instances pi
      WHERE pi.status NOT IN ('shipped', 'no_change', 'needs_human', 'canceled', 'superseded', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM pipeline_publication_receipts ppr
          WHERE ppr.pipeline_instance_id = pi.id AND ppr.kind = 'linear_ledger'
        )
    `).all() as PipelineInstance[];
    for (const instance of instances) {
      persistSelectionPublications({ db, instance, timestamp });
    }
  })();
}

export function createPipelineStore(db: Database.Database): PipelineStore {
  const now = () => new Date().toISOString();
  seedMissingSelectionPublications(db, now);

  return {
    ...createCatalogStore(db, now),
    ...createInstanceStore(db, now),
    ...createResourceStore(db, now),
    ...createPublicationStore(db, now),
    ...createStatusStore(db),
    ...createEffectStore(db, now),
    ...createTransitionStore(db, now),
  };
}
