import type Database from "better-sqlite3";
import type { PipelineStore } from "../../pipeline/store.js";
import { createCatalogStore } from "./catalog-store.js";
import { createEffectStore } from "./effect-store.js";
import { createInstanceStore } from "./instance-store.js";
import { createJournalStore } from "./journal-store.js";
import { createPublicationStore } from "./publication-store.js";
import { createStatusStore } from "./status-store.js";
import { createTransitionStore } from "./transition-store.js";
import { createExecutionUnitStore } from "./unit-store.js";

export function createPipelineStore(db: Database.Database): PipelineStore {
  const now = () => new Date().toISOString();

  return {
    ...createCatalogStore(db, now),
    ...createInstanceStore(db, now),
    ...createPublicationStore(db, now),
    ...createStatusStore(db),
    ...createEffectStore(db, now),
    ...createTransitionStore(db, now),
    ...createJournalStore(db, now),
    ...createExecutionUnitStore(db, now),
  };
}
