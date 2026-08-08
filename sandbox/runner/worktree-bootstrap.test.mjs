import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureWorktreeBootstrap,
  removeWorktreeBootstrapMarker,
  worktreeBootstrapMarkerPath,
} from "./worktree-bootstrap.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function markerRoot() {
  const directory = mkdtempSync(join(tmpdir(), "ot-worktree-bootstrap-"));
  directories.push(directory);
  return directory;
}

function passingCommand() {
  return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
}

describe("worktree bootstrap", () => {
  it("rejects traversal handles before touching the filesystem", () => {
    expect(() => worktreeBootstrapMarkerPath({ markerRootDir: markerRoot(), handle: "../escape" }))
      .toThrow(/handle is invalid/);
  });

  it("runs every sealed post_bootstrap command in the worktree once and seals a marker", () => {
    const markerRootDir = markerRoot();
    const calls = [];
    const options = {
      worktreeDir: "/work/worktree-1",
      handle: "worktree-1",
      config: { post_bootstrap: ["npm ci --prefix contracts", "npm ci --prefix supervisor"] },
      configDigest: "a".repeat(64),
      markerRootDir,
      executeCommand: (input) => {
        calls.push(input);
        return passingCommand();
      },
    };

    const first = ensureWorktreeBootstrap(options);
    expect(first).toEqual({ bootstrapped: true, commands: 2 });
    expect(calls.map((call) => call.command)).toEqual(["npm ci --prefix contracts", "npm ci --prefix supervisor"]);
    expect(calls.every((call) => call.repoDir === "/work/worktree-1")).toBe(true);
    expect(calls.every((call) => call.timeoutMs === 7_200_000)).toBe(true);
    const marker = JSON.parse(readFileSync(worktreeBootstrapMarkerPath({ markerRootDir, handle: "worktree-1" }), "utf8"));
    expect(marker).toMatchObject({
      schema: "openthrottle.worktree-bootstrap/v1",
      state: "completed",
      worktree: "worktree-1",
      repositoryConfigDigest: "a".repeat(64),
    });

    const second = ensureWorktreeBootstrap(options);
    expect(second).toEqual({ bootstrapped: false, commands: 2 });
    expect(calls).toHaveLength(2);
  });

  it("is a no-op without writing a marker when no post_bootstrap is declared", () => {
    const markerRootDir = markerRoot();
    const result = ensureWorktreeBootstrap({
      worktreeDir: "/work/worktree-1",
      handle: "worktree-1",
      config: {},
      configDigest: "a".repeat(64),
      markerRootDir,
      executeCommand: () => {
        throw new Error("must not execute");
      },
    });
    expect(result).toEqual({ bootstrapped: false, commands: 0 });
    expect(existsSync(worktreeBootstrapMarkerPath({ markerRootDir, handle: "worktree-1" }))).toBe(false);
  });

  it("leaves a started marker after a partial failure and refuses to repeat side effects in-place", () => {
    const markerRootDir = markerRoot();
    let attempts = 0;
    const options = {
      worktreeDir: "/work/worktree-1",
      handle: "worktree-1",
      config: { post_bootstrap: ["npm ci"] },
      configDigest: "a".repeat(64),
      markerRootDir,
      executeCommand: () => {
        attempts += 1;
        return { exitCode: 127, signal: null, timedOut: false, stdout: "", stderr: "sh: 1: tsc: not found\n" };
      },
    };

    expect(() => ensureWorktreeBootstrap(options)).toThrow(/bootstrap command exited with 127.*tsc: not found/s);
    const markerPath = worktreeBootstrapMarkerPath({ markerRootDir, handle: "worktree-1" });
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      schema: "openthrottle.worktree-bootstrap/v1",
      state: "started",
      worktree: "worktree-1",
      repositoryConfigDigest: "a".repeat(64),
    });

    expect(() => ensureWorktreeBootstrap(options)).toThrow(/started but never completed.*recreated/);
    expect(attempts).toBe(1);

    removeWorktreeBootstrapMarker({ markerRootDir, handle: "worktree-1" });
    expect(() => ensureWorktreeBootstrap(options)).toThrow(/bootstrap command exited with 127/);
    expect(attempts).toBe(2);
  });

  it("fails a timed-out or signaled bootstrap command", () => {
    const base = {
      worktreeDir: "/work/worktree-1",
      handle: "worktree-1",
      config: { post_bootstrap: ["npm ci"] },
      configDigest: "a".repeat(64),
    };
    expect(() => ensureWorktreeBootstrap({
      ...base,
      markerRootDir: markerRoot(),
      executeCommand: () => ({ exitCode: null, signal: null, timedOut: true, stdout: "", stderr: "" }),
    })).toThrow(/timed out/);
    expect(() => ensureWorktreeBootstrap({
      ...base,
      markerRootDir: markerRoot(),
      executeCommand: () => ({ exitCode: null, signal: "SIGKILL", timedOut: false, stdout: "", stderr: "" }),
    })).toThrow(/terminated by signal SIGKILL/);
  });

  it("fails closed on a marker sealed under a different repository config digest", () => {
    const markerRootDir = markerRoot();
    const options = {
      worktreeDir: "/work/worktree-1",
      handle: "worktree-1",
      config: { post_bootstrap: ["npm ci"] },
      configDigest: "a".repeat(64),
      markerRootDir,
      executeCommand: () => passingCommand(),
    };
    ensureWorktreeBootstrap(options);

    expect(() => ensureWorktreeBootstrap({ ...options, configDigest: "b".repeat(64) }))
      .toThrow(/marker does not match the sealed repository config/);
  });

  it("fails closed on an unreadable marker instead of silently re-running", () => {
    const markerRootDir = markerRoot();
    writeFileSync(worktreeBootstrapMarkerPath({ markerRootDir, handle: "worktree-1" }), "not json");
    expect(() => ensureWorktreeBootstrap({
      worktreeDir: "/work/worktree-1",
      handle: "worktree-1",
      config: { post_bootstrap: ["npm ci"] },
      configDigest: "a".repeat(64),
      markerRootDir,
      executeCommand: () => passingCommand(),
    })).toThrow(/marker is unreadable/);
  });

  it("fails closed when a marker body names a different worktree handle", () => {
    const markerRootDir = markerRoot();
    writeFileSync(
      worktreeBootstrapMarkerPath({ markerRootDir, handle: "worktree-1" }),
      JSON.stringify({
        schema: "openthrottle.worktree-bootstrap/v1",
        state: "completed",
        worktree: "worktree-2",
        repositoryConfigDigest: "a".repeat(64),
      })
    );
    expect(() => ensureWorktreeBootstrap({
      worktreeDir: "/work/worktree-1",
      handle: "worktree-1",
      config: { post_bootstrap: ["npm ci"] },
      configDigest: "a".repeat(64),
      markerRootDir,
      executeCommand: () => passingCommand(),
    })).toThrow(/marker does not match the sealed repository config/);
  });

  it("rejects a malformed sealed post_bootstrap list", () => {
    expect(() => ensureWorktreeBootstrap({
      worktreeDir: "/work/worktree-1",
      handle: "worktree-1",
      config: { post_bootstrap: [""] },
      configDigest: "a".repeat(64),
      markerRootDir: markerRoot(),
      executeCommand: () => passingCommand(),
    })).toThrow(/post_bootstrap is invalid/);
  });

  it("removes a sealed marker so a recreated worktree bootstraps again", () => {
    const markerRootDir = markerRoot();
    const options = {
      worktreeDir: "/work/worktree-1",
      handle: "worktree-1",
      config: { post_bootstrap: ["npm ci"] },
      configDigest: "a".repeat(64),
      markerRootDir,
      executeCommand: () => passingCommand(),
    };
    ensureWorktreeBootstrap(options);
    removeWorktreeBootstrapMarker({ markerRootDir, handle: "worktree-1" });
    expect(existsSync(worktreeBootstrapMarkerPath({ markerRootDir, handle: "worktree-1" }))).toBe(false);
    expect(ensureWorktreeBootstrap(options)).toEqual({ bootstrapped: true, commands: 1 });
  });
});
