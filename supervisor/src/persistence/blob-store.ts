import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  canonicalJson,
  digestNormalized,
  validateBlobPointer,
  type BlobPointer,
} from "@openthrottle/contracts";

const ROOT_MARKER = ".openthrottle-blob-store.json";
const ROOT_MARKER_SCHEMA = "openthrottle.volume-blob-store/v1";
const TOKEN_SECRET = Symbol("verified OpenThrottle blob");
const SHA256 = /^[a-f0-9]{64}$/;
const STORE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MAX_MARKER_BYTES = 4 * 1024;

export type BlobWriteStep =
  | "shard_parent_synced"
  | "temporary_opened"
  | "temporary_written"
  | "temporary_synced"
  | "temporary_verified"
  | "published"
  | "directory_synced"
  | "final_verified";

export interface BlobWriteInput {
  bytes: string | Uint8Array;
  encoding: "utf-8" | "binary";
  media_type: string;
  payload_schema: string;
  expected_digest?: string;
}

export interface VolumeBlobStoreOptions {
  fault_injector?: (step: BlobWriteStep) => void;
  sync_directory?: (path: string) => void;
}

interface RootMarkerContent {
  schema: typeof ROOT_MARKER_SCHEMA;
  store_id: string;
}

interface RootMarker extends RootMarkerContent {
  checksum: string;
}

interface ObjectIdentity {
  device: bigint;
  inode: bigint;
}

export class BlobIntegrityError extends Error {
  readonly code = "BLOB_INTEGRITY";

  constructor(
    readonly digest: string,
    readonly detail: string,
  ) {
    super(`blob ${digest} failed integrity verification: ${detail}`);
    this.name = "BlobIntegrityError";
  }
}

export class BlobAvailabilityError extends Error {
  readonly code = "BLOB_UNAVAILABLE";

  constructor(
    readonly digest: string,
    readonly system_code: string,
  ) {
    super(`blob ${digest} is temporarily unavailable (${system_code})`);
    this.name = "BlobAvailabilityError";
  }
}

/**
 * An unforgeable proof that one exact pointer was present and verified in one
 * store. Database writers accept this token, never a caller-authored digest.
 */
export class VerifiedBlobToken {
  readonly #identity: ObjectIdentity;
  readonly #secret: symbol;

  constructor(
    secret: symbol,
    readonly store_id: string,
    readonly pointer: BlobPointer,
    identity: ObjectIdentity,
  ) {
    if (secret !== TOKEN_SECRET) throw new Error("verified blob tokens are store-authored");
    this.#secret = secret;
    this.#identity = identity;
    Object.freeze(this.pointer);
    Object.freeze(this);
  }

  _assertAuthority(secret: symbol, storeId: string): ObjectIdentity {
    if (this.#secret !== secret || secret !== TOKEN_SECRET || this.store_id !== storeId) {
      throw new Error("blob token belongs to another store");
    }
    return this.#identity;
  }
}

function sha256(bytes: Uint8Array | string): string {
  return digestNormalized(bytes);
}

function markerFor(storeId: string): RootMarker {
  const content: RootMarkerContent = { schema: ROOT_MARKER_SCHEMA, store_id: storeId };
  return { ...content, checksum: sha256(canonicalJson(content)) };
}

function assertStoreId(storeId: string): void {
  if (!STORE_ID.test(storeId)) throw new Error("invalid blob store identity");
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(fd);
    if (!stats.isDirectory()) throw new Error(`expected directory at ${path}`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function assertRegularFile(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`managed blob path is not a regular file: ${path}`);
  }
}

function ensureManagedDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`managed blob path is not a directory: ${path}`);
  }
}

function readMarker(root: string): RootMarker {
  const markerPath = join(root, ROOT_MARKER);
  try {
    assertRegularFile(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("blob root marker is missing");
    }
    throw error;
  }
  const stats = statSync(markerPath);
  if (stats.size <= 0 || stats.size > MAX_MARKER_BYTES) {
    throw new Error("blob root marker has an invalid size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    throw new Error("blob root marker is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("blob root marker must be an object");
  }
  const input = parsed as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(",") !== "checksum,schema,store_id" ||
    input.schema !== ROOT_MARKER_SCHEMA ||
    typeof input.store_id !== "string" ||
    typeof input.checksum !== "string"
  ) {
    throw new Error("blob root marker has an unknown shape");
  }
  assertStoreId(input.store_id);
  const expected = markerFor(input.store_id);
  if (input.checksum !== expected.checksum || canonicalJson(input) !== canonicalJson(expected)) {
    throw new Error("blob root marker checksum mismatch");
  }
  return expected;
}

function removeStagingRoot(stagingRoot: string): void {
  const name = basename(stagingRoot);
  if (!name.includes(".blob-init-")) throw new Error("refusing to remove an unrecognized staging root");
  rmSync(stagingRoot, { recursive: true, force: true });
}

