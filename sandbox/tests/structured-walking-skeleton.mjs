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
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { createPipelineEffectProcessor } from "../../supervisor/dist/operations/pipeline-effects.js";
import { createSupervisorStore } from "../../supervisor/dist/persistence/store.js";
import { openDb } from "../../supervisor/dist/persistence/database.js";
import { createPipelineStore } from "../../supervisor/dist/persistence/pipeline/create-store.js";
import { loadPipelineCatalog, parseRepositoryConfig } from "../../supervisor/dist/pipeline/manifest.js";
import { parseAndCompileExecutionGraph } from "../../supervisor/dist/pipeline/execution-graph.js";
import { validateRuntimeCapabilityDescriptor } from "../../supervisor/dist/runtime/contracts.js";
import { digestCanonicalJson } from "../../contracts/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const IMAGE = process.argv[2] ?? "openthrottle:test";
const STRUCTURED_GRAPH_PATH = join(REPO_ROOT, "supervisor", "graphs", "structured-v2.json");
const WALKING_SKELETON_REPAIR_ROUNDS = 2;
const CATALOG_PATH = join(REPO_ROOT, "supervisor", "pipelines", "catalog.yaml");
const STUB_AGENT_PATH = join(__dirname, "fixtures", "walking-skeleton-agent-stub.mjs");
// The configured `test` command, shared by the fixture's own .openthrottle.yml
// and the repository-config snapshot the supervisor seals, so the two can
// never drift into disagreeing about how many times it fails.
//
// It fails its first TWO runs, then passes, so unit_a takes two consecutive
// repair cycles. One was not enough: a repair cycle gets a fresh worktree, and
// OPE-101 gen-9 only fired on the SECOND move, when the transcript being
// restored already carried two different cwds (see alignClaudeProjectDirectory
// in sandbox/runner/native-session-package.mjs). The count lives in the
// container's /tmp rather than a worktree, so the failure budget is spent once
// across the whole run: unit_b's command run and every later scenario's pass
// on the first try.
const TEST_COMMAND_COUNT_PATH = "/tmp/ot-walking-skeleton-test-count";
// The unit `command` gate runs in a bare per-cycle worktree, not in the
// bake-once-bootstrapped integration checkout. post_bootstrap installs an
// executable under the gitignored node_modules/.bin, and the test command
// REQUIRES it before anything else -- so a worktree whose sealed
// post_bootstrap was never re-run fails exit 127 exactly like the live
// defect (`sh: 1: tsc: not found`), and this skeleton fails with it.
const BOOTSTRAP_TOOL = "node_modules/.bin/ot-bootstrap-dep";
const POST_BOOTSTRAP_COMMAND = `mkdir -p node_modules/.bin && cp /bin/true ${BOOTSTRAP_TOOL} && chmod 0755 ${BOOTSTRAP_TOOL}`;
const TEST_COMMAND = `./${BOOTSTRAP_TOOL} || exit 127; count=$(cat ${TEST_COMMAND_COUNT_PATH} 2>/dev/null || echo 0); `
  + `count=$((count + 1)); echo $count > ${TEST_COMMAND_COUNT_PATH}; test $count -gt 2`;

const OPENTHROTTLE_ROOT = "/var/lib/openthrottle";
const LOOP_ACTION_DIR = "/var/lib/openthrottle/loop-actions";
const LOOP_DISPATCH_DIR = "/var/lib/openthrottle/loop-dispatch";
const CHILD_EXECUTOR_DIR = "/var/lib/openthrottle/child-executor-actions";
const STAGE_INPUT_DIR = "/var/lib/openthrottle/stage-input";
const INTEGRATION_REPO_DIR = "/home/agent/repo";
const MAX_DRAIN_STEPS = 400;
// A wedged container init or hung `docker exec` must fail this proof gate
// loudly and fast, not hang until an outer CI timeout eventually kills it.
const DOCKER_EXEC_TIMEOUT_MS = 10 * 60 * 1000;
// Bounds real wall-clock time spent honoring pipeline-effects' RETRY_BASE_MS
// * 2^n backoff in drainUntilSettled -- generous for the deliberate one-shot
// command repair this harness exercises, without hot-looping through a
// genuine failure's real backoff schedule only to discard the cause.
const DRAIN_RETRY_BUDGET_MS = 3 * 60 * 1000;

const BASE_EXEC_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
// The image's `claude` at /usr/local/bin/claude resolves through a symlink
// to a `.exe`-suffixed target (pinned CLAUDE_CODE_VERSION). Docker's bind
// mount resolves that destination symlink, so mounting the ESM stub directly
// over /usr/local/bin/claude lands it under the `.exe` name and Node's
// loader rejects it with ERR_UNKNOWN_FILE_EXTENSION. Instead the stub is
// mounted at a fixed non-symlink container path and shadowed onto the
// agent's PATH via a plain wrapper script, leaving the image's own claude
// symlink untouched.
const STUB_AGENT_CONTAINER_PATH = "/opt/openthrottle-stub/claude-stub.mjs";
const STUB_BIN_DIR = "/opt/openthrottle-stub/bin";
const AGENT_EXEC_PATH = `${STUB_BIN_DIR}:${BASE_EXEC_PATH}`;

