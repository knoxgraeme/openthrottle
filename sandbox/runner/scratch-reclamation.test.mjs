import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { reclaimSettledAttemptScratch } from "./scratch-reclamation.mjs";

const SCRATCH_ROOT_NAMES = ["actions", "action-input", "action-results", "action-fences"];

function write(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function attemptPaths(root, attemptId) {
  return {
    actionRoot: join(root, "actions"),
    actionDirectory: join(root, "actions", attemptId),
    requestPath: join(root, "action-input", attemptId, "work-lease", "request.json"),
    resultPath: join(root, "action-results", attemptId, "work-lease", "result.json"),
    sessionPath: join(root, "action-results", attemptId, "work-lease", "session.json"),
    fencePath: join(root, "action-fences", attemptId, "lease-generation.json"),
  };
}

function reclaim(paths, attemptId, log = null) {
  return reclaimSettledAttemptScratch({
    attemptId,
    sourceRepoDir: join(dirname(paths.actionRoot), "repository-source", "repo"),
    actionRoot: paths.actionRoot,
    actionDirectory: paths.actionDirectory,
    requestPath: paths.requestPath,
    resultPath: paths.resultPath,
    leaseGenerationFencePath: paths.fencePath,
    log,
  });
}

function allocatedBytes(path) {
  let total = 0n;
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.pop();
    const metadata = lstatSync(current, { bigint: true });
    total += metadata.blocks * 512n;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
    for (const entry of readdirSync(current)) pending.push(resolve(current, entry));
  }
  return total;
}

describe("settled attempt scratch reclamation", () => {
  it("removes prior attempt scratch while preserving the live wire contract and sealed source", () => {
    const root = mkdtempSync(join(tmpdir(), "ot-scratch-reclamation-"));
    const previous = attemptPaths(root, "attempt-previous");
    const current = attemptPaths(root, "attempt-current");
    const source = join(root, "repository-source", "repo", "source.txt");

    for (const path of [
      join(previous.actionDirectory, "home", ".npm", "cache.bin"),
      previous.requestPath,
      previous.resultPath,
      previous.sessionPath,
      previous.fencePath,
    ]) write(path, Buffer.alloc(16 * 1024, 7));
    for (const [path, content] of [
      [join(current.actionDirectory, "home", "session-state.json"), "live home"],
      [current.requestPath, "live request"],
      [current.resultPath, "live result"],
      [current.sessionPath, "live session"],
      [current.fencePath, "live fence"],
      [source, "sealed source"],
    ]) write(path, content);

    const unexpected = join(root, "actions", "manual-note");
    writeFileSync(unexpected, "leave for inspection");
    const linked = join(root, "actions", "attempt-linked");
    symlinkSync(join(root, "repository-source"), linked);
    const log = [];
    const result = reclaim(current, "attempt-current", (line) => log.push(line));

    expect(existsSync(previous.actionDirectory)).toBe(false);
    expect(existsSync(join(root, "action-input", "attempt-previous"))).toBe(false);
    expect(existsSync(join(root, "action-results", "attempt-previous"))).toBe(false);
    expect(existsSync(join(root, "action-fences", "attempt-previous"))).toBe(false);
    for (const [path, content] of [
      [join(current.actionDirectory, "home", "session-state.json"), "live home"],
      [current.requestPath, "live request"],
      [current.resultPath, "live result"],
      [current.sessionPath, "live session"],
      [current.fencePath, "live fence"],
      [source, "sealed source"],
      [unexpected, "leave for inspection"],
    ]) expect(readFileSync(path, "utf8")).toBe(content);
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(result.reclaimed_directories).toBe(4);
    expect(result.reclaimed_bytes).toBeGreaterThan(0n);
    expect(log).toEqual([result.summary]);
    expect(log[0]).toMatch(/^sandbox scratch: reclaimed [1-9][0-9]* bytes from 4 settled-attempt directories$/);
  });

  it("keeps a sequence of simulated actions bounded to one attempt per scratch root", () => {
    const root = mkdtempSync(join(tmpdir(), "ot-scratch-bounded-"));
    const observedDirectoryCounts = [];
    const observedAllocatedBytes = [];

    for (let index = 0; index < 12; index += 1) {
      const attemptId = `attempt-${String(index).padStart(2, "0")}`;
      const paths = attemptPaths(root, attemptId);
      write(paths.requestPath, `request ${index}`);
      write(paths.fencePath, `fence ${index}`);
      reclaim(paths, attemptId);
      write(join(paths.actionDirectory, "home", ".npm", "cache.bin"), Buffer.alloc(32 * 1024, index));
      write(paths.resultPath, Buffer.alloc(8 * 1024, index));
      write(paths.sessionPath, `session ${index}`);

      const counts = SCRATCH_ROOT_NAMES
        .map((name) => readdirSync(join(root, name)).filter((entry) => entry.startsWith("attempt-")).length);
      observedDirectoryCounts.push(counts);
      observedAllocatedBytes.push(SCRATCH_ROOT_NAMES
        .reduce((total, name) => total + allocatedBytes(join(root, name)), 0n));
    }

    expect(observedDirectoryCounts).toEqual(Array.from({ length: 12 }, () => [1, 1, 1, 1]));
    for (const name of SCRATCH_ROOT_NAMES) {
      expect(readdirSync(join(root, name)).filter((entry) => entry.startsWith("attempt-")))
        .toEqual(["attempt-11"]);
    }
    const minimumBytes = observedAllocatedBytes.reduce((minimum, value) => value < minimum ? value : minimum);
    const maximumBytes = observedAllocatedBytes.reduce((maximum, value) => value > maximum ? value : maximum);
    expect(minimumBytes).toBeGreaterThan(0n);
    expect(maximumBytes - minimumBytes).toBeLessThanOrEqual(64n * 1024n);
  });

  it("rejects path-shaped cleanup roots outside the executor scratch allowlist", () => {
    const root = mkdtempSync(join(tmpdir(), "ot-scratch-source-fence-"));
    const current = attemptPaths(root, "attempt-current");
    const sourceRepoDir = join(root, "repository-source", "repo");
    const sealedSource = join(sourceRepoDir, "sealed.txt");
    write(sealedSource, "sealed source");

    reclaimSettledAttemptScratch({
      attemptId: "attempt-current",
      sourceRepoDir,
      actionRoot: current.actionRoot,
      actionDirectory: current.actionDirectory,
      requestPath: current.requestPath,
      resultPath: join(root, "repository-source", "attempt-current", "work-lease", "result.json"),
      leaseGenerationFencePath: current.fencePath,
    });

    expect(readFileSync(sealedSource, "utf8")).toBe("sealed source");
  });

  it.skipIf(process.platform === "darwin")(
    "reclaims stale scratch containing non-UTF-8 filenames",
    () => {
      const root = mkdtempSync(join(tmpdir(), "ot-scratch-byte-names-"));
      const current = attemptPaths(root, "attempt-current");
      const previous = join(root, "actions", "attempt-previous");
      mkdirSync(previous, { recursive: true });
      writeFileSync(Buffer.concat([Buffer.from(`${previous}/`), Buffer.from([0xff])]), "stale");

      const result = reclaim(current, "attempt-current");

      expect(existsSync(previous)).toBe(false);
      expect(result.reclaimed_directories).toBe(1);
      expect(result.reclaimed_bytes).toBeGreaterThan(0n);
    },
  );
});
