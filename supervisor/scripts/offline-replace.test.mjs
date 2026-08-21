import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFreshEpochBootstrap } from "../src/persistence/epoch-database.js";

const supervisorRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(supervisorRoot, "scripts/offline-replace.mjs");
const builtReplacementPath = join(supervisorRoot, "dist/persistence/offline-replacement.js");
const directories = [];
const OLD_RUNTIME_CAPABILITY = "a".repeat(64);
const FRESH_RUNTIME_CAPABILITY = "b".repeat(64);

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(mode) {
  const requestedRoot = mkdtempSync(join(tmpdir(), "openthrottle-offline-cli-"));
  directories.push(requestedRoot);
  const root = realpathSync(requestedRoot);
  const oldDatabase = join(root, "old.sqlite");
  const db = new Database(oldDatabase);
  db.exec("CREATE TABLE historical_runs (id TEXT PRIMARY KEY) STRICT");
  db.prepare("INSERT INTO historical_runs (id) VALUES (?)").run("old-run");
  db.close();
  const oldBlobs = join(root, "old-blobs");
  mkdirSync(oldBlobs);
  writeFileSync(join(oldBlobs, "evidence.bin"), "old evidence", { mode: 0o600 });

  const hookLog = join(root, "hook.log");
  const hookPath = join(root, "hook.mjs");
  writeFileSync(hookPath, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [mode, oldReleaseId, oldRuntimeCapabilityDigest, databasePath, blobRoot, archiveRoot, logPath] = process.argv.slice(2);
const operation = process.env.OT_OFFLINE_REPLACEMENT_OPERATION;
appendFileSync(logPath, \`${"${operation}"}\\n\`);

if (mode === "environment-check") {
  if (process.env.OT_TEST_ALLOWED !== "explicitly inherited") {
    process.stderr.write("allowlisted environment value missing\\n");
    process.exit(31);
  }
  if (Object.hasOwn(process.env, "OT_TEST_PARENT_SECRET")) {
    process.stderr.write("unlisted parent secret leaked\\n");
    process.exit(32);
  }
}
if (mode === "mutate-after-preflight" && operation === "verify_preconditions") {
  appendFileSync(process.argv[1], "\\n// modified by precondition hook\\n");
}

if (mode === "fail-start" && operation === "start_candidate") {
  process.stderr.write("candidate refused to start\\n");
  process.exit(23);
}
if (mode === "malformed-precondition" && operation === "verify_preconditions") {
  process.stdout.write('{"evidence":"missing observed state"}\\n');
} else if (operation === "verify_preconditions") {
  process.stdout.write(JSON.stringify({
    old_release_id: oldReleaseId,
    old_runtime_capability_digest: oldRuntimeCapabilityDigest,
    database_path: databasePath,
    blob_root: blobRoot,
    ingress_closed: true,
    active_work_clear: true,
    supervisors_stopped: true,
    workers_stopped: true,
    evidence: "maintenance and active-work state observed",
  }) + "\\n");
} else if (operation === "restore_old") {
  const archive = JSON.parse(readFileSync(join(archiveRoot, "archive-manifest.json"), "utf8"));
  process.stdout.write(JSON.stringify({
    old_release_id: oldReleaseId,
    old_runtime_capability_digest: oldRuntimeCapabilityDigest,
    database_path: databasePath,
    blob_root: blobRoot,
    archive_manifest_digest: mode === "mismatched-restore" ? "f".repeat(64) : archive.manifest_digest,
    evidence: "old release/storage tuple restored and observed",
  }) + "\\n");
} else if (operation === "smoke_ordinary" || operation === "smoke_structured") {
  const kind = operation.slice("smoke_".length);
  process.stdout.write(JSON.stringify({
    id: \`${"${kind}"}-process-smoke\`,
    status: "passed",
    evidence: \`${"${kind}"} process smoke passed\`,
  }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ evidence: \`${"${operation}"} complete\` }) + "\\n");
}
`, { mode: 0o700 });

  const bootstrap = createFreshEpochBootstrap({
    schema: "openthrottle.fresh-epoch-bootstrap/v1",
    settings: [],
    repository_registrations: [],
  });
  const replacement = {
    schema: "openthrottle.offline-replacement/v1",
    maintenance: {
      ingress_closed: true,
      supervisors_stopped: true,
      workers_stopped: true,
      storage_lock_absent: true,
      evidence: ["maintenance fence observed", "Fly writers stopped"],
    },
    active_work: [],
    old: {
      release_id: "old-release",
      runtime_capability_digest: OLD_RUNTIME_CAPABILITY,
      database_path: oldDatabase,
      blob_root: oldBlobs,
      archive_root: join(root, "old-archive"),
    },
    fresh: {
      release_id: "fresh-release",
      runtime_capability_digest: FRESH_RUNTIME_CAPABILITY,
      database_path: join(root, "fresh.sqlite"),
      blob_root: join(root, "fresh-blobs"),
      blob_store_id: "fresh-store",
      bootstrap,
    },
    report_path: join(root, "replacement-report.json"),
  };
  const hookArgs = [
    mode,
    replacement.old.release_id,
    replacement.old.runtime_capability_digest,
    replacement.old.database_path,
    replacement.old.blob_root,
    replacement.old.archive_root,
    hookLog,
  ];
  const hookDigest = createHash("sha256").update(readFileSync(hookPath)).digest("hex");
  const manifest = {
    replacement,
    commands: Object.fromEntries([
      "verify_preconditions",
      "start_candidate",
      "smoke_ordinary",
      "smoke_structured",
      "reopen_ingress",
      "stop_candidate",
      "restore_old",
    ].map((name) => [name, {
      executable: realpathSync(hookPath),
      sha256: hookDigest,
      args: [...hookArgs],
      inherit_env: [],
    }])),
  };
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return { hookLog, hookPath: realpathSync(hookPath), manifest, manifestPath, replacement, root };
}

function runCli(manifestPath, environment = {}) {
  if (!existsSync(builtReplacementPath)) {
    throw new Error("offline replacement process test requires `npm run build --prefix supervisor`");
  }
  return spawnSync(process.execPath, [cliPath, manifestPath], {
    cwd: supervisorRoot,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    timeout: 20_000,
  });
}

function writeManifest(manifestPath, manifest) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
}