// Mirrors sandbox/runner/launch-failure.mjs's ENGINE_CREDENTIAL_ENV: the one
// env var each engine authenticates with. The stub agent never reads these
// values (see walking-skeleton-agent-stub.mjs) -- only their *presence*
// matters, since execute-loop.mjs now fails closed before ever launching the
// engine when a "model.invoke" action finds no staged credential envelope at
// all (as opposed to one that stages zero vars for a role that declares no
// credential scopes).
const ENGINE_CREDENTIAL_ENV_BY_AGENT = {
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
  codex: "CODEX_AUTH_JSON",
  opencode: "KIMI_CODE_API_KEY",
};

function log(message) {
  process.stderr.write(`[walking-skeleton] ${message}\n`);
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

function shellSingleQuoted(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
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
  // node_modules must be ignored, exactly as in a real repository: the
  // bootstrap-produced dependency state must never dirty the integration
  // checkout's clean fence or leak into a derived candidate commit.
  writeFileSync(join(checkoutDir, ".gitignore"), "node_modules/\n");
  writeFileSync(
    join(checkoutDir, ".openthrottle.yml"),
    [
      "agent: claude",
      "model: kimi-code/kimi-for-coding",
      "post_bootstrap:",
      `  - "${POST_BOOTSTRAP_COMMAND}"`,
      "limits:",
      "  max_turns: 2",
      "  task_timeout: 30",
      "commands:",
      `  test: "${TEST_COMMAND}"`,
      "  lint: \"true\"",
      "  build: \"true\"",
      "",
    ].join("\n")
  );
  git(["add", "package.json", "WORK.md", ".gitignore", ".openthrottle.yml"]);
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
    `${STUB_AGENT_PATH}:${STUB_AGENT_CONTAINER_PATH}:ro`,
    IMAGE,
    "-f",
    "/dev/null",
  ]);
  return name;
}

// OPE-104 regression pin. The real Daytona bootstrap creates the sandbox
// root itself as root:root 0700 (MkdirAll stamps that same mode on every
// directory it creates, including parents). This harness's own directory
// creation instead uses GNU coreutils `install -d`, which -- unlike Go's
// MkdirAll -- does NOT stamp the requested mode on parents it creates only
// implicitly; without this pin, the first `install -d -m 0700 <subdir>`
// call anywhere below would leave OPENTHROTTLE_ROOT itself at the default
// 0755 (already traversable), which is exactly why CI never caught the
// untraversable-root trap. Must run before any other directory gets created
// under OPENTHROTTLE_ROOT, so nothing else has a chance to auto-create it
// with the wrong mode first.
function pinSandboxRootMode(container) {
  dockerExec(container, ["sh", "-c", `install -d -o root -g root -m 0700 '${OPENTHROTTLE_ROOT}'`]);
}

// Shadows `claude` on the agent-facing PATH (AGENT_EXEC_PATH) with a plain
// wrapper that execs the mounted stub -- see AGENT_EXEC_PATH's comment for
// why this cannot just bind-mount over /usr/local/bin/claude directly. Both
// the wrapper directory and the wrapper file must be world-traversable /
// world-executable: the loop action later execs this as the unprivileged
// `agent` user via gosu, not root.
function installClaudeStubShadow(container) {
  dockerExec(container, ["sh", "-c", `install -d -o root -g root -m 0755 '${STUB_BIN_DIR}'`]);
  dockerExec(
    container,
    ["sh", "-c", `cat > '${STUB_BIN_DIR}/claude' && chown root:root '${STUB_BIN_DIR}/claude' && chmod 0755 '${STUB_BIN_DIR}/claude'`],
    { input: `#!/bin/sh\nexec node '${STUB_AGENT_CONTAINER_PATH}' "$@"\n` }
  );
}

function stopContainer(name) {
  try {
    docker(["rm", "-f", name]);
  } catch {
    // best effort
  }
}

// The container's reported capabilities cannot change within one run, so
// cache it the same way readGraphFile below caches the static graph file --
// every scenario in main() shares the one container this harness starts.
let runtimeDescriptorCache;
function readRuntimeDescriptor(container) {
  if (!runtimeDescriptorCache) {
    const raw = dockerExec(container, ["node", "/opt/openthrottle/runner/capabilities.mjs", "--print"]);
    runtimeDescriptorCache = validateRuntimeCapabilityDescriptor(JSON.parse(raw));
  }
  return runtimeDescriptorCache;
}

// ---------------------------------------------------------------------------
// Test-only, provider-neutral SandboxRuntime adapter.
//
// Every method that a real Daytona adapter would use to talk to a live
// sandbox instead runs the exact same runner CLI inside the built container
// via `docker exec`. Loop dispatch is detached so the provider acknowledgement
// precedes completion evidence exactly as the SandboxRuntime contract requires;
// collect polls the executor-owned result file. Production reduction/gate
// logic stays in structured-child-runtime.ts / unit-coordinator.ts /
// execution-gates.ts.
// ---------------------------------------------------------------------------

