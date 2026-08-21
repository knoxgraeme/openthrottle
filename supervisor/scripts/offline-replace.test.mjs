import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
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

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(mode) {
  const root = mkdtempSync(join(tmpdir(), "openthrottle-offline-cli-"));
  directories.push(root);
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
  writeFileSync(hookPath, `
import { appendFileSync } from "node:fs";

const [mode, oldReleaseId, databasePath, blobRoot, logPath] = process.argv.slice(2);
const operation = process.env.OT_OFFLINE_REPLACEMENT_OPERATION;
appendFileSync(logPath, \`${"${operation}"}\\n\`);

if (mode === "fail-start" && operation === "start_candidate") {
  process.stderr.write("candidate refused to start\\n");
  process.exit(23);
}
if (mode === "malformed-precondition" && operation === "verify_preconditions") {
  process.stdout.write('{"evidence":"missing observed state"}\\n');
} else if (operation === "verify_preconditions") {
  process.stdout.write(JSON.stringify({
    old_release_id: oldReleaseId,
    database_path: databasePath,
    blob_root: blobRoot,
    ingress_closed: true,
    active_work_clear: true,
    supervisors_stopped: true,
    workers_stopped: true,
    evidence: "maintenance and active-work state observed",
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
      database_path: oldDatabase,
      blob_root: oldBlobs,
      archive_root: join(root, "old-archive"),
    },
    fresh: {
      release_id: "fresh-release",
      database_path: join(root, "fresh.sqlite"),
      blob_root: join(root, "fresh-blobs"),
      blob_store_id: "fresh-store",
      bootstrap,
    },
    report_path: join(root, "replacement-report.json"),
  };
  const hookCommand = [
    process.execPath,
    hookPath,
    mode,
    replacement.old.release_id,
    replacement.old.database_path,
    replacement.old.blob_root,
    hookLog,
  ];
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
    ].map((name) => [name, hookCommand])),
  };
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return { hookLog, manifestPath, replacement };
}

function runCli(manifestPath) {
  if (!existsSync(builtReplacementPath)) {
    throw new Error("offline replacement process test requires `npm run build --prefix supervisor`");
  }
  return spawnSync(process.execPath, [cliPath, manifestPath], {
    cwd: supervisorRoot,
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("offline-replace process boundary", () => {
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
        "candidate_stopped:stop_candidate complete",
        "old_tuple_restored:restore_old complete",
      ],
    });
  });
});
