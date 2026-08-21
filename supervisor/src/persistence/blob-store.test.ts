import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BlobIntegrityError,
  VolumeBlobStore,
  type BlobWriteStep,
  type VerifiedBlobToken,
} from "./blob-store.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "openthrottle-blob-store-"));
  temporaryDirectories.push(path);
  return path;
}

function input(bytes = "durable evidence") {
  return {
    bytes,
    encoding: "utf-8" as const,
    media_type: "application/json",
    payload_schema: "test.evidence/v1",
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("VolumeBlobStore", () => {
  it("initializes one marked root and refuses unknown, duplicate, or symlink roots", () => {
    const parent = temporaryDirectory();
    const root = join(parent, "objects");
    const store = VolumeBlobStore.initialize(root, "store-a");

    expect(store.store_id).toBe("store-a");
    expect(VolumeBlobStore.open(root, "store-a").marker_checksum).toBe(store.marker_checksum);
    expect(() => VolumeBlobStore.open(root, "store-b")).toThrow(/identity mismatch/);
    expect(() => VolumeBlobStore.initialize(root, "store-a")).toThrow(/already exists/);

    const unknown = join(parent, "unknown");
    VolumeBlobStore.initialize(unknown, "store-c");
    writeFileSync(join(unknown, ".openthrottle-blob-store.json"), "{}", "utf8");
    expect(() => VolumeBlobStore.open(unknown)).toThrow(/marker/);

    const alias = join(parent, "alias");
    symlinkSync(root, alias, "dir");
    expect(() => VolumeBlobStore.open(alias)).toThrow(/real directory/);
  });

  it("publishes, verifies, reads, and deduplicates immutable objects", () => {
    const root = join(temporaryDirectory(), "objects");
    const store = VolumeBlobStore.initialize(root, "store-a");
    expect(() => store.assertEmpty()).not.toThrow();
    const first = store.put(input());
    const second = store.put(input());

    expect(second.pointer).toEqual(first.pointer);
    expect(() => store.assertEmpty()).toThrow(/not empty/);
    expect(store.read(first.pointer).toString("utf8")).toBe("durable evidence");
    expect(lstatSync(store.objectPath(first.pointer.digest)).isFile()).toBe(true);
    expect(readdirSync(dirname(store.objectPath(first.pointer.digest))).filter((name) => !name.startsWith(".tmp-")))
      .toHaveLength(1);
    expect(store.assertToken(first)).toEqual(first.pointer);
    expect(() => store.assertToken({} as VerifiedBlobToken)).toThrow();
  });

  it("rejects a different payload claiming an existing digest without changing the object", () => {
    const root = join(temporaryDirectory(), "objects");
    const store = VolumeBlobStore.initialize(root, "store-a");
    const first = store.put(input("first"));
    const before = readFileSync(store.objectPath(first.pointer.digest));

    expect(() => store.put({ ...input("second"), expected_digest: first.pointer.digest }))
      .toThrow(BlobIntegrityError);
    expect(readFileSync(store.objectPath(first.pointer.digest))).toEqual(before);
  });

  it.each<BlobWriteStep>([
    "temporary_opened",
    "temporary_written",
    "temporary_synced",
    "temporary_verified",
    "published",
    "directory_synced",
    "final_verified",
  ])("leaves either no object or a reusable verified orphan when %s faults", (faultStep) => {
    const root = join(temporaryDirectory(), "objects");
    VolumeBlobStore.initialize(root, "store-a");
    const faulting = VolumeBlobStore.open(root, "store-a", {
      fault_injector(step) {
        if (step === faultStep) throw new Error(`fault:${step}`);
      },
    });

    expect(() => faulting.put(input())).toThrow(`fault:${faultStep}`);
    const healthy = VolumeBlobStore.open(root, "store-a");
    const recovered = healthy.put(input());
    expect(healthy.read(recovered.pointer).toString("utf8")).toBe("durable evidence");
    expect(readdirSync(dirname(healthy.objectPath(recovered.pointer.digest))).some((name) => name.startsWith(".tmp-")))
      .toBe(false);
  });

  it("detects missing, corrupted, and replaced objects without repairing them", () => {
    const root = join(temporaryDirectory(), "objects");
    const store = VolumeBlobStore.initialize(root, "store-a");
    const token = store.put(input());
    const path = store.objectPath(token.pointer.digest);

    writeFileSync(path, "corrupt", "utf8");
    expect(() => store.verify(token.pointer)).toThrow(BlobIntegrityError);
    expect(() => store.assertToken(token)).toThrow(BlobIntegrityError);
    expect(readFileSync(path, "utf8")).toBe("corrupt");

    unlinkSync(path);
    expect(() => store.verify(token.pointer)).toThrow(/missing/);
  });

  it("binds the database path to the same volume and outside the object root", () => {
    const parent = temporaryDirectory();
    const root = join(parent, "objects");
    const store = VolumeBlobStore.initialize(root, "store-a");
    expect(() => store.assertSameVolume(join(parent, "epoch.sqlite"))).not.toThrow();
    expect(() => store.assertSameVolume(join(root, "epoch.sqlite"))).toThrow(/outside/);
  });

  it("uses the caller's exact SHA-256 claim", () => {
    const root = join(temporaryDirectory(), "objects");
    const store = VolumeBlobStore.initialize(root, "store-a");
    const bytes = "canonical";
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(store.put({ ...input(bytes), expected_digest: expected }).pointer.digest).toBe(expected);
  });
});
