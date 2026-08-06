#!/usr/bin/env node
// RU10: two-unit Docker walking skeleton.
//
// Composes the BUILT supervisor's structured child coordinator/effect
// modules (supervisor/dist, produced by `npm run build --prefix supervisor`)
// with a test-only, provider-neutral SandboxRuntime adapter. The adapter's
// methods invoke the BUILT container's sealed worktree, loop, command,
// result-collection, integration, and cleanup executors over `docker exec`.
// All reduction and gate decisions stay in the production supervisor
// modules; this harness never fabricates a receipt, gate decision, or
// aggregate outcome itself.
//
// No Linear, Daytona, Fly, GitHub, or model credentials are used or read.
//
// Usage: node sandbox/tests/structured-walking-skeleton.mjs [image]

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

import { createPipelineEffectProcessor } from "../../supervisor/dist/operations/pipeline-effects.js";
import { createSupervisorStore } from "../../supervisor/dist/persistence/store.js";
import { openDb } from "../../supervisor/dist/persistence/database.js";
import { createPipelineStore } from "../../supervisor/dist/persistence/pipeline/create-store.js";
import { loadPipelineCatalog, parseRepositoryConfig } from "../../supervisor/dist/pipeline/manifest.js";
import { parseAndCompileExecutionGraph } from "../../supervisor/dist/pipeline/execution-graph.js";
import { validateRuntimeCapabilityDescriptor } from "../../supervisor/dist/runtime/contracts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const IMAGE = process.argv[2] ?? "openthrottle:test";
const STRUCTURED_GRAPH_PATH = join(REPO_ROOT, "supervisor", "graphs", "structured-v1.json");
const CATALOG_PATH = join(REPO_ROOT, "supervisor", "pipelines", "catalog.yaml");
const STUB_AGENT_PATH = join(__dirname, "fixtures", "walking-skeleton-agent-stub.mjs");

const LOOP_ACTION_DIR = "/var/lib/openthrottle/loop-actions";
const CHILD_EXECUTOR_DIR = "/var/lib/openthrottle/child-executor-actions";
const STAGE_INPUT_DIR = "/var/lib/openthrottle/stage-input";
const INTEGRATION_REPO_DIR = "/home/agent/repo";
const MAX_DRAIN_STEPS = 400;
// A wedged container init or hung `docker exec` must fail this proof gate
// loudly and fast, not hang until an outer CI timeout eventually kills it.
const DOCKER_EXEC_TIMEOUT_MS = 10 * 60 * 1000;

function log(message) {
  process.stderr.write(`[walking-skeleton] ${message}\n`);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

// ---------------------------------------------------------------------------
// Docker helpers -- the only place this harness talks to the built image.
// ---------------------------------------------------------------------------

// Mirrors the shape/fence checks supervisor/src/providers/daytona/adapter.ts's
// parseCollectedLoopResult / parseCollectedChildExecutorResult perform on a
// collected result before trusting it -- this test-only adapter caches the
// container's result synchronously, but a coordinator/executor bug that
// writes a result under the right path with wrong fields (mismatched
// request_hash, an invalid outcome) must not silently flow into production
// reduction code just because it parsed as JSON.
const RESULT_OUTCOMES = new Set(["success", "failure", "needs_human", "retryable_infrastructure_failure"]);

function assertValidResultEnvelope({ event, kind, request }) {
  assert(event.kind === kind, `${kind} result has wrong envelope kind ${event.kind}`);
  assert(event.version === 1, `${kind} result has unsupported version ${event.version}`);
  assert(event.action_id === request.actionId, `${kind} result action_id mismatch for ${request.actionId}`);
  assert(event.attempt_id === request.attemptId, `${kind} result attempt_id mismatch for ${request.actionId}`);
  assert(event.request_hash === request.requestHash, `${kind} result request_hash mismatch for ${request.actionId}`);
  assert(RESULT_OUTCOMES.has(event.outcome), `${kind} result has invalid outcome ${event.outcome}`);
  assert(typeof event.receipt === "string", `${kind} result is missing a receipt string`);
  assert(typeof event.created_at === "string" && !Number.isNaN(Date.parse(event.created_at)), `${kind} result has an invalid created_at`);
}

function docker(args, options = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: DOCKER_EXEC_TIMEOUT_MS,
    killSignal: "SIGKILL",
    ...options,
  });
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGKILL") {
    throw new Error(`docker ${args.join(" ")} timed out after ${DOCKER_EXEC_TIMEOUT_MS}ms`);
  }
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function dockerExecArgs(container, execArgs, { input, user } = {}) {
  return ["exec", ...(input !== undefined ? ["-i"] : []), ...(user ? ["--user", user] : []), container, ...execArgs];
}

