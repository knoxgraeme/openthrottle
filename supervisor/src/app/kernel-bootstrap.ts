import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createFreshEpochBootstrap,
  openOrInitializeFreshEpochDatabase,
  type FreshEpochBootstrapContent,
} from "../persistence/epoch-database.js";
import { VolumeBlobStore } from "../persistence/blob-store.js";

export interface KernelEpochResources {
  db: ReturnType<typeof openOrInitializeFreshEpochDatabase>;
  blobs: VolumeBlobStore;
}

const EMPTY_BOOTSTRAP: FreshEpochBootstrapContent = {
  schema: "openthrottle.fresh-epoch-bootstrap/v1",
  settings: [],
  repository_registrations: [],
};

/** Opens exactly the fresh execution epoch; it never probes or migrates an old DB. */
export function openKernelEpoch(input: {
  database_path: string;
  blob_store_path: string;
  blob_store_id: string;
  release_id: string;
  bootstrap?: FreshEpochBootstrapContent;
  now?: () => string;
}): KernelEpochResources {
  mkdirSync(dirname(input.database_path), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(input.blob_store_path), { recursive: true, mode: 0o700 });
  const blobs = existsSync(input.blob_store_path)
    ? VolumeBlobStore.open(input.blob_store_path, input.blob_store_id)
    : VolumeBlobStore.initialize(input.blob_store_path, input.blob_store_id);
  const db = openOrInitializeFreshEpochDatabase({
    database_path: input.database_path,
    blob_store: blobs,
    release_id: input.release_id,
    bootstrap: createFreshEpochBootstrap(input.bootstrap ?? EMPTY_BOOTSTRAP),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return { db, blobs };
}
