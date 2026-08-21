#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const image = process.argv[2] ?? "openthrottle:test";
const root = mkdtempSync(join(tmpdir(), "ot-kernel-structured-"));
const source = join(root, "source");
const requests = join(root, "requests");
const stub = join(root, "claude");
let container = null;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
    timeout: options.timeout ?? 120_000,
  }).trim();
}

function docker(args, options = {}) {
  return run("docker", args, options);
}

function dockerExec(args, options = {}) {
  return docker(["exec", container, ...args], options);
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function writeRequest(name, value) {
  const local = join(requests, `${name}.json`);
  writeFileSync(local, `${JSON.stringify(value)}\n`);
  docker(["cp", local, `${container}:/requests/${name}.json`]);
  dockerExec(["chown", "root:root", `/requests/${name}.json`]);
  dockerExec(["chmod", "0400", `/requests/${name}.json`]);
  return `/requests/${name}.json`;
}

const semanticSchema = {
  schema: "openthrottle.semantic-result-schema/v1",
  id: "core/structured-proof",
  outcomes: ["success", "failure", "needs_human"],
  payload: {
    summary: { type: "string", required: true, max_length: 4000, normalize: "string-array-to-newlines/v1" },
    verification: { type: "string_list", required: true, max_length: 1000, max_items: 32 },
  },
};
const agentInstructions = "Complete exactly one dependency-ordered plan step.";
const skillPayload = {
  frontmatter: { name: "implement-plan", description: "Implement a plan step" },
  instructions: "Make the smallest change that satisfies the sealed task prompt.",
  files: [],
};
const definitionEntries = [
  {
    definition_kind: "agent",
    definition_id: "core/structured-worker",
    content_hash: sha(canonical(agentInstructions)),
    normalized_payload: agentInstructions,
  },
  {
    definition_kind: "skill",
    definition_id: "core/implement-plan",
    content_hash: sha(canonical(skillPayload)),
    normalized_payload: skillPayload,
  },
];

function actionRequest({ name, inputSubject, requestHash }) {
  return {
    schema: "openthrottle.kernel-action-request/v2",
    phase: "work",
    pipeline_run_id: "structured-proof",
    attempt_id: `attempt-${name}`,
    stage_id: name,
    scope: { kind: "stage", stage_id: name },
    request_hash: requestHash,
    definition_bundle_hash: "d".repeat(64),
    input_subject: inputSubject,
    repository_authority: "edit",
    lease_id: `lease-${name}`,
    worker_id: "structured-worker",
    task_prompt: `Implement dependency-ordered step ${name}.`,
    context: { records: [], checkpoints: [] },
    runtime_resource: null,
    change_boundary: null,
    action: {
      kind: "agent",
      engine: "claude",
      model: null,
      reasoning_effort: null,
      agent_id: "core/structured-worker",
      skill_ids: ["core/implement-plan"],
      entry_skill: "core/implement-plan",
      eval_id: semanticSchema.id,
      semantic_result_schema: semanticSchema,
      execution_limits: { max_turns: 12, task_timeout_seconds: 600 },
      definition_entries: definitionEntries,
    },
    executor_policy: { git_administration: "executor_only", commit: false, push: false, publish: false },
  };
}

function runAction(name, request) {
  const requestPath = writeRequest(`action-${name}`, request);
  dockerExec(["mkdir", "-p", `/transport/actions/${name}`]);
  dockerExec([
    "env",
    "PATH=/tmp/stub:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    `OT_ACTION_REQUEST_FILE=${requestPath}`,
    `OT_ACTION_RESULT_FILE=/transport/actions/${name}/result.json`,
    `OT_ACTION_SESSION_FILE=/transport/actions/${name}/session.json`,
    `OT_LEASE_GENERATION_FENCE_FILE=/runtime/fences/${name}.json`,
    `OT_LEASE_GENERATION_LOCK_FILE=/runtime/fences/${name}.lock`,
    "/opt/openthrottle/entrypoint.sh",
  ], { timeout: 180_000 });
  const result = JSON.parse(dockerExec(["cat", `/transport/actions/${name}/result.json`]));
  assert.equal(result.schema, "openthrottle.kernel-runtime-result/v1");
  assert.equal(result.outcome.state, "work_complete");
  assert.equal(result.outcome.result.kind, "semantic");
  assert.equal(result.outcome.result.candidate.transformations[0]?.id, "string-array-to-newlines/v1");
  return result;
}

function integrate(name, action, actionResult, currentSubject) {
  const checkpoint = actionResult.outcome.checkpoint;
  const integration = {
    schema: "openthrottle.kernel-integration-request/v1",
    pipeline_run_id: action.pipeline_run_id,
    effect_id: `effect-${name}`,
    idempotency_key: `structured-proof:${name}`,
    lease_id: `integration-lease-${name}`,
    worker_id: "integration-worker",
    definition_bundle_hash: action.definition_bundle_hash,
    current_subject: currentSubject,
    candidate_checkpoint_id: checkpoint.id,
    candidate_input_subject: action.input_subject,
    candidate_output_subject: checkpoint.output_subject,
    candidate_artifact: checkpoint.payload_artifact,
  };
  const local = join(requests, `integration-${name}.json`);
  writeFileSync(local, `${JSON.stringify(integration)}\n`);
  docker(["cp", local, `${container}:/transport/actions/${name}/integration-request.json`]);
  dockerExec(["chown", "root:root", `/transport/actions/${name}/integration-request.json`]);
  dockerExec(["chmod", "0400", `/transport/actions/${name}/integration-request.json`]);
  dockerExec(["mkdir", "-p", `/transport/integrations/${name}`]);
  const environment = [
    "env",
    `OT_INTEGRATION_REQUEST_FILE=/transport/actions/${name}/integration-request.json`,
    `OT_INTEGRATION_RESULT_FILE=/transport/integrations/${name}/result.json`,
    "/opt/openthrottle/entrypoint.sh",
  ];
  dockerExec(environment, { timeout: 180_000 });
  const result = JSON.parse(dockerExec(["cat", `/transport/integrations/${name}/result.json`]));
  assert.equal(result.schema, "openthrottle.kernel-integration-result/v1");
  assert.equal(result.state, "integrated");
  assert.equal(result.payload_artifact.commit, result.output_subject);
  assert.equal(result.payload_artifact.payload_schema, "openthrottle.git-checkpoint-bundle/v1");

  // The same effect lease is replay-safe and byte-identical.
  dockerExec(environment, { timeout: 180_000 });
  assert.deepEqual(
    JSON.parse(dockerExec(["cat", `/transport/integrations/${name}/result.json`])),
    result,
  );
  dockerExec([
    "git", "-C", "/home/agent/repo", "fetch", "--quiet",
    `/transport/integrations/${name}/${result.payload_artifact.file}`,
    `${result.payload_artifact.ref}:refs/openthrottle/accepted/${name}`,
  ]);
  assert.equal(
    dockerExec(["git", "-C", "/home/agent/repo", "rev-parse", `refs/openthrottle/accepted/${name}`]),
    result.output_subject,
  );
  return result;
}

try {
  mkdirSync(source, { recursive: true });
  mkdirSync(requests, { recursive: true });
  run("git", ["-C", source, "init", "--quiet", "--initial-branch=main"]);
  run("git", ["-C", source, "config", "user.name", "Structured Proof"]);
  run("git", ["-C", source, "config", "user.email", "proof@example.com"]);
  writeFileSync(join(source, "WORK.md"), "base\n");
  run("git", ["-C", source, "add", "."]);
  run("git", ["-C", source, "commit", "--quiet", "-m", "base"]);
  const base = run("git", ["-C", source, "rev-parse", "HEAD"]);

  writeFileSync(stub, String.raw`#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
mkdir -p /tmp/kernel-launch-count
printf 'launch\n' >> "/tmp/kernel-launch-count/$OT_ATTEMPT_ID"
case "$OT_ATTEMPT_ID" in
  attempt-a)
    grep -qx base WORK.md
    printf 'step-a\n' >> WORK.md
    summary='["Completed step A.","Checkpoint ready."]'
    ;;
  attempt-b)
    grep -qx step-a WORK.md
    printf 'step-b\n' >> WORK.md
    summary='["Completed step B.","Dependency observed."]'
    ;;
  *) exit 42 ;;
esac
printf '{"type":"system","subtype":"init","session_id":"session-%s"}\n' "$OT_ATTEMPT_ID"
printf '{"type":"result","subtype":"success","structured_output":{"schema":"openthrottle.result-candidate/v1","outcome":"success","payload":{"summary":%s,"verification":["dependency assertion passed"]}}}\n' "$summary"
`);
  chmodSync(stub, 0o755);

  container = docker(["run", "-d", "--entrypoint", "tail", image, "-f", "/dev/null"]);
  dockerExec(["mkdir", "-p", "/home/agent/repo", "/requests", "/transport", "/runtime/fences", "/tmp/stub"]);
  docker(["cp", `${source}/.`, `${container}:/home/agent/repo/`]);
  docker(["cp", stub, `${container}:/tmp/stub/claude`]);
  dockerExec(["chown", "-R", "root:root", "/home/agent/repo", "/tmp/stub"]);
  dockerExec(["chmod", "0755", "/tmp/stub/claude"]);
  for (const name of ["a", "b"]) {
    dockerExec([
      "sh", "-c",
      'printf \'{"schema":"openthrottle.kernel-lease-generation-fence/v1","attempt_id":"%s","lease_generation":0}\\n\' "$1" > "$2"; : > "$3"; chown root:root "$2" "$3"; chmod 0444 "$2" "$3"',
      "_", `attempt-${name}`, `/runtime/fences/${name}.json`, `/runtime/fences/${name}.lock`,
    ]);
  }

  const actionA = actionRequest({ name: "a", inputSubject: base, requestHash: "1".repeat(64) });
  const resultA = runAction("a", actionA);
  const acceptedA = integrate("a", actionA, resultA, base);

  // The second attempt can only materialize if the first exact accepted commit
  // was imported into the source object database.
  const actionB = actionRequest({ name: "b", inputSubject: acceptedA.output_subject, requestHash: "2".repeat(64) });
  const resultB = runAction("b", actionB);
  const acceptedB = integrate("b", actionB, resultB, acceptedA.output_subject);

  assert.equal(
    dockerExec(["git", "-C", "/home/agent/repo", "show", `${acceptedB.output_subject}:WORK.md`]),
    "base\nstep-a\nstep-b",
  );
  assert.equal(dockerExec(["wc", "-l", "/tmp/kernel-launch-count/attempt-a"]).split(/\s+/)[0], "1");
  assert.equal(dockerExec(["wc", "-l", "/tmp/kernel-launch-count/attempt-b"]).split(/\s+/)[0], "1");

  // A lost acknowledgement of the second action returns immutable evidence,
  // not a second model launch.
  runAction("b", actionB);
  assert.equal(dockerExec(["wc", "-l", "/tmp/kernel-launch-count/attempt-b"]).split(/\s+/)[0], "1");

  process.stdout.write("structured kernel walking skeleton passed\n");
} finally {
  if (container) {
    try { docker(["rm", "-f", container], { quiet: true }); } catch {}
  }
  rmSync(root, { recursive: true, force: true });
}