export class VolumeBlobStore {
  readonly root: string;
  readonly store_id: string;
  readonly marker_checksum: string;
  readonly #objectsRoot: string;
  readonly #faultInjector: ((step: BlobWriteStep) => void) | undefined;
  readonly #syncDirectory: (path: string) => void;
  readonly #syncedShardEntries = new Set<string>();

  private constructor(root: string, marker: RootMarker, options: VolumeBlobStoreOptions) {
    this.root = root;
    this.store_id = marker.store_id;
    this.marker_checksum = marker.checksum;
    this.#objectsRoot = join(root, "objects", "sha256");
    this.#faultInjector = options.fault_injector;
    this.#syncDirectory = options.sync_directory ?? fsyncDirectory;
  }

  static initialize(
    rootPath: string,
    storeId: string,
    options: VolumeBlobStoreOptions = {},
  ): VolumeBlobStore {
    assertStoreId(storeId);
    const absolute = resolve(rootPath);
    if (!isAbsolute(absolute)) throw new Error("blob root must be absolute");
    const parent = realpathSync(dirname(absolute));
    const root = join(parent, basename(absolute));
    if (existsSync(root)) throw new Error(`blob root already exists: ${root}`);

    const stagingRoot = join(parent, `.${basename(root)}.blob-init-${randomUUID()}`);
    try {
      mkdirSync(stagingRoot, { mode: 0o700 });
      ensureManagedDirectory(join(stagingRoot, "objects"));
      ensureManagedDirectory(join(stagingRoot, "objects", "sha256"));
      const marker = markerFor(storeId);
      const markerPath = join(stagingRoot, ROOT_MARKER);
      const fd = openSync(
        markerPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, canonicalJson(marker), { encoding: "utf8" });
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDirectory(join(stagingRoot, "objects", "sha256"));
      fsyncDirectory(join(stagingRoot, "objects"));
      fsyncDirectory(stagingRoot);
      if (existsSync(root)) throw new Error(`blob root appeared during initialization: ${root}`);
      renameSync(stagingRoot, root);
      fsyncDirectory(parent);
    } catch (error) {
      if (existsSync(stagingRoot)) removeStagingRoot(stagingRoot);
      throw error;
    }
    return VolumeBlobStore.open(root, storeId, options);
  }

