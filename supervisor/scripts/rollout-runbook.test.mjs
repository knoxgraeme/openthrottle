import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const runbook = readFileSync(
  resolve(repoRoot, "docs/runbooks/execution-kernel-rollout.md"),
  "utf8",
);
const ci = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");

function extractDelimited(source, prefix, suffix) {
  const start = source.indexOf(prefix);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = start + prefix.length;
  const end = source.indexOf(suffix, bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  return source.slice(bodyStart, end);
}

const receiptExtractionProgram = extractDelimited(
  runbook,
  "  jq -s '\n",
  "\n  ' \"$FLY_LOGS\" >\"$RECEIPT_CANDIDATES\"",
);
const receiptValidationProgram = extractDelimited(
  runbook,
  "jq -e '\n  def sha256",
  "\n' \"$RECEIPT_CANDIDATES\" >epoch-initialization-receipt.json",
);

const validReceipt = {
  schema: "openthrottle.fresh-epoch-initialization/v1",
  database_path: "/data/openthrottle-kernel-v1.sqlite",
  blob_store_path: "/data/openthrottle-kernel-v1-blobs",
  blob_store_id: "openthrottle-execution-kernel-v1",
  release_id: "openthrottle-execution-kernel/v1",
  blob_marker_checksum: "a".repeat(64),
  runtime_capability_digest: "b".repeat(64),
  bootstrap_checksum: "c".repeat(64),
  schema_checksum: "d".repeat(64),
  schema_version: 1,
  maintenance_ingress_closed: true,
  integrity: "ok",
};

function receiptLog(receipt, field = "message") {
  return {
    timestamp: "2026-08-21T22:59:00.000Z",
    [field]: JSON.stringify(receipt),
  };
}

function extractReceiptCandidates(logs) {
  return spawnSync("jq", ["-s", receiptExtractionProgram], {
    input: logs,
    encoding: "utf8",
  });
}

function validateReceiptCandidates(candidates) {
  return spawnSync("jq", ["-e", `def sha256${receiptValidationProgram}`], {
    input: candidates,
    encoding: "utf8",
  });
}

describe("fresh-epoch rollout runbook", () => {
  it("keeps maintenance closed until exceptional recovery cleanup is clear", () => {
    const section = runbook.slice(runbook.indexOf("## 7. Reject a proven pre-mutation sandbox failure"));
    const activeWorkIndex = section.indexOf('ACTIVE_WORK="$(');
    const clearGuardIndex = section.indexOf("jq -e '.clear == true'");
    const openIndex = section.indexOf('"https://$FLY_APP.fly.dev/maintenance/open"');

    expect(activeWorkIndex).toBeGreaterThanOrEqual(0);
    expect(clearGuardIndex).toBeGreaterThan(activeWorkIndex);
    expect(openIndex).toBeGreaterThan(clearGuardIndex);
    for (const [clear, expectedStatus] of [[true, 0], [false, 1]]) {
      const guarded = spawnSync("bash", ["-c", `
        ACTIVE_WORK='${JSON.stringify({ clear })}'
        jq -e '.clear == true' <<<"$ACTIVE_WORK" >/dev/null || exit 1
      `]);
      expect(guarded.status).toBe(expectedStatus);
    }
  });

  it("documents the fenced schema-preserving release sequence and fail-closed recovery", () => {
    const section = runbook.slice(
      runbook.indexOf("## 6. Accept a later schema-preserving release"),
      runbook.indexOf("## 7. Reject a proven pre-mutation sandbox failure"),
    );
    for (const required of [
      "--candidate-identity",
      "/maintenance/active-work?limit=2000",
      "clear:true",
      "truncated:false",
      "`openthrottle_data` volume is detached",
      "no-restart accept-release Machine",
      "exactly one bounded receipt",
      "same image digest",
      "already-closed fence stays closed",
      "fresh epoch is required",
    ]) expect(section).toContain(required);
    expect(section.indexOf("closes maintenance")).toBeLessThan(section.indexOf("polls `/maintenance/active-work"));
    expect(section.indexOf("polls `/maintenance/active-work")).toBeLessThan(section.indexOf("stops and destroys the sole writer"));
    expect(section.indexOf("exactly one bounded receipt")).toBeLessThan(section.indexOf("same image digest"));
  });

  it("runs the accepted digest-pinned image without rebuilding a checkout", () => {
    const manifestGuardIndex = runbook.indexOf('if [ ! -f "$RELEASE_MANIFEST" ]');
    const volumeGuardIndex = runbook.indexOf(
      '[[ ! "$VOLUME_ID" =~ ^vol_[a-z0-9]+$ ]]',
    );
    const volumeInventoryIndex = runbook.indexOf(
      'flyctl volumes list --app "$FLY_APP" --json',
    );
    const runIndex = runbook.indexOf('flyctl machine run "$SUPERVISOR_IMAGE"');

    expect(runbook).toContain('.supervisorImage');
    expect(runbook).toContain(
      'test("^[^@\\\\s]+@sha256:[a-f0-9]{64}$")',
    );
    expect(runbook).not.toContain("export RELEASE_MANIFEST=<");
    expect(runbook).not.toContain("export VOLUME_ID=<");
    expect(manifestGuardIndex).toBeGreaterThanOrEqual(0);
    expect(volumeGuardIndex).toBeGreaterThan(manifestGuardIndex);
    expect(volumeInventoryIndex).toBeGreaterThan(volumeGuardIndex);
    expect(runIndex).toBeGreaterThan(volumeInventoryIndex);
    expect(runbook.slice(volumeInventoryIndex, runIndex)).toContain(
      'select(volume_name == "openthrottle_data")',
    );
    expect(runbook.slice(volumeInventoryIndex, runIndex)).toContain(
      '($named | length) == 1',
    );
    expect(runbook.slice(volumeInventoryIndex, runIndex)).toContain(
      "volume_id == $id",
    );
    expect(runbook.slice(volumeInventoryIndex, runIndex)).toContain(
      "volume_region == $region",
    );
    expect(runbook.slice(volumeInventoryIndex, runIndex)).toContain(
      'attached_machine == ""',
    );
    expect(runbook).not.toContain("flyctl machine run .");
    expect(runbook).not.toContain("--dockerfile supervisor/Dockerfile");
  });

  it("keeps the initialization blocks valid shell with guarded sentinels", () => {
    const section = runbook.slice(
      runbook.indexOf("## 3. Initialize from the accepted image"),
      runbook.indexOf("## 4. Deploy one writer"),
    );
    const blocks = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map(
      ([, source]) => source,
    );
    const parsed = spawnSync("bash", ["-n"], {
      input: blocks.join("\n"),
      encoding: "utf8",
    });

    expect(blocks).toHaveLength(3);
    expect(section).toContain(
      "export RELEASE_MANIFEST=/absolute/path/to/accepted-release-manifest.json",
    );
    expect(section).toContain("export VOLUME_ID=vol_REPLACE_ME");
    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it("validates one receipt before destroying the stopped Machine", () => {
    const runIndex = runbook.indexOf('flyctl machine run "$SUPERVISOR_IMAGE"');
    const waitIndex = runbook.indexOf("flyctl machine wait");
    const exactReceiptIndex = runbook.indexOf('error("expected exactly one initializer receipt")');
    const retainedReceiptIndex = runbook.indexOf(">epoch-initialization-receipt.json");
    const destroyIndex = runbook.indexOf("flyctl machine destroy");

    expect(runbook).toContain("--restart no");
    expect(runbook).toContain("--detach");
    expect(runbook).not.toMatch(/flyctl machine run[\s\S]{0,300}\s--rm(?:\s|\\)/);
    expect(runIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeGreaterThan(runIndex);
    expect(exactReceiptIndex).toBeGreaterThan(waitIndex);
    expect(retainedReceiptIndex).toBeGreaterThan(exactReceiptIndex);
    expect(destroyIndex).toBeGreaterThan(retainedReceiptIndex);
  });

  it("extracts one receipt from JSONL and concatenated pretty Fly log objects", () => {
    const logObjects = [
      { timestamp: "2026-08-21T22:58:59.000Z", message: "initializer starting" },
      receiptLog(validReceipt, "Message"),
    ];
    const shapes = [
      logObjects.map((entry) => JSON.stringify(entry)).join("\n"),
      logObjects.map((entry) => JSON.stringify(entry, null, 2)).join("\n"),
    ];

    for (const logs of shapes) {
      const extracted = extractReceiptCandidates(logs);
      expect(extracted.status, extracted.stderr).toBe(0);
      expect(JSON.parse(extracted.stdout)).toEqual([validReceipt]);

      const validated = validateReceiptCandidates(extracted.stdout);
      expect(validated.status, validated.stderr).toBe(0);
      expect(JSON.parse(validated.stdout)).toEqual(validReceipt);
    }
  });

  it("rejects invalid and duplicate initializer receipts after extraction", () => {
    const invalidReceipt = {
      ...validReceipt,
      release_id: "unexpected-release",
    };
    const invalid = extractReceiptCandidates(
      JSON.stringify(receiptLog(invalidReceipt), null, 2),
    );
    expect(invalid.status, invalid.stderr).toBe(0);
    const invalidValidation = validateReceiptCandidates(invalid.stdout);
    expect(invalidValidation.status).not.toBe(0);
    expect(invalidValidation.stderr).toContain(
      "initializer receipt identity is invalid",
    );

    const duplicate = extractReceiptCandidates(
      [receiptLog(validReceipt), receiptLog(validReceipt)]
        .map((entry) => JSON.stringify(entry, null, 2))
        .join("\n"),
    );
    expect(duplicate.status, duplicate.stderr).toBe(0);
    const duplicateValidation = validateReceiptCandidates(duplicate.stdout);
    expect(duplicateValidation.status).not.toBe(0);
    expect(duplicateValidation.stderr).toContain(
      "expected exactly one initializer receipt",
    );
  });
});

describe("packaged initializer CI proof", () => {
  it("runs the final supervisor image against an empty Docker volume", () => {
    const buildIndex = ci.indexOf("docker build -f supervisor/Dockerfile -t openthrottle-supervisor:test .");
    const exerciseIndex = ci.indexOf("Exercise packaged fresh-epoch initializer");
    const runIndex = ci.indexOf("node /app/scripts/initialize-epoch.mjs", exerciseIndex);
    const retryIndex = ci.indexOf("node /app/scripts/initialize-epoch.mjs", runIndex + 1);

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(exerciseIndex).toBeGreaterThan(buildIndex);
    expect(runIndex).toBeGreaterThan(exerciseIndex);
    expect(retryIndex).toBeGreaterThan(runIndex);
    expect(ci.slice(exerciseIndex, runIndex)).toContain("type=volume");
    expect(ci.slice(exerciseIndex, runIndex)).toContain("openthrottle-supervisor:test");
    expect(ci.slice(exerciseIndex, runIndex)).toContain('test -z "$(ls -A /data)"');
    expect(ci.slice(exerciseIndex, runIndex)).not.toContain("docker build");
    expect(ci.slice(retryIndex)).toContain(
      'if [ "$retry_receipt" != "$receipt" ]',
    );
    expect(ci).toContain("packaged initializer returned an invalid receipt");
    expect(ci).toContain("/data/openthrottle-kernel-v1-blobs/.openthrottle-blob-store.json");
  });

  it("exercises packaged refusal, replay, and accepted open-only startup", () => {
    const exerciseIndex = ci.indexOf("Exercise packaged release acceptance");
    const nonquiescentIndex = ci.indexOf("accept-release accepted a non-quiescent epoch", exerciseIndex);
    const schemaIndex = ci.indexOf("accept-release accepted a changed schema", exerciseIndex);
    const receiptIndex = ci.indexOf('receipt="$(accept_release)"', exerciseIndex);
    const replayIndex = ci.indexOf('replay="$(accept_release)"', exerciseIndex);
    const startupIndex = ci.indexOf('openthrottle-supervisor:test >/dev/null', exerciseIndex);
    expect(exerciseIndex).toBeGreaterThanOrEqual(0);
    expect(nonquiescentIndex).toBeGreaterThan(exerciseIndex);
    expect(schemaIndex).toBeGreaterThan(nonquiescentIndex);
    expect(receiptIndex).toBeGreaterThan(schemaIndex);
    expect(replayIndex).toBeGreaterThan(receiptIndex);
    expect(startupIndex).toBeGreaterThan(replayIndex);
    expect(ci.slice(exerciseIndex, startupIndex)).toContain("epoch is not quiesced");
    expect(ci.slice(exerciseIndex, startupIndex)).toContain("schema|table set|fresh epoch");
    expect(ci.slice(startupIndex)).toContain("fresh kernel listening");

    const parsed = YAML.parse(ci);
    const proof = parsed.jobs["docker-smoke"].steps.find(
      ({ name }) => name === "Exercise packaged release acceptance",
    ).run;
    const shell = spawnSync("bash", ["-n"], { input: proof, encoding: "utf8" });
    expect(shell.status, shell.stderr).toBe(0);
  });
});