function dockerExec(container, execArgs, { input, user } = {}) {
  return docker(dockerExecArgs(container, execArgs, { input, user }), { input });
}

function dockerExecStatus(container, execArgs, { input, user } = {}) {
  const args = dockerExecArgs(container, execArgs, { input, user });
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: DOCKER_EXEC_TIMEOUT_MS,
    killSignal: "SIGKILL",
    input,
  });
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGKILL") {
    throw new Error(`docker ${args.join(" ")} timed out after ${DOCKER_EXEC_TIMEOUT_MS}ms`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function dockerWriteRootFile(container, path, content, mode = "0400") {
  const dir = path.slice(0, path.lastIndexOf("/"));
  dockerExec(container, ["sh", "-c", `install -d -o root -g root -m 0700 '${dir}'`]);
  dockerExec(
    container,
    ["sh", "-c", `cat > '${path}' && chown root:root '${path}' && chmod ${mode} '${path}'`],
    { input: content }
  );
}

function dockerReadFile(container, path) {
  return dockerExec(container, ["cat", path]);
}

// ---------------------------------------------------------------------------
// Git fixture -- a local bare repository standing in for the ticket's origin.
// ---------------------------------------------------------------------------

function createFixtureRepo(workDir) {
  const bareDir = join(workDir, "repo.git");
  const checkoutDir = join(workDir, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", bareDir], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", checkoutDir], { stdio: "ignore" });
  const git = (args) => execFileSync("git", ["-C", checkoutDir, ...args], { stdio: "ignore" });
  git(["config", "user.email", "walking-skeleton@openthrottle.dev"]);
  git(["config", "user.name", "OpenThrottle Walking Skeleton"]);
  writeFileSync(join(checkoutDir, "package.json"), `{"name":"walking-skeleton","private":true}\n`);
  writeFileSync(join(checkoutDir, "WORK.md"), "# Walking skeleton fixture\n");
  writeFileSync(
    join(checkoutDir, ".openthrottle.yml"),
    [
      "agent: claude",
      "model: kimi-code/kimi-for-coding",
      "post_bootstrap: []",
      "limits:",
      "  max_turns: 2",
      "  task_timeout: 30",
      "commands:",
      "  test: \"test -f /tmp/ot-walking-skeleton-test-marker || { touch /tmp/ot-walking-skeleton-test-marker; exit 1; }\"",
      "  lint: \"true\"",
      "  build: \"true\"",
      "",
    ].join("\n")
  );
  git(["add", "package.json", "WORK.md", ".openthrottle.yml"]);
  execFileSync("git", ["-C", checkoutDir, "commit", "-m", "test: seed walking-skeleton fixture"], { stdio: "ignore" });
  execFileSync("git", ["-C", checkoutDir, "remote", "add", "origin", `file://${bareDir}`], { stdio: "ignore" });
  execFileSync("git", ["-C", checkoutDir, "push", "-u", "origin", "main"], { stdio: "ignore" });
  const baseCommit = execFileSync("git", ["-C", checkoutDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { bareDir, checkoutDir, baseCommit };
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

function startContainer(fixture) {
  const name = `ot-walking-skeleton-${randomBytes(4).toString("hex")}`;
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--entrypoint",
    "tail",
    "-v",
    `${fixture.bareDir}:/fixture/repo.git`,
    "-v",
    `${STUB_AGENT_PATH}:/usr/local/bin/claude:ro`,
    IMAGE,
    "-f",
    "/dev/null",
  ]);
  return name;
}

function stopContainer(name) {
  try {
    docker(["rm", "-f", name]);
  } catch {
    // best effort
  }
}

function readRuntimeDescriptor(container) {
  const raw = dockerExec(container, ["node", "/opt/openthrottle/runner/capabilities.mjs", "--print"]);
  return validateRuntimeCapabilityDescriptor(JSON.parse(raw));
}

// ---------------------------------------------------------------------------
// Test-only, provider-neutral SandboxRuntime adapter.
//
// Every method that a real Daytona adapter would use to talk to a live
// sandbox instead runs the exact same runner CLI inside the built container
// via `docker exec`, synchronously. Since local docker exec has no
// meaningful async latency, dispatch performs the real work immediately and
// caches the parsed result; collect returns the cached result. This is a
// valid provider shape for SandboxRuntime (a "fast" provider) and never
// substitutes for or bypasses production reduction/gate logic -- those stay
// in structured-child-runtime.ts / unit-coordinator.ts / execution-gates.ts.
// ---------------------------------------------------------------------------

function createDockerSandboxRuntime(container) {
  const cachedLoopResults = new Map();
  const cachedChildResults = new Map();
  const worktreeHandles = new Map();
  const counters = { createWorktree: 0, dispatchLoopAction: 0, dispatchChildExecutorAction: 0, cleanupWorktree: 0 };

  function requestHandleFor(input) {
    return sha256(`${input.idempotencyKey}:${input.attemptId}:${input.baseCommit}`).slice(0, 32);
  }

  return {
    counters,
    worktreeHandles,

    async provision() {
      return { providerResourceId: container };
    },

    async bootstrap(_resource, input) {
      dockerWriteRootFile(container, `${STAGE_INPUT_DIR}/repository-config.json`, input.sealedRepositoryConfig);
      dockerWriteRootFile(container, `${STAGE_INPUT_DIR}/pipeline-manifest.json`, input.normalizedManifest);
    },

    async materializeCredentials() {
      // RU10 uses no operator credentials; every loop/child-executor action
      // below runs with a materialized-empty credential envelope (see
      // dispatchLoopAction), matching sandbox/runner/loop-credentials.mjs's
      // documented empty-envelope fallback.
    },

    async prepareCompositeWorkspace(_resource, request) {
      const requestPath = `${STAGE_INPUT_DIR}/requests/${request.attemptId}.json`;
      dockerWriteRootFile(container, requestPath, JSON.stringify(request));
      const result = dockerExecStatus(container, [
        "env",
        "-i",
        "HOME=/home/agent",
        "OT_COMPOSITE_PREPARE_ONLY=1",
        `OT_STAGE_REQUEST_FILE=${requestPath}`,
        `OT_STAGE_CONFIG_FILE=${STAGE_INPUT_DIR}/repository-config.json`,
        `OT_STAGE_MANIFEST_FILE=${STAGE_INPUT_DIR}/pipeline-manifest.json`,
        "OT_SMOKE_TEST=1",
        "OT_GIT_URL_OVERRIDE=file:///fixture/repo.git",
        `RUN_ID=${request.runId}`,
        `GITHUB_REPO=${request.repository}`,
        "GITHUB_TOKEN=walking-skeleton-token",
        `BASE_BRANCH=${request.baseBranch}`,
        `BRANCH_NAME=${request.branch}`,
        `TASK_TYPE=${request.taskType}`,
        "TASK_TIMEOUT=300",
        "/opt/openthrottle/entrypoint.sh",
      ]);
      if (result.status !== 0) {
        throw new Error(`composite workspace preparation failed (${result.status}): ${result.stderr}`);
      }
    },

    async dispatchStage() {
      throw new Error("walking skeleton: dispatchStage must never be invoked for a graph/for-each-unit@1 stage");
    },
    async collectStageResult() {
      throw new Error("walking skeleton: collectStageResult must never be invoked for a graph/for-each-unit@1 stage");
    },

    async createWorktree(_resource, input) {
      counters.createWorktree += 1;
      const handle = requestHandleFor(input);
      const raw = dockerExec(container, [
        "node",
        "/opt/openthrottle/runner/worktrees.mjs",
        "create",
        "--idempotent",
        "--handle",
        handle,
        "--base",
        input.baseCommit,
      ]);
      JSON.parse(raw);
      worktreeHandles.set(handle, input.baseCommit);
      return { id: handle };
    },

    async dispatchLoopAction(_resource, request) {
      counters.dispatchLoopAction += 1;
      const requestPath = `${LOOP_ACTION_DIR}/${request.attemptId}/${request.actionId}/request.json`;
      const outputPath = `${LOOP_ACTION_DIR}/${request.attemptId}/${request.actionId}/result.json`;
      const credentialsPath = `${LOOP_ACTION_DIR}/${request.attemptId}/${request.actionId}/credentials.json`;
      dockerWriteRootFile(container, requestPath, JSON.stringify(request));
      const result = dockerExecStatus(container, [
        "env",
        "-i",
        "HOME=/home/agent",
        "USER=agent",
        "LOGNAME=agent",
        "SHELL=/bin/bash",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        `RUN_ID=${request.parentRunId ?? "walking-skeleton"}`,
        `OT_CHILD_ACTION_ID=${request.actionId}`,
        "node",
        "/opt/openthrottle/runner/execute-loop.mjs",
        "--request",
        requestPath,
        "--credentials",
        credentialsPath,
        "--output",
        outputPath,
      ]);
      if (result.status !== 0) {
        throw new Error(`loop action ${request.actionId} (${request.loop}/${request.unitId ?? "final"}) failed: ${result.stderr}`);
      }
      const raw = dockerReadFile(container, outputPath);
      const event = JSON.parse(raw);
      assertValidResultEnvelope({ event, kind: "loop_action_result", request });
      cachedLoopResults.set(`${request.attemptId}:${request.actionId}`, {
        actionId: request.actionId,
        attemptId: event.attempt_id,
        requestHash: event.request_hash,
        outcome: event.outcome,
        nativeSessionId: event.native_session_id,
        subject: event.subject,
        receipt: event.receipt,
        completedAt: event.created_at,
        ...(typeof event.codex_auth_json === "string" ? { codexAuthJson: event.codex_auth_json } : {}),
      });
      return { providerDispatchId: `loop-${request.actionId}` };
    },

    async collectLoopActionResult(_resource, input) {
      const cached = cachedLoopResults.get(`${input.attemptId}:${input.actionId}`);
      if (!cached) return null;
      assert(cached.requestHash === input.requestHash, `cached loop result request_hash mismatch for ${input.actionId}`);
      return cached;
    },

    async dispatchChildExecutorAction(_resource, request) {
      counters.dispatchChildExecutorAction += 1;
      const requestPath = `${CHILD_EXECUTOR_DIR}/${request.attemptId}/${request.actionId}/request.json`;
      const outputPath = `${CHILD_EXECUTOR_DIR}/${request.attemptId}/${request.actionId}/result.json`;
      dockerWriteRootFile(container, requestPath, JSON.stringify(request));
      const result = dockerExecStatus(container, [
        "env",
        "-i",
        "HOME=/home/agent",
        "USER=agent",
        "LOGNAME=agent",
        "SHELL=/bin/bash",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        `OT_STAGE_CONFIG_FILE=${STAGE_INPUT_DIR}/repository-config.json`,
        `RUN_ID=${request.parentRunId}`,
        `OT_CHILD_ACTION_ID=${request.actionId}`,
        "node",
        "/opt/openthrottle/runner/execute-child-action.mjs",
        "--request",
        requestPath,
        "--output",
        outputPath,
      ]);
      // execute-child-action.mjs still writes a typed failure result on a
      // thrown error (see childActionFailureResult); only a missing result
      // file is unrecoverable here.
      const raw = dockerReadFile(container, outputPath);
      const event = JSON.parse(raw);
      assertValidResultEnvelope({ event, kind: "child_executor_action_result", request });
      if (result.status !== 0 && event.outcome !== "retryable_infrastructure_failure") {
        throw new Error(`child executor action ${request.actionId} (${request.actionKind}) failed: ${result.stderr}`);
      }
      cachedChildResults.set(`${request.attemptId}:${request.actionId}`, {
        actionId: request.actionId,
        attemptId: event.attempt_id,
        requestHash: event.request_hash,
        outcome: event.outcome,
        subject: event.subject,
        receipt: event.receipt,
        completedAt: event.created_at,
      });
      return { providerDispatchId: `child-executor-${request.actionId}` };
    },

    async collectChildExecutorActionResult(_resource, input) {
      const cached = cachedChildResults.get(`${input.attemptId}:${input.actionId}`);
      if (!cached) return null;
      assert(cached.requestHash === input.requestHash, `cached child executor result request_hash mismatch for ${input.actionId}`);
      return cached;
    },

    async cleanupWorktree(_resource, handle) {
      counters.cleanupWorktree += 1;
      dockerExec(container, ["node", "/opt/openthrottle/runner/worktrees.mjs", "remove", "--handle", handle.id]);
      worktreeHandles.delete(handle.id);
    },

    async renewLiveness() {
      return { observedAt: new Date().toISOString() };
    },
    async stop() {
      return { confirmed: true };
    },
    async quarantine() {},
    async cleanup() {},
    async setActive() {},
    async setIdle() {},
  };
}

// ---------------------------------------------------------------------------
// Supervisor instance/store construction -- mirrors the proven pattern in
// supervisor/src/operations/pipeline-effects.test.ts's
// "drains graph-declared child executor actions..." test, with a real
// container-derived runtime descriptor in place of a test fixture.
// ---------------------------------------------------------------------------

function buildTwoUnitPlan({ planId, unitBAcceptanceSuffix = "" }) {
  return {
    schema: "openthrottle.execution-plan/v1",
    graph_id: "structured",
    plan_id: planId,
    instructions: {
      implement_a: "Append a fixture note to WORK.md for unit A.",
      implement_b: "Append a fixture note to WORK.md for unit B.",
    },
    acceptance: {
      unit_a_done: "Unit A's fixture note is present.",
      unit_b_done: `Unit B's fixture note is present.${unitBAcceptanceSuffix}`,
    },
    units: [
      { id: "unit_a", title: "Unit A", depends_on: [], instructions: ["implement_a"], acceptance: ["unit_a_done"] },
      { id: "unit_b", title: "Unit B", depends_on: ["unit_a"], instructions: ["implement_b"], acceptance: ["unit_b_done"] },
    ],
    commands: [],
  };
}

function taskContextFor(plan) {
  return ["Approved structured plan.", "", "```json openthrottle.execution-plan/v1", JSON.stringify(plan, null, 2), "```"].join("\n");
}

function setupInstance({ db, pipelines, tickets, runtimeDescriptor, fixture, issueId, plan }) {
  const catalog = loadPipelineCatalog(CATALOG_PATH, runtimeDescriptor.descriptor);
  pipelines.acceptRuntimeDescriptor(runtimeDescriptor);
  pipelines.acceptCatalog(catalog);
  const repositoryConfig = parseRepositoryConfig(
    [
      "schema: openthrottle.config/v1",
      "default_graph: simple",
      "graphs:",
      "  - id: simple",
      "    kind: builtin",
      "    ref: core/simple@1",
      "  - id: structured",
      "    kind: builtin",
      "    ref: core/structured@1",
      "commands: { test: test, lint: lint, build: build }",
      "pipelines: { implement: implement }",
    ].join("\n")
  );
  const config = pipelines.saveRepositoryConfigSnapshot({
    repository: "owner/walking-skeleton",
    baseCommit: fixture.baseCommit,
    blobSha: fixture.baseCommit,
    config: repositoryConfig,
  });
  const manifest = parseAndCompileExecutionGraph(readGraphFile(), {
    id: "builtin/structured",
    runtime: runtimeDescriptor.descriptor,
    config: repositoryConfig.config,
  }).manifest;
  pipelines.acceptManifest(manifest);
  tickets.upsert({
    linear_issue_id: issueId,
    linear_issue_identifier: issueId,
    linear_session_id: `session-${issueId}`,
    sandbox_id: null,
    branch: `ot/${issueId}`,
    agent: "claude",
    repo: "owner/walking-skeleton",
    pr_url: null,
    state: "active",
    pipeline: {
      repository: "owner/walking-skeleton",
      baseCommit: fixture.baseCommit,
      manifest,
      repositoryConfig: config,
      runtime: runtimeDescriptor,
      authorizedCapabilities: manifest.manifest.requires.capabilities,
      taskType: "implement",
      taskContext: taskContextFor(plan),
    },
  });
  const instance = pipelines.getInstanceForSession(`session-${issueId}`);
  assert(instance, `pipeline instance for ${issueId} was not created`);
  const attempt = pipelines.getActiveAttempt(instance.id);
  assert(attempt, `pipeline attempt for ${issueId} was not created`);
  return { instance, attempt };
}

let graphFileCache;
function readGraphFile() {
  if (!graphFileCache) graphFileCache = readFileSync(STRUCTURED_GRAPH_PATH, "utf8");
  return graphFileCache;
}

async function drainUntilSettled(processor, pipelines, attemptId, label) {
  for (let step = 0; step < MAX_DRAIN_STEPS; step += 1) {
    await processor.drain();
    const attempt = pipelines.getAttempt(attemptId);
    if (attempt && ["completed", "failed", "canceled", "superseded"].includes(attempt.status)) {
      const outstanding = pipelines
        .listWorkAttempts(attemptId)
        .some((action) => ["pending", "leased", "dispatched", "running"].includes(action.status));
      if (!outstanding) return attempt;
    }
  }
  throw new Error(`${label}: graph did not settle within ${MAX_DRAIN_STEPS} drain steps`);
}

// ---------------------------------------------------------------------------
// Scenario: happy path -- two ordered stub units through the full sequence,
// including one deliberate command failure/repair on unit A. Proves RAE8.
// ---------------------------------------------------------------------------

async function runHappyPath({ db, container, fixture }) {
  log("scenario: happy path (two units, one command repair)");
  const pipelines = createPipelineStore(db);
  const tickets = createSupervisorStore(db, pipelines);
  const runtimeDescriptor = readRuntimeDescriptor(container);
  const runtime = createDockerSandboxRuntime(container);
  const plan = buildTwoUnitPlan({ planId: "walking-skeleton-happy-path" });
  const { instance, attempt } = setupInstance({
    db,
    pipelines,
    tickets,
    runtimeDescriptor,
    fixture,
    issueId: "walking-skeleton-happy",
    plan,
  });
  const processor = createPipelineEffectProcessor({
    store: pipelines,
    tickets,
    runtime,
    taskTimeoutSeconds: 300,
    now: () => new Date(),
  });

  const settled = await drainUntilSettled(processor, pipelines, attempt.id, "happy path");
  assert(settled.status === "completed", `expected the composite stage to complete, got ${settled.status}`);

  const graph = pipelines.getGraphForAttempt(attempt.id);
  assert(graph?.aggregate_emitted_at, "aggregate was never emitted");
  assert(GIT_SHA1.test(graph.integration_subject ?? ""), "graph has no exact integration subject");

  const units = pipelines.listUnits(attempt.id);
  assert(units.length === 2, `expected 2 units, found ${units.length}`);
  const unitA = units.find((unit) => unit.unitId === "unit_a");
  const unitB = units.find((unit) => unit.unitId === "unit_b");
  assert(unitA?.terminalLevel === "completed", "unit_a did not complete");
  assert(unitB?.terminalLevel === "completed", "unit_b did not complete");
  assert(unitA.integrationSubject && unitB.integrationSubject, "both units must have an integration subject");
  assert(unitA.integrationSubject !== unitB.integrationSubject, "unit_b must integrate at a new head, not unit_a's");
  assert(graph.integration_subject === unitB.integrationSubject, "the graph head must be unit_b's integrated head");

  // RAE8 / RAE2: unit_b's worktree must have been created with unit_a's
  // exact integrated head as its base, never the original base commit.
  const unitBWorktreeCreates = [...runtime.worktreeHandles.entries()];
  assert(
    unitBWorktreeCreates.some(([, base]) => base === unitA.integrationSubject),
    "no worktree was created with unit_a's integrated head as its base"
  );

  const unitAActions = pipelines.listWorkAttempts(attempt.id).filter((action) => action.unit_id === "unit_a");
  assert(
    unitAActions.some((action) => action.action_kind === "repair" && action.status === "completed"),
    "unit_a's deliberately failing first test command did not trigger a repair cycle"
  );

  log(
    `happy path settled: unit_a=${unitA.integrationSubject.slice(0, 12)} unit_b=${unitB.integrationSubject.slice(0, 12)} ` +
      `worktreeCreates=${runtime.counters.createWorktree} loopDispatches=${runtime.counters.dispatchLoopAction} ` +
      `childExecutorDispatches=${runtime.counters.dispatchChildExecutorAction}`
  );

  return { pipelines, tickets, runtime, instance, attempt, graph, processor };
}

// ---------------------------------------------------------------------------
// Scenario: restart/replay -- a fresh processor bound to the SAME durable
// store must not re-integrate or duplicate the aggregate.
// ---------------------------------------------------------------------------

async function runReplayScenario({ db, container, happy }) {
  log("scenario: restart/replay does not duplicate integration");
  const runtime = createDockerSandboxRuntime(container);
  const processor = createPipelineEffectProcessor({
    store: happy.pipelines,
    tickets: happy.tickets,
    runtime,
    taskTimeoutSeconds: 300,
    now: () => new Date(),
  });
  const before = happy.pipelines.getGraphForAttempt(happy.attempt.id);
  for (let step = 0; step < 5; step += 1) await processor.drain();
  const after = happy.pipelines.getGraphForAttempt(happy.attempt.id);
  assert(after.aggregate_artifact_hash === before.aggregate_artifact_hash, "replay must not change the sealed aggregate hash");
  assert(after.integration_subject === before.integration_subject, "replay must not move the integration head");
  assert(runtime.counters.dispatchChildExecutorAction === 0, "replay must not dispatch a new integration");
  assert(runtime.counters.dispatchLoopAction === 0, "replay must not dispatch a new loop action");
  log("replay settled with zero new dispatches");
}

// ---------------------------------------------------------------------------
// Scenario: an unaccepted unit must block aggregate success (RAE6 / RR16).
// ---------------------------------------------------------------------------

async function runNeedsHumanScenario({ db, container, fixture }) {
  log("scenario: an unaccepted unit cannot yield aggregate success");
  const pipelines = createPipelineStore(db);
  const tickets = createSupervisorStore(db, pipelines);
  const runtimeDescriptor = readRuntimeDescriptor(container);
  const runtime = createDockerSandboxRuntime(container);
  const plan = buildTwoUnitPlan({
    planId: "walking-skeleton-needs-human",
    unitBAcceptanceSuffix: " [STUB_LEAD_RESULT=needs_human]",
  });
  const { instance, attempt } = setupInstance({
    db,
    pipelines,
    tickets,
    runtimeDescriptor,
    fixture,
    issueId: "walking-skeleton-needs-human",
    plan,
  });
  const processor = createPipelineEffectProcessor({
    store: pipelines,
    tickets,
    runtime,
    taskTimeoutSeconds: 300,
    now: () => new Date(),
  });
  const settled = await drainUntilSettled(processor, pipelines, attempt.id, "needs-human");
  assert(settled.status !== "completed", `an unaccepted unit must not settle as completed, got ${settled.status}`);
  const units = pipelines.listUnits(attempt.id);
  const unitB = units.find((unit) => unit.unitId === "unit_b");
  // Pin the specific RAE6/RR16 mechanism -- not just "some non-completed
  // outcome" (which an unrelated regression, e.g. a command-phase crash,
  // could also satisfy) -- but that unit_b's lead decision was itself the
  // needs_human escalation this scenario injected.
  assert(unitB?.terminalLevel === "exited", `unit_b must reach terminalLevel "exited" for a needs_human lead decision, got ${unitB?.terminalLevel}`);
  const graph = pipelines.getGraphForAttempt(attempt.id);
  assert(graph?.stop_reason === "lead_needs_human", `expected the graph to stop for reason "lead_needs_human", got ${graph?.stop_reason}`);
  log(`needs-human aggregate settled as ${settled.status} (unit_b terminal=${unitB?.terminalLevel}, stop_reason=${graph?.stop_reason})`);
}

// ---------------------------------------------------------------------------
// Scenario: a worker cannot commit, push, or integrate directly -- reuses
// the worktree created for unit_a's happy-path implement action.
// ---------------------------------------------------------------------------

function runDirectMutationScenario({ container, happy }) {
  log("scenario: direct agent commit/push/integration attempts fail");
  const push = dockerExecStatus(
    container,
    ["git", "-C", INTEGRATION_REPO_DIR, "push", "origin", "HEAD:refs/heads/main"],
    { user: "agent" }
  );
  assert(push.status !== 0, "the agent user must not be able to push the integration checkout directly");
  const commit = dockerExecStatus(
    container,
    ["git", "-C", INTEGRATION_REPO_DIR, "commit", "--allow-empty", "-m", "direct mutation attempt"],
    { user: "agent" }
  );
  assert(commit.status !== 0, "the agent user must not be able to commit directly in the integration checkout");
  log("direct commit/push attempts against the integration checkout were rejected as expected");
}

const GIT_SHA1 = /^[a-f0-9]{40}$/;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), "ot-walking-skeleton-"));
  let container;
  let db;
  try {
    log(`building fixture repository under ${workDir}`);
    const fixture = createFixtureRepo(workDir);
    log(`starting container from image ${IMAGE}`);
    container = startContainer(fixture);

    db = openDb(":memory:");
    const happy = await runHappyPath({ db, container, fixture });
    runDirectMutationScenario({ container, happy });
    await runReplayScenario({ db, container, happy });
    await runNeedsHumanScenario({ db, container, fixture });

    log("structured walking skeleton PASSED");
  } finally {
    db?.close();
    if (container) stopContainer(container);
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`[walking-skeleton] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