  static open(
    rootPath: string,
    expectedStoreId?: string,
    options: VolumeBlobStoreOptions = {},
  ): VolumeBlobStore {
    const rootStats = lstatSync(rootPath);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error("blob root must be a real directory");
    }
    const root = realpathSync(rootPath);
    const marker = readMarker(root);
    if (expectedStoreId !== undefined && marker.store_id !== expectedStoreId) {
      throw new Error(`blob root identity mismatch: expected ${expectedStoreId}`);
    }
    const objects = join(root, "objects");
    const shaRoot = join(objects, "sha256");
    for (const path of [objects, shaRoot]) {
      const stats = lstatSync(path);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`blob store managed path is unsafe: ${path}`);
      }
    }
    return new VolumeBlobStore(root, marker, options);
  }

  assertSameVolume(targetPath: string): void {
    const absoluteTarget = resolve(targetPath);
    const canonicalTarget = existsSync(absoluteTarget)
      ? realpathSync(absoluteTarget)
      : join(realpathSync(dirname(absoluteTarget)), basename(absoluteTarget));
    const withinRoot = relative(this.root, canonicalTarget);
    if (withinRoot === "" || (!withinRoot.startsWith("..") && !isAbsolute(withinRoot))) {
      throw new Error("database path must be outside the blob root");
    }
    const targetStats = existsSync(absoluteTarget)
      ? statSync(absoluteTarget, { bigint: true })
      : statSync(realpathSync(dirname(absoluteTarget)), { bigint: true });
    const rootStats = statSync(this.root, { bigint: true });
    if (targetStats.dev !== rootStats.dev) {
      throw new Error("database and blob store must be on the same volume");
    }
  }

  /**
   * Confirms this is the exact empty root published by initialize(), rather
   * than merely a valid BlobStore with no currently referenced objects.
   */
  assertEmpty(): void {
    const exactEntries = (path: string, expected: readonly string[], detail: string): void => {
      const actual = readdirSync(path).sort();
      if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
        throw new Error(`blob store is not empty: ${detail}`);
      }
    };
    exactEntries(this.root, [ROOT_MARKER, "objects"], "root has unexpected entries");
    exactEntries(dirname(this.#objectsRoot), ["sha256"], "objects directory has unexpected entries");
    if (readdirSync(this.#objectsRoot).length > 0) {
      throw new Error("blob store is not empty: object directory contains data");
    }
  }

  objectPath(digest: string): string {
    if (!SHA256.test(digest)) throw new Error("invalid sha256 blob digest");
    return join(this.#objectsRoot, digest.slice(0, 2), digest.slice(2));
  }

  put(input: BlobWriteInput): VerifiedBlobToken {
    const bytes = typeof input.bytes === "string"
      ? Buffer.from(input.bytes, "utf8")
      : Buffer.from(input.bytes);
    if (typeof input.bytes === "string" && input.encoding !== "utf-8") {
      throw new Error("string blobs must use utf-8 encoding");
    }
    if (bytes.length === 0) throw new Error("blob objects must not be empty");
    const digest = sha256(bytes);
    if (input.expected_digest !== undefined) {
      if (!SHA256.test(input.expected_digest)) throw new Error("invalid expected blob digest");
      if (input.expected_digest !== digest) {
        throw new BlobIntegrityError(input.expected_digest, "claimed digest does not match supplied bytes");
      }
    }
    const pointer = validateBlobPointer({
      algorithm: "sha256",
      digest,
      bytes: bytes.length,
      encoding: input.encoding,
      media_type: input.media_type,
      payload_schema: input.payload_schema,
    }).value;
    const finalPath = this.objectPath(digest);
    const parent = dirname(finalPath);
    const shard = digest.slice(0, 2);
    ensureManagedDirectory(parent);
    if (!this.#syncedShardEntries.has(shard)) {
      this.#syncDirectory(this.#objectsRoot);
      this.#syncedShardEntries.add(shard);
      this.#fault("shard_parent_synced");
    }
    const temporaryPath = join(parent, `.tmp-${randomUUID()}`);
    let temporaryFd: number | undefined;
    try {
      temporaryFd = openSync(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      this.#fault("temporary_opened");
      writeFileSync(temporaryFd, bytes);
      this.#fault("temporary_written");
      fsyncSync(temporaryFd);
      this.#fault("temporary_synced");
      closeSync(temporaryFd);
      temporaryFd = undefined;
      this.#verifyObject(temporaryPath, pointer);
      this.#fault("temporary_verified");
      try {
        linkSync(temporaryPath, finalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        this.#verifyObject(finalPath, pointer);
      }
      this.#fault("published");
      unlinkSync(temporaryPath);
      this.#syncDirectory(parent);
      this.#fault("directory_synced");
      const identity = this.#verifyObject(finalPath, pointer);
      this.#fault("final_verified");
      return new VerifiedBlobToken(TOKEN_SECRET, this.store_id, pointer, identity);
    } finally {
      if (temporaryFd !== undefined) closeSync(temporaryFd);
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  verify(pointerInput: BlobPointer): VerifiedBlobToken {
    const pointer = validateBlobPointer(pointerInput).value;
    const identity = this.#verifyObject(this.objectPath(pointer.digest), pointer);
    return new VerifiedBlobToken(TOKEN_SECRET, this.store_id, pointer, identity);
  }

  assertToken(token: VerifiedBlobToken, expected?: BlobPointer): BlobPointer {
    const identity = token._assertAuthority(TOKEN_SECRET, this.store_id);
    const pointer = validateBlobPointer(token.pointer).value;
    if (expected && canonicalJson(pointer) !== canonicalJson(validateBlobPointer(expected).value)) {
      throw new Error("verified blob token does not match the expected pointer");
    }
    const path = this.objectPath(pointer.digest);
    const current = this.#verifyObject(path, pointer);
    if (current.device !== identity.device || current.inode !== identity.inode) {
      throw new BlobIntegrityError(pointer.digest, "verified object identity changed before pointer commit");
    }
    return pointer;
  }

  read(pointerInput: BlobPointer): Buffer {
    const pointer = this.verify(pointerInput).pointer;
    const path = this.objectPath(pointer.digest);
    const bytes = readFileSync(path);
    if (bytes.length !== pointer.bytes || sha256(bytes) !== pointer.digest) {
      throw new BlobIntegrityError(pointer.digest, "object changed while it was read");
    }
    return bytes;
  }

  #fault(step: BlobWriteStep): void {
    this.#faultInjector?.(step);
  }

  #verifyObject(path: string, pointer: BlobPointer): ObjectIdentity {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new BlobIntegrityError(pointer.digest, "object is missing");
      if (code === "ELOOP" || code === "ENOTDIR") {
        throw new BlobIntegrityError(pointer.digest, `object path is unsafe (${code})`);
      }
      throw new BlobAvailabilityError(pointer.digest, code ?? "unknown error");
    }
    try {
      const stats = fstatSync(fd, { bigint: true });
      if (!stats.isFile()) throw new BlobIntegrityError(pointer.digest, "object is not a regular file");
      if (stats.size !== BigInt(pointer.bytes)) {
        throw new BlobIntegrityError(pointer.digest, `size ${stats.size} does not match ${pointer.bytes}`);
      }
      const bytes = readFileSync(fd);
      if (sha256(bytes) !== pointer.digest) {
        throw new BlobIntegrityError(pointer.digest, "sha256 digest mismatch");
      }
      return { device: stats.dev, inode: stats.ino };
    } finally {
      closeSync(fd);
    }
  }
}
