import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const runtimeSh = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../lib/runtime.sh",
);

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

// The gate is the single fail-closed authority the entrypoint consults before
// deciding whether the bake-once bootstrap (post_bootstrap + engine probes)
// runs, is skipped, or aborts the stage. Exercise the bash function directly
// so the decision table and the exact fail-closed diagnostics are pinned.
function evaluateMarker({ marker, sentinel, digest, freshClone }) {
  const result = spawnSync(
    "bash",
    [
      "-c",
      `source "$0" && evaluate_bootstrap_marker "$1" "$2" "$3" "$4"`,
      runtimeSh,
      marker,
      sentinel,
      digest,
      freshClone,
    ],
    { encoding: "utf8" },
  );
  return { status: result.status, output: result.stdout.trimEnd() };
}

function completedMarker(digest, codexHookTrust) {
  return `${JSON.stringify({
    schema: "openthrottle.sandbox-bootstrap/v1",
    repositoryConfigDigest: digest,
    codexHookTrust,
    completedAt: "2026-07-26T00:00:00Z",
  })}\n`;
}

describe("bake-once bootstrap marker gate", () => {
  let stateDir;
  let marker;
  let sentinel;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ot-bootstrap-marker-"));
    marker = join(stateDir, "bootstrap.json");
    sentinel = join(stateDir, "bootstrap.started");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("runs the bootstrap on a fresh sandbox", () => {
    expect(
      evaluateMarker({ marker, sentinel, digest: DIGEST_A, freshClone: "1" }),
    ).toEqual({ status: 0, output: "run" });
    // A checkout left by a stage that died before phase 5 wrote the sentinel
    // is still a fresh sandbox: the bootstrap never started.
    expect(
      evaluateMarker({ marker, sentinel, digest: DIGEST_A, freshClone: "0" }),
    ).toEqual({ status: 0, output: "run" });
  });

  it("skips the bootstrap when the marker matches the sealed digest", () => {
    writeFileSync(marker, completedMarker(DIGEST_A, true));
    expect(
      evaluateMarker({ marker, sentinel, digest: DIGEST_A, freshClone: "0" }),
    ).toEqual({ status: 0, output: "skip 1" });

    writeFileSync(marker, completedMarker(DIGEST_A, false));
    expect(
      evaluateMarker({ marker, sentinel, digest: DIGEST_A, freshClone: "0" }),
    ).toEqual({ status: 0, output: "skip 0" });
  });

  it("fails closed with the exact error on a digest mismatch", () => {
    writeFileSync(marker, completedMarker(DIGEST_A, true));
    expect(
      evaluateMarker({ marker, sentinel, digest: DIGEST_B, freshClone: "0" }),
    ).toEqual({
      status: 1,
      output:
        `FATAL: sandbox bootstrap marker records repository config digest ${DIGEST_A} ` +
        `but the sealed stage request requires ${DIGEST_B}; the sandbox is stale — ` +
        "the supervisor must reprovision it",
    });
  });

  it("fails closed when a previous bootstrap started but never completed", () => {
    writeFileSync(sentinel, `${DIGEST_A}\n`);
    expect(
      evaluateMarker({ marker, sentinel, digest: DIGEST_A, freshClone: "0" }),
    ).toEqual({
      status: 1,
      output:
        "FATAL: sandbox bootstrap started but never completed; the sandbox is " +
        "stale — the supervisor must reprovision it",
    });
  });

  it("fails closed when the marker exists but the checkout was recreated", () => {
    writeFileSync(marker, completedMarker(DIGEST_A, true));
    expect(
      evaluateMarker({ marker, sentinel, digest: DIGEST_A, freshClone: "1" }),
    ).toEqual({
      status: 1,
      output:
        "FATAL: sandbox bootstrap marker is present but the repository checkout " +
        "was recreated; the sandbox is stale — the supervisor must reprovision it",
    });
  });

  it("never trusts a corrupt marker", () => {
    writeFileSync(marker, "not json\n");
    expect(
      evaluateMarker({ marker, sentinel, digest: DIGEST_A, freshClone: "0" }),
    ).toEqual({
      status: 1,
      output:
        "FATAL: sandbox bootstrap marker is unreadable; the sandbox is stale — " +
        "the supervisor must reprovision it",
    });
  });
});
