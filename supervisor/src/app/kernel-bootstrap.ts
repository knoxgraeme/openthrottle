import { openFreshEpochDatabase } from "../persistence/epoch-database.js";
import { VolumeBlobStore } from "../persistence/blob-store.js";

export interface KernelEpochResources {
  db: ReturnType<typeof openFreshEpochDatabase>;
  blobs: VolumeBlobStore;
}

/** Opens exactly the fresh execution epoch; it never probes or migrates an old DB. */
export function openKernelEpoch(input: {
  database_path: string;
  blob_store_path: string;
  blob_store_id: string;
  release_id: string;
  runtime_capability_digest: string;
  bootstrap_checksum: string;
}): KernelEpochResources {
  if (!/^[a-f0-9]{64}$/.test(input.runtime_capability_digest)) {
    throw new Error("runtime_capability_digest must be a lowercase SHA-256 digest");
  }
  if (!/^[a-f0-9]{64}$/.test(input.bootstrap_checksum)) {
    throw new Error("bootstrap_checksum must be a lowercase SHA-256 digest");
  }
  const blobs = VolumeBlobStore.open(input.blob_store_path, input.blob_store_id);
  const db = openFreshEpochDatabase({
    database_path: input.database_path,
    blob_store: blobs,
    expected_identity: {
      release_id: input.release_id,
      runtime_capability_digest: input.runtime_capability_digest,
      blob_store_id: blobs.store_id,
      blob_marker_checksum: blobs.marker_checksum,
      bootstrap_checksum: input.bootstrap_checksum,
    },
  });
  return { db, blobs };
}