describe("offline-replace process boundary", () => {
  it("prints bounded help without loading a built supervisor module", () => {
    const requestedRoot = mkdtempSync(join(tmpdir(), "openthrottle-offline-help-"));
    directories.push(requestedRoot);
    const root = realpathSync(requestedRoot);
    const isolatedScripts = join(root, "scripts");
    mkdirSync(isolatedScripts);
    const isolatedCli = join(isolatedScripts, "offline-replace.mjs");
    copyFileSync(cliPath, isolatedCli);

    expect(existsSync(join(root, "dist", "persistence", "offline-replacement.js"))).toBe(false);
    const result = spawnSync(process.execPath, [isolatedCli, "--help"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: offline-replace.mjs");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(1_024);
  });

  it("runs the exact hook sequence and returns a completed report receipt", () => {
    const { hookLog, manifestPath, replacement } = fixture("success");
    const result = runCli(manifestPath);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "completed",
      report_path: replacement.report_path,
      report_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(readFileSync(hookLog, "utf8").trim().split("\n")).toEqual([
      "verify_preconditions",
      "start_candidate",
      "smoke_ordinary",
      "smoke_structured",
      "reopen_ingress",
    ]);
    expect(JSON.parse(readFileSync(replacement.report_path, "utf8"))).toMatchObject({
      status: "completed",
      ready_report_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("rejects malformed observed-precondition output before destructive work", () => {
    const { hookLog, manifestPath, replacement } = fixture("malformed-precondition");
    const result = runCli(manifestPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("verify_preconditions output must bind the exact old tuple");
    expect(readFileSync(hookLog, "utf8").trim()).toBe("verify_preconditions");
    expect(existsSync(replacement.old.archive_root)).toBe(false);
    expect(existsSync(replacement.fresh.database_path)).toBe(false);
    expect(existsSync(replacement.report_path)).toBe(false);
  });

  it("rolls back through stop-before-restore when a process hook fails", () => {
    const { hookLog, manifestPath, replacement } = fixture("fail-start");
    const result = runCli(manifestPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("start_candidate failed (23): candidate refused to start");
    expect(readFileSync(hookLog, "utf8").trim().split("\n")).toEqual([
      "verify_preconditions",
      "start_candidate",
      "stop_candidate",
      "restore_old",
    ]);
    expect(JSON.parse(readFileSync(replacement.report_path, "utf8"))).toMatchObject({
      status: "rolled_back",
      rollback_evidence: [
        { kind: "candidate_stopped", evidence: "stop_candidate complete" },
        {
          kind: "old_tuple_restored",
          restore: {
            old_release_id: "old-release",
            old_runtime_capability_digest: OLD_RUNTIME_CAPABILITY,
            database_path: replacement.old.database_path,
            blob_root: replacement.old.blob_root,
            archive_manifest_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            evidence: "old release/storage tuple restored and observed",
          },
        },
      ],
    });
  });

  it("rejects manifests that omit either runtime capability digest before invoking hooks", () => {
    for (const field of ["old", "fresh"]) {
      const { hookLog, manifestPath, replacement } = fixture("success");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      delete manifest.replacement[field].runtime_capability_digest;
      writeManifest(manifestPath, manifest);

      const result = runCli(manifestPath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `${field}.runtime_capability_digest must be a lowercase SHA-256 digest`,
      );
      expect(existsSync(hookLog)).toBe(false);
      expect(existsSync(replacement.old.archive_root)).toBe(false);
      expect(existsSync(replacement.fresh.database_path)).toBe(false);
    }
  });

  it("reports rollback_failed when a restore hook does not bind the sealed archive", () => {
    const { hookLog, manifestPath, replacement } = fixture("mismatched-restore");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.commands.start_candidate.args[0] = "fail-start";
    writeManifest(manifestPath, manifest);

    const result = runCli(manifestPath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("rollback failed");
    expect(readFileSync(hookLog, "utf8").trim().split("\n")).toEqual([
      "verify_preconditions",
      "start_candidate",
      "stop_candidate",
      "restore_old",
    ]);
    expect(JSON.parse(readFileSync(replacement.report_path, "utf8"))).toMatchObject({
      status: "rollback_failed",
      rollback_evidence: [
        { kind: "candidate_stopped", evidence: "stop_candidate complete" },
        {
          kind: "old_tuple_restore_failed",
          error: "old tuple restore evidence does not match the exact archived tuple",
        },
      ],
    });
  });

  it("rejects unknown and missing command-object fields before invoking a hook", () => {
    for (const mutation of ["unknown", "missing"]) {
      const { hookLog, manifest, manifestPath, replacement } = fixture("success");
      if (mutation === "unknown") manifest.commands.restore_old.untrusted = true;
      else delete manifest.commands.restore_old.sha256;
      writeManifest(manifestPath, manifest);

      const result = runCli(manifestPath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("commands.restore_old has unknown or missing fields");
      expect(existsSync(hookLog)).toBe(false);
      expect(existsSync(replacement.old.archive_root)).toBe(false);
      expect(existsSync(replacement.fresh.database_path)).toBe(false);
    }
  });

  it("preflights all seven command executables before invoking any hook", () => {
    const cases = [
      {
        label: "missing",
        mutate: ({ manifest, root }) => {
          manifest.commands.restore_old.executable = join(root, "missing-hook.mjs");
        },
        error: "commands.restore_old.executable is unavailable",
      },
      {
        label: "relative",
        mutate: ({ manifest }) => {
          manifest.commands.restore_old.executable = "./hook.mjs";
        },
        error: "commands.restore_old.executable must be an absolute normalized non-root path",
      },
      {
        label: "symlink",
        mutate: ({ hookPath, manifest, root }) => {
          const linked = join(root, "linked-hook.mjs");
          symlinkSync(hookPath, linked);
          manifest.commands.restore_old.executable = linked;
        },
        error: "commands.restore_old.executable must be a regular non-symlink file",
      },
      {
        label: "non-executable",
        mutate: ({ hookPath }) => chmodSync(hookPath, 0o600),
        error: "commands.verify_preconditions.executable is not executable",
      },
    ];

    for (const testCase of cases) {
      const value = fixture("success");
      testCase.mutate(value);
      writeManifest(value.manifestPath, value.manifest);
      const result = runCli(value.manifestPath);
      expect(result.status, `${testCase.label}: ${result.stderr}`).not.toBe(0);
      expect(result.stderr).toContain(testCase.error);
      expect(existsSync(value.hookLog)).toBe(false);
      expect(existsSync(value.replacement.old.archive_root)).toBe(false);
      expect(existsSync(value.replacement.fresh.database_path)).toBe(false);
    }
  });

  it("rejects a manifest digest mismatch and an executable modified after authoring", () => {
    const wrongDigest = fixture("success");
    wrongDigest.manifest.commands.verify_preconditions.sha256 = "0".repeat(64);
    writeManifest(wrongDigest.manifestPath, wrongDigest.manifest);
    const digestResult = runCli(wrongDigest.manifestPath);
    expect(digestResult.status).not.toBe(0);
    expect(digestResult.stderr).toContain(
      "commands.verify_preconditions.sha256 does not match its executable",
    );
    expect(existsSync(wrongDigest.hookLog)).toBe(false);

    const modified = fixture("success");
    appendFileSync(modified.hookPath, "\n// modified after manifest authoring\n");
    const modifiedResult = runCli(modified.manifestPath);
    expect(modifiedResult.status).not.toBe(0);
    expect(modifiedResult.stderr).toContain(
      "commands.verify_preconditions.sha256 does not match its executable",
    );
    expect(existsSync(modified.hookLog)).toBe(false);
  });

  it("detects executable mutation after preflight before a later hook or destructive action", () => {
    const { hookLog, manifestPath, replacement } = fixture("mutate-after-preflight");
    const result = runCli(manifestPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("executable changed after preflight");
    expect(readFileSync(hookLog, "utf8").trim()).toBe("verify_preconditions");
    expect(existsSync(replacement.old.archive_root)).toBe(false);
    expect(existsSync(replacement.fresh.database_path)).toBe(false);
    expect(existsSync(replacement.report_path)).toBe(false);
  });

  it("inherits only explicitly allowlisted environment names and never leaks parent secrets", () => {
    const { manifest, manifestPath, replacement } = fixture("environment-check");
    for (const command of Object.values(manifest.commands)) {
      command.inherit_env = ["OT_TEST_ALLOWED"];
    }
    writeManifest(manifestPath, manifest);

    const result = runCli(manifestPath, {
      OT_TEST_ALLOWED: "explicitly inherited",
      OT_TEST_PARENT_SECRET: "must-not-reach-hooks",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "completed",
      report_path: replacement.report_path,
    });
  });

  it("rejects invalid, duplicate, and executor-owned environment allowlist names", () => {
    const cases = [
      { names: ["BAD-NAME"], error: "is not a valid environment name" },
      { names: ["PATH", "PATH"], error: "contains duplicate PATH" },
      {
        names: ["OT_OFFLINE_REPLACEMENT_OPERATION"],
        error: "may not claim executor-owned OT_OFFLINE_REPLACEMENT_OPERATION",
      },
      {
        names: ["OT_OFFLINE_REPLACEMENT_REASON"],
        error: "may not claim executor-owned OT_OFFLINE_REPLACEMENT_REASON",
      },
    ];
    for (const testCase of cases) {
      const { hookLog, manifest, manifestPath } = fixture("success");
      manifest.commands.verify_preconditions.inherit_env = testCase.names;
      writeManifest(manifestPath, manifest);
      const result = runCli(manifestPath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(testCase.error);
      expect(existsSync(hookLog)).toBe(false);
    }
  });
});