function createDockerSandboxRuntime(container) {
  const cachedLoopResults = new Map();
  const dispatchedLoopRequests = new Map();
  const completedReviewPersonaActions = new Set();
  const lastReviewPersonaByParent = new Map();
  const cachedChildResults = new Map();
  const worktreeHandles = new Map();
  const dispatchedWorktreeIds = new Set();
  // Worktree handle each resuming dispatch was sealed against, keyed by the
  // session it resumed. The stub agent refuses a resume whose transcript is
  // not under its own cwd's project slug (walking-skeleton-agent-stub.mjs),
  // so a resume dispatched into a DIFFERENT worktree than the one that
  // sealed the session is what proves the restore relocates it (OPE-101).
  const resumedSessionWorktrees = new Map();
  const counters = {
    createWorktree: 0,
    dispatchLoopAction: 0,
    dispatchChildExecutorAction: 0,
    cleanupWorktree: 0,
    serialReviewPersonaTransitions: 0,
  };
  // The container is genuinely shared across scenarios, but production
  // enforces one pipeline instance per runtime_provider_resource_id -- give
  // each runtime adapter (one per scenario, or per restart within a
  // scenario) its own resource id so distinct instances never collide on
  // that DB-level UNIQUE constraint.
  const providerResourceId = `${container}-${randomBytes(4).toString("hex")}`;

  // Must byte-for-byte match production's worktreeHandleFor
  // (supervisor/src/operations/structured-child-runtime.ts), which computes
  // the sealed worktree handle production embeds in the dispatched request
  // and then DISCARDS this adapter's own createWorktree return value. If
  // this derivation ever drifted from production's, the container worktree
  // this adapter creates would silently stop matching the handle the sealed
  // request actually references ("worktree handle does not exist").
  function requestHandleFor(input) {
    return digestCanonicalJson({
      idempotencyKey: input.idempotencyKey,
      attemptId: input.attemptId,
      baseCommit: input.baseCommit,
    }).slice(0, 32);
  }

  return {
    counters,
    dispatchedLoopRequests,
    worktreeHandles,
    dispatchedWorktreeIds,
    resumedSessionWorktrees,

    loopExecutorStartCount(request) {
      const auditPath = `/tmp/ot-walking-skeleton-loop-starts/${request.attemptId}.${request.actionId}.log`;
      const count = dockerExecStatus(container, ["sh", "-c", `test -f ${shellSingleQuoted(auditPath)} && wc -l < ${shellSingleQuoted(auditPath)}`]);
      return count.status === 0 ? Number.parseInt(count.stdout.trim(), 10) : 0;
    },

    async provision() {
      return { providerResourceId };
    },

    async bootstrap(_resource, input) {
      dockerWriteRootFile(container, `${STAGE_INPUT_DIR}/repository-config.json`, input.sealedRepositoryConfig);
      dockerWriteRootFile(container, `${STAGE_INPUT_DIR}/pipeline-manifest.json`, input.normalizedManifest);
    },

    async materializeCredentials() {
      // RU10 uses no operator credentials; dispatchLoopAction below stages a
      // stub-valued credential envelope per loop action instead (a real
      // value is never used or read -- see ENGINE_CREDENTIAL_ENV_BY_AGENT).
    },

    async prepareCompositeWorkspace(_resource, request) {
      const requestPath = `${STAGE_INPUT_DIR}/requests/${request.attemptId}.json`;
      dockerWriteRootFile(container, requestPath, JSON.stringify(request));
      const result = dockerExecStatus(container, [
        "env",
        "-i",
        "HOME=/home/agent",
        `PATH=${BASE_EXEC_PATH}`,
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
        throw new Error(
          `composite workspace preparation failed (${result.status}): stderr=${result.stderr} stdout=${result.stdout}`
        );
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
      const reviewSeparatorIndex = request.actionId.lastIndexOf(".review.");
      const isReviewPersona = reviewSeparatorIndex >= 0 &&
        request.skill !== "select-review-personas" &&
        request.skill !== "validate-review-findings";
      if (isReviewPersona) {
        const parentActionId = request.actionId.slice(0, reviewSeparatorIndex);
        const previousPersonaActionId = lastReviewPersonaByParent.get(parentActionId);
        if (previousPersonaActionId && previousPersonaActionId !== request.actionId) {
          // Non-Codex regression: Claude personas share one sealed sandbox.
          // Persona N+1 may launch only after collect observed persona N's
          // durable result; dispatch acknowledgement alone is insufficient.
          assert(
            completedReviewPersonaActions.has(previousPersonaActionId),
            `review persona ${request.actionId} launched before ${previousPersonaActionId} completed`
          );
          counters.serialReviewPersonaTransitions += 1;
        }
        lastReviewPersonaByParent.set(parentActionId, request.actionId);
      }
      if (request.worktree?.id) dispatchedWorktreeIds.add(request.worktree.id);
      if (request.nativeSessionId && request.worktree?.id) {
        const seen = resumedSessionWorktrees.get(request.nativeSessionId) ?? new Set();
        seen.add(request.worktree.id);
        resumedSessionWorktrees.set(request.nativeSessionId, seen);
      }
      const requestPath = `${LOOP_ACTION_DIR}/${request.attemptId}/${request.actionId}/request.json`;
      const outputPath = `${LOOP_ACTION_DIR}/${request.attemptId}/${request.actionId}/result.json`;
      const credentialsPath = `${LOOP_ACTION_DIR}/${request.attemptId}/${request.actionId}/credentials.json`;
      const dispatchNonce = randomBytes(16).toString("hex");
      const stagedRequestPath = `${LOOP_DISPATCH_DIR}/${request.attemptId}.${request.actionId}.${dispatchNonce}.request.json`;
      const stagedCredentialsPath = `${LOOP_DISPATCH_DIR}/${request.attemptId}.${request.actionId}.${dispatchNonce}.credentials.json`;
      const lockPath = `${LOOP_DISPATCH_DIR}/${request.attemptId}.${request.actionId}.lock`;
      const auditDirectory = "/tmp/ot-walking-skeleton-loop-starts";
      const auditPath = `${auditDirectory}/${request.attemptId}.${request.actionId}.log`;
      const activeReplayProbe = request.transitionContext.includes("walking-skeleton-loop-adapter-replay");
      dockerWriteRootFile(container, stagedRequestPath, JSON.stringify(request));
      // Real provider adapters always stage a credentials.json for every loop
      // action (materializeCredentialEnv runs unconditionally in
      // supervisor/src/providers/daytona/adapter.ts, even when it resolves to
      // an empty env for a role with no declared scopes) -- a *missing* file
      // is reserved for "never staged at all". Match that contract here: a
      // stub value only when the action actually declares "model.invoke",
      // never a real credential ("No ... model credentials are used or read").
      const credentialEnv = request.credentialScopes.includes("model.invoke")
        ? { [ENGINE_CREDENTIAL_ENV_BY_AGENT[request.agent]]: "walking-skeleton-stub-token" }
        : {};
      dockerWriteRootFile(container, stagedCredentialsPath, JSON.stringify({ env: credentialEnv }));
      const cleanEnv = [
        "env",
        "-i",
        "HOME=/home/agent",
        "USER=agent",
        "LOGNAME=agent",
        "SHELL=/bin/bash",
        `PATH=${AGENT_EXEC_PATH}`,
        `RUN_ID=${request.parentRunId ?? "walking-skeleton"}`,
        `OT_CHILD_ACTION_ID=${request.actionId}`,
      ].map(shellSingleQuoted).join(" ");
      const dispatchBody = [
        `if test -f ${shellSingleQuoted(outputPath)}; then rm -f ${shellSingleQuoted(stagedCredentialsPath)} ${shellSingleQuoted(stagedRequestPath)}; exit 0; fi`,
        `install -d -o root -g root -m 0711 ${shellSingleQuoted(LOOP_ACTION_DIR)} ${shellSingleQuoted(`${LOOP_ACTION_DIR}/${request.attemptId}`)} ${shellSingleQuoted(`${LOOP_ACTION_DIR}/${request.attemptId}/${request.actionId}`)}`,
        `cp ${shellSingleQuoted(stagedRequestPath)} ${shellSingleQuoted(requestPath)}`,
        `cp ${shellSingleQuoted(stagedCredentialsPath)} ${shellSingleQuoted(credentialsPath)}`,
        `chown root:root ${shellSingleQuoted(requestPath)} ${shellSingleQuoted(credentialsPath)}`,
        `chmod 400 ${shellSingleQuoted(requestPath)} ${shellSingleQuoted(credentialsPath)}`,
        `rm -f ${shellSingleQuoted(stagedCredentialsPath)} ${shellSingleQuoted(stagedRequestPath)}`,
        `install -d -o root -g root -m 0700 ${shellSingleQuoted(auditDirectory)}`,
        `printf 'start\\n' >> ${shellSingleQuoted(auditPath)}`,
        activeReplayProbe ? "sleep 2" : "true",
        `${cleanEnv} ${shellSingleQuoted("node")} ${shellSingleQuoted("/opt/openthrottle/runner/execute-loop.mjs")} --request ${shellSingleQuoted(requestPath)} --credentials ${shellSingleQuoted(credentialsPath)} --output ${shellSingleQuoted(outputPath)}`,
      ].join(" && ");
      const guardedDispatch = `flock --nonblock ${shellSingleQuoted(lockPath)} sh -c ${shellSingleQuoted(dispatchBody)}` +
        ` || rm -f ${shellSingleQuoted(stagedCredentialsPath)} ${shellSingleQuoted(stagedRequestPath)}`;
      docker([
        "exec",
        "-d",
        container,
        "sh",
        "-c",
        guardedDispatch,
      ]);
      dispatchedLoopRequests.set(`${request.attemptId}:${request.actionId}`, request);
      return { providerDispatchId: `loop-${request.actionId}` };
    },

    async collectLoopActionResult(_resource, input) {
      const key = `${input.attemptId}:${input.actionId}`;
      const cached = cachedLoopResults.get(key);
      if (cached) {
        assert(cached.requestHash === input.requestHash, `cached loop result request_hash mismatch for ${input.actionId}`);
        return cached;
      }
      const requestPath = `${LOOP_ACTION_DIR}/${input.attemptId}/${input.actionId}/request.json`;
      const outputPath = `${LOOP_ACTION_DIR}/${input.attemptId}/${input.actionId}/result.json`;
      if (dockerExecStatus(container, ["test", "-f", outputPath]).status !== 0) return null;
      const request = JSON.parse(dockerReadFile(container, requestPath));
      assert(request.actionId === input.actionId, `sealed loop request action_id mismatch for ${input.actionId}`);
      assert(request.attemptId === input.attemptId, `sealed loop request attempt_id mismatch for ${input.actionId}`);
      assert(request.requestHash === input.requestHash, `sealed loop request request_hash mismatch for ${input.actionId}`);
      const event = JSON.parse(dockerReadFile(container, outputPath));
      assertValidResultEnvelope({ event, kind: "loop_action_result", request });
      const result = {
        actionId: input.actionId,
        attemptId: event.attempt_id,
        requestHash: event.request_hash,
        outcome: event.outcome,
        nativeSessionId: event.native_session_id,
        subject: event.subject,
        receipt: event.receipt,
        completedAt: event.created_at,
        ...(typeof event.codex_auth_json === "string" ? { codexAuthJson: event.codex_auth_json } : {}),
      };
      if (input.actionId.includes(".review.") &&
          request.skill !== "select-review-personas" &&
          request.skill !== "validate-review-findings") {
        completedReviewPersonaActions.add(input.actionId);
      }
      cachedLoopResults.set(key, result);
      return result;
    },

    async dispatchChildExecutorAction(_resource, request) {
      counters.dispatchChildExecutorAction += 1;
      if (request.worktree?.id) dispatchedWorktreeIds.add(request.worktree.id);
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
        `PATH=${BASE_EXEC_PATH}`,
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
      "    ref: core/structured@2",
      "post_bootstrap:",
      `  - "${POST_BOOTSTRAP_COMMAND}"`,
      "commands:",
      `  test: "${TEST_COMMAND}"`,
      "  lint: \"true\"",
      "  build: \"true\"",
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
    aggregatePublishContext: "prefer_resume",
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
  if (!graphFileCache) {
    const graph = JSON.parse(readFileSync(STRUCTURED_GRAPH_PATH, "utf8"));
    const leadLoop = graph.loops?.find((loop) => loop.id === "lead-loop");
    assert(leadLoop, "structured walking-skeleton fixture is missing lead-loop");
    // The shipped graph deliberately permits one repeated lead decision. This
    // fixture needs two repair cycles for the OPE-101 second-session-relocation
    // regression, so widen only the ephemeral test graph rather than mutating
    // the immutable builtin contract exercised by admission tests.
    leadLoop.max_rounds = WALKING_SKELETON_REPAIR_ROUNDS;
    graphFileCache = JSON.stringify(graph);
  }
  return graphFileCache;
}

// pipeline-effects schedules a failed effect's retry at RETRY_BASE_MS * 2^n
// against real wall-clock `now`. A tight drain() loop with no wait between
// steps burns through MAX_DRAIN_STEPS in milliseconds without ever reaching
// that retryAt, so a single transient effect failure looks identical to a
// hang -- and the real cause (last_error) was discarded. This honors the
// processor's own backoff with a bounded real wait instead, and surfaces the
// underlying effect error verbatim when the retry budget is exhausted. Every
// drain loop in this harness (full settlement, or a scenario's own
// intermediate pause point) must go through this so none of them can
// silently regress to the tight-loop-without-backoff anti-pattern this was
// written to fix.
async function drainWithBackoff(processor, pipelines, instanceId, isDone, label) {
  const deadline = Date.now() + DRAIN_RETRY_BUDGET_MS;
  let lastEffectError = null;
  for (let step = 0; step < MAX_DRAIN_STEPS; step += 1) {
    await processor.drain();
    const result = isDone();
    if (result) return result;
    const pendingEffects = instanceId
      ? pipelines.listEffects(instanceId).filter((effect) => effect.status === "pending" || effect.status === "failed")
      : [];
    if (pendingEffects.length === 0) continue;
    for (const effect of pendingEffects) {
      if (effect.last_error) lastEffectError = effect.last_error;
    }
    const earliestRetryAtMs = pendingEffects.reduce(
      (earliest, effect) => Math.min(earliest, Date.parse(effect.next_attempt_at)),
      Infinity
    );
    const waitMs = earliestRetryAtMs - Date.now();
    if (waitMs <= 0) continue;
    if (Date.now() + waitMs > deadline) {
      throw new Error(
        `${label}: did not settle within the ${DRAIN_RETRY_BUDGET_MS}ms retry budget` +
          (lastEffectError ? `; last effect error: ${lastEffectError}` : "")
      );
    }
    await sleep(waitMs);
  }
  throw new Error(
    `${label}: did not settle within ${MAX_DRAIN_STEPS} drain steps` +
      (lastEffectError ? `; last effect error: ${lastEffectError}` : "")
  );
}

async function drainUntilSettled(processor, pipelines, attemptId, label) {
  const instanceId = pipelines.getAttempt(attemptId)?.pipeline_instance_id ?? null;
  return drainWithBackoff(
    processor,
    pipelines,
    instanceId,
    () => {
      const attempt = pipelines.getAttempt(attemptId);
      if (!attempt || !["completed", "failed", "canceled", "superseded"].includes(attempt.status)) return null;
      const outstanding = pipelines
        .listWorkAttempts(attemptId)
        .some((action) => ["pending", "leased", "dispatched", "running"].includes(action.status));
      return outstanding ? null : attempt;
    },
    `${label}: graph`
  );
}

// A settle assertion failure is otherwise a bare "expected X, got Y" -- the
// actual cause (which action or effect is stuck, and why) already lives in
// the harness's own DB at that point but was being discarded. Dump it before
// throwing so a CI failure is diagnosable from its log alone.
function dumpSettleDiagnostics({ pipelines, instance, attemptId, label }) {
  const attempt = pipelines.getAttempt(attemptId);
  const units = pipelines.listUnits(attemptId).map((unit) => ({
    unitId: unit.unitId,
    status: unit.status,
    terminalLevel: unit.terminalLevel,
    phase: unit.phase,
    alarm: unit.alarm,
  }));
  const actions = pipelines
    .listWorkAttempts(attemptId)
    .filter((action) => action.status !== "completed")
    .map((action) => ({ id: action.id, status: action.status, last_error: action.last_error }));
  const effects = pipelines.listEffects(instance.id).map((effect) => ({
    status: effect.status,
    attempts: effect.attempts,
    last_error: effect.last_error,
  }));
  log(
    `${label} settle-assertion diagnostics -- ` +
      `attempt: ${JSON.stringify({ status: attempt?.status ?? null, outcome: attempt?.outcome ?? null, last_error: attempt?.last_error ?? null })} ` +
      `units: ${JSON.stringify(units)} ` +
      `non-completed actions: ${JSON.stringify(actions)} ` +
      `effects: ${JSON.stringify(effects)}`
  );
}

// ---------------------------------------------------------------------------
// Provider replay fidelity: lose the first dispatch acknowledgement while the
// executor still owns its action lock, redispatch from a fresh adapter, then
// collect the durable result from a third adapter with no process-local state.
// This mirrors Daytona's result short-circuit + action-scoped flock boundary.
// ---------------------------------------------------------------------------

async function runLoopAdapterReplayScenario({ db, container, fixture }) {
  log("scenario: active loop lost-ack/restart stays single-execution and durably collectable");
  const pipelines = createPipelineStore(db);
  const tickets = createSupervisorStore(db, pipelines);
  const runtimeDescriptor = readRuntimeDescriptor(container);
  const runtimeA = createDockerSandboxRuntime(container);
  const plan = buildTwoUnitPlan({ planId: "walking-skeleton-loop-adapter-replay" });
  const { instance, attempt } = setupInstance({
    db,
    pipelines,
    tickets,
    runtimeDescriptor,
    fixture,
    issueId: "walking-skeleton-loop-adapter-replay",
    plan,
  });
  const processorA = createPipelineEffectProcessor({
    store: pipelines,
    tickets,
    runtime: runtimeA,
    taskTimeoutSeconds: 300,
    now: () => new Date(),
  });

  const request = await drainWithBackoff(
    processorA,
    pipelines,
    instance.id,
    () => runtimeA.dispatchedLoopRequests.values().next().value ?? null,
    "loop adapter replay setup: first dispatch"
  );
  const resultPath = `${LOOP_ACTION_DIR}/${request.attemptId}/${request.actionId}/result.json`;
  const activeDeadline = Date.now() + 10_000;
  while (runtimeA.loopExecutorStartCount(request) !== 1 && Date.now() < activeDeadline) {
    await sleep(25);
  }
  assert(runtimeA.loopExecutorStartCount(request) === 1, "the first loop executor never acquired its action lock");
  assert(
    dockerExecStatus(container, ["test", "-f", resultPath]).status !== 0,
    "the active-loop replay probe completed before the lost-ack redispatch"
  );

  const runtimeB = createDockerSandboxRuntime(container);
  await runtimeB.dispatchLoopAction({ providerResourceId: "walking-skeleton-restarted-runtime" }, request);

  const resultDeadline = Date.now() + 15_000;
  while (dockerExecStatus(container, ["test", "-f", resultPath]).status !== 0 && Date.now() < resultDeadline) {
    await sleep(25);
  }
  assert(dockerExecStatus(container, ["test", "-f", resultPath]).status === 0, "the replayed loop action wrote no durable result");

  const runtimeC = createDockerSandboxRuntime(container);
  const collected = await runtimeC.collectLoopActionResult(
    { providerResourceId: "walking-skeleton-second-restart" },
    { attemptId: request.attemptId, actionId: request.actionId, requestHash: request.requestHash }
  );
  assert(runtimeC.dispatchedLoopRequests.size === 0, "fresh collector unexpectedly carried process-local dispatch state");
  assert(collected?.outcome === "success", `fresh adapter failed to collect the durable result: ${collected?.outcome ?? "missing"}`);
  assert(runtimeC.loopExecutorStartCount(request) === 1, "lost-ack redispatch launched a duplicate loop executor");

  log(`active-loop replay kept ${request.actionId} to one executor and a stateless restart collected its result`);
}

// ---------------------------------------------------------------------------
// Scenario: happy path -- two ordered stub units through the full sequence,
// including two consecutive deliberate command failures/repairs on unit A.
// Proves RAE8.
// ---------------------------------------------------------------------------

async function runHappyPath({ db, container, fixture }) {
  log("scenario: happy path (two units, two consecutive command repairs)");
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
  if (settled.status !== "completed") dumpSettleDiagnostics({ pipelines, instance, attemptId: attempt.id, label: "happy path" });
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
  const unitARepairs = unitAActions.filter((action) => action.action_kind === "repair" && action.status === "completed");
  assert(
    unitARepairs.length >= 2,
    `unit_a's deliberately failing test command must drive two consecutive repair cycles, got ${unitARepairs.length}`
  );

  // OPE-101: a repair cycle gets a brand-new worktree, so its resume runs in
  // a different cwd than the action that sealed the session -- and Claude
  // resolves --resume only under its own cwd's project slug. The stub agent
  // refuses a resume it cannot find there, so this run only stays honest
  // while a session is actually resumed across successive worktrees. If the
  // graph ever stopped resuming, or repair reused an earlier cycle's worktree,
  // the whole scenario would go green without exercising the restore at all.
  //
  // THREE, not two: one move only proves the transcript can be relocated out
  // of the directory the CLI itself named. The second move is the one that
  // restores a transcript an earlier move already relocated -- whose records
  // now carry two different cwds -- which is the case gen-9 died on and a
  // single-repair scenario cannot reach.
  assert(
    [...runtime.resumedSessionWorktrees.values()].some((handles) => handles.size > 2),
    "no native session was resumed across three different worktrees; the second restore relocation is untested"
  );

  assert(
    runtime.counters.serialReviewPersonaTransitions > 0,
    "the Claude walking skeleton did not prove persona N+1 waited for persona N's collected result"
  );

  // Every sealed request that carried a worktree handle must be bound to a
  // container worktree this adapter actually created under that exact
  // handle -- production computes the handle independently of this
  // adapter's createWorktree return value (see requestHandleFor's comment),
  // so this is the proof the two never silently diverged.
  for (const handle of runtime.dispatchedWorktreeIds) {
    assert(runtime.worktreeHandles.has(handle), `sealed request referenced worktree handle ${handle} that was never created in the container`);
  }

  log(
    `happy path settled: unit_a=${unitA.integrationSubject.slice(0, 12)} unit_b=${unitB.integrationSubject.slice(0, 12)} ` +
      `worktreeCreates=${runtime.counters.createWorktree} loopDispatches=${runtime.counters.dispatchLoopAction} ` +
      `childExecutorDispatches=${runtime.counters.dispatchChildExecutorAction}`
  );

  return { pipelines, tickets, runtime, instance, attempt, graph, processor };
}

// ---------------------------------------------------------------------------
// Scenario: restart/replay -- paused at a genuinely NON-TERMINAL, mid-flight
// point (unit_a integrated, unit_b not yet started -- real outstanding
// work), a fresh processor and runtime bound to the SAME durable store must
// resume without re-running or duplicating unit_a's already-completed
// integration. Re-draining an already-terminal attempt (the prior version of
// this scenario) can't exercise that resume path at all, and its aggregate
// check could pass vacuously as null === null; this drives the run to a
// real, non-null aggregate hash.
// ---------------------------------------------------------------------------

async function runReplayScenario({ db, container, fixture }) {
  log("scenario: restart/replay from a non-terminal mid-integration state does not duplicate integration");
  const pipelines = createPipelineStore(db);
  const tickets = createSupervisorStore(db, pipelines);
  const runtimeDescriptor = readRuntimeDescriptor(container);
  const runtimeA = createDockerSandboxRuntime(container);
  const plan = buildTwoUnitPlan({ planId: "walking-skeleton-replay" });
  const { instance, attempt } = setupInstance({
    db,
    pipelines,
    tickets,
    runtimeDescriptor,
    fixture,
    issueId: "walking-skeleton-replay",
    plan,
  });
  const processorA = createPipelineEffectProcessor({
    store: pipelines,
    tickets,
    runtime: runtimeA,
    taskTimeoutSeconds: 300,
    now: () => new Date(),
  });

  const unitAIntegrated = await drainWithBackoff(
    processorA,
    pipelines,
    instance.id,
    () =>
      pipelines
        .listWorkAttempts(attempt.id)
        .find((action) => action.unit_id === "unit_a" && action.action_kind === "integrate" && action.status === "completed") ?? null,
    "replay setup: unit_a's integration"
  );

  const midAttempt = pipelines.getAttempt(attempt.id);
  assert(
    !["completed", "failed", "canceled", "superseded"].includes(midAttempt.status),
    `replay setup: attempt must still be non-terminal at the pause point, got ${midAttempt.status}`
  );
  assert(
    pipelines.listWorkAttempts(attempt.id).every((action) => action.unit_id !== "unit_b"),
    "replay setup: unit_b must not have started yet for this to be a genuine mid-flight pause"
  );
  const beforeOutputSubject = unitAIntegrated.output_subject;
  const beforeCompletedAt = unitAIntegrated.completed_at;

  // Simulate a supervisor restart: a brand-new processor and runtime
  // adapter bound to the SAME durable store, with zero in-memory dispatch
  // history -- proving durable idempotency, not just in-process
  // continuation of the same processor/runtime objects.
  const runtimeB = createDockerSandboxRuntime(container);
  const processorB = createPipelineEffectProcessor({
    store: pipelines,
    tickets,
    runtime: runtimeB,
    taskTimeoutSeconds: 300,
    now: () => new Date(),
  });
  const settled = await drainUntilSettled(processorB, pipelines, attempt.id, "replay restart");
  if (settled.status !== "completed") dumpSettleDiagnostics({ pipelines, instance, attemptId: attempt.id, label: "replay restart" });
  assert(settled.status === "completed", `replay restart must still complete, got ${settled.status}`);

  const unitAAfter = pipelines.listWorkAttempts(attempt.id).find((action) => action.id === unitAIntegrated.id);
  assert(unitAAfter, "unit_a's original integrate action disappeared after restart");
  assert(unitAAfter.output_subject === beforeOutputSubject, "restart must not recompute unit_a's already-completed integration");
  assert(unitAAfter.completed_at === beforeCompletedAt, "restart must not re-run unit_a's already-completed integration");
  const unitAIntegrateActions = pipelines
    .listWorkAttempts(attempt.id)
    .filter((action) => action.unit_id === "unit_a" && action.action_kind === "integrate");
  assert(unitAIntegrateActions.length === 1, `unit_a must have exactly one integrate action, found ${unitAIntegrateActions.length} after restart`);

  const graph = pipelines.getGraphForAttempt(attempt.id);
  assert(graph?.aggregate_artifact_hash, "restart must still yield a non-null aggregate hash");
  log(`replay restart settled with unit_a's integration unchanged (output_subject=${beforeOutputSubject.slice(0, 12)}) and aggregate hash ${graph.aggregate_artifact_hash.slice(0, 12)}`);
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
  // attemptStatusForOutcome (supervisor/src/persistence/pipeline/transition-store.ts)
  // maps every outcome except canceled/superseded/failure/retryable_infrastructure_failure
  // -- including needs_human -- to status "completed"; the real semantic result lives in
  // the separate `outcome` field, not `status`.
  if (settled.outcome !== "needs_human") dumpSettleDiagnostics({ pipelines, instance, attemptId: attempt.id, label: "needs-human" });
  assert(settled.outcome === "needs_human", `an unaccepted unit must settle with outcome "needs_human", got ${settled.outcome}`);
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
// Scenario: a worker cannot commit, push, or integrate directly against the
// executor-owned integration checkout.
//
// lockIntegrationCheckout (sandbox/runner/execute-loop.mjs) chowns this
// checkout root:root and chmods everything under .git to 0600/0700 -- but
// only while a loop action's own agent process is actually running.
// restoreIntegrationCheckout deep-restores agent:agent ownership in every
// loop action's own success-path cleanup, so by the time the happy path has
// settled (between actions, which is when this scenario runs), the checkout
// is genuinely agent-owned, not root-locked. Re-establish the mid-turn
// locked state here before attempting the mutation, matching what an agent
// actually faces if it tries this from inside its own turn; asserting only
// "nonzero exit" would also pass for an unrelated git failure, so this pins
// the actual denial cause and proves the integration ref never moved.
//
// Invokes the real production lockIntegrationCheckout (exported alongside
// restoreIntegrationCheckout for this reason) instead of hand-transcribing
// its chown/chmod scheme in shell, so this proof can never silently drift
// from the actual production fence.
// ---------------------------------------------------------------------------

// The explicit .catch() (rather than relying on Node's default
// unhandled-rejection-crashes-the-process behavior) is what actually
// guarantees a failed lock/restore fails the scenario loudly instead of
// silently proceeding to prove nothing.
function invokeIntegrationCheckoutFn(container, fnName) {
  dockerExec(container, ["node", "-e", `
    import("/opt/openthrottle/runner/execute-loop.mjs").then((m) => {
      if (!m.${fnName}()) throw new Error("${fnName} did not succeed");
    }).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `]);
}

function lockIntegrationCheckoutForScenario(container) {
  invokeIntegrationCheckoutFn(container, "lockIntegrationCheckout");
}

// The counterpart to lockIntegrationCheckoutForScenario: without this, the
// checkout stays root-owned after this scenario, and every later
// prepareCompositeWorkspace in this shared container dies exit 128 trying to
// operate on a root-owned tree it no longer has authority over.
function restoreIntegrationCheckoutForScenario(container) {
  invokeIntegrationCheckoutFn(container, "restoreIntegrationCheckout");
}

function runDirectMutationScenario({ container }) {
  log("scenario: direct agent commit/push/integration attempts fail");
  // The checkout is still agent-owned here (not yet locked), so reading it
  // as root trips git's dubious-ownership safety check; read it as the
  // authority that actually owns it right now.
  const beforeHead = dockerExec(
    container,
    ["git", "-C", INTEGRATION_REPO_DIR, "rev-parse", "HEAD"],
    { user: "agent" }
  ).trim();
  lockIntegrationCheckoutForScenario(container);

  try {
    const push = dockerExecStatus(
      container,
      ["git", "-C", INTEGRATION_REPO_DIR, "push", "origin", "HEAD:refs/heads/main"],
      { user: "agent" }
    );
    assert(push.status !== 0, "the agent user must not be able to push the integration checkout directly");
    assert(
      /not a git repository/i.test(push.stderr),
      `expected the direct push to fail because the locked .git metadata is unreadable, got: ${push.stderr}`
    );

    const commit = dockerExecStatus(
      container,
      ["git", "-C", INTEGRATION_REPO_DIR, "commit", "--allow-empty", "-m", "direct mutation attempt"],
      { user: "agent" }
    );
    assert(commit.status !== 0, "the agent user must not be able to commit directly in the integration checkout");
    assert(
      /not a git repository/i.test(commit.stderr),
      `expected the direct commit to fail because the locked .git metadata is unreadable, got: ${commit.stderr}`
    );

    const afterHead = dockerExec(container, ["git", "-C", INTEGRATION_REPO_DIR, "rev-parse", "HEAD"]).trim();
    assert(afterHead === beforeHead, "the integration ref must be unchanged after the rejected direct mutation attempts");
  } finally {
    restoreIntegrationCheckoutForScenario(container);
  }

  log("direct commit/push attempts against the integration checkout were rejected on the permission fence; integration ref unchanged");
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
    pinSandboxRootMode(container);
    installClaudeStubShadow(container);

    db = openDb(":memory:");
    await runHappyPath({ db, container, fixture });
    runDirectMutationScenario({ container });
    await runReplayScenario({ db, container, fixture });
    await runNeedsHumanScenario({ db, container, fixture });
    await runLoopAdapterReplayScenario({ db, container, fixture });

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
