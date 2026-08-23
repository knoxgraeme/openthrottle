#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  compileDefinitionBundle,
  validateEffectIntent,
} from "@openthrottle/contracts";
import {
  VerifiedKernelDefinitionBundleResolver,
  VerifiedKernelManifestResolver,
} from "../dist/app/kernel-composition.js";
import { openKernelEpoch } from "../dist/app/kernel-bootstrap.js";
import { loadKernelReleaseDefinitions } from "../dist/app/kernel-release.js";
import { KernelRuntimeSessionService } from "../dist/app/kernel-runtime-session.js";
import { KernelStructuredSettlementPlanner } from "../dist/app/kernel-structured-planner.js";
import { VolumeBlobStore } from "../dist/persistence/blob-store.js";
import {
  createFreshEpochBootstrap,
  initializeFreshEpochDatabase,
} from "../dist/persistence/epoch-database.js";
import { SqliteKernelRunEnvironmentStore } from "../dist/persistence/kernel-runtime-context-store.js";
import { SqliteKernelStore } from "../dist/persistence/kernel-store.js";
import { materializeExternalEffectIntents } from "../dist/operations/kernel-external-plans.js";
import { createKernelExternalPlanBindings } from "../dist/operations/kernel-plan-bindings.js";
import {
  createPendingStageAttempt,
} from "../dist/pipeline/kernel/action-request.js";
import { ordinaryKernelPayloadSchemas } from "../dist/pipeline/kernel/evaluator-registry.js";
import { OrdinaryKernelCoordinator } from "../dist/pipeline/kernel/ordinary-coordinator.js";
import { compileKernelCursor } from "../dist/pipeline/kernel/reducer.js";
import { compileStructuredLoopFrontier } from "../dist/pipeline/kernel/structured-coordinator.js";
import { DaytonaKernelAdapter } from "../dist/providers/daytona/kernel-adapter.js";
import { inspectKernelCheckpointBundle } from "../dist/runtime/kernel-checkpoint-bundle.js";
import {
  parseKernelRuntimeResult,
  parseKernelSessionEvent,
} from "../dist/runtime/kernel-wire.js";

const IMAGE = process.argv[2] ?? "openthrottle:test";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_REPOSITORY = "/var/lib/openthrottle/repository-source/repo";
const SOURCE_REPOSITORY_PARENT = "/var/lib/openthrottle/repository-source";
const WORK_REQUEST_SCHEMA = "openthrottle.kernel-work-request/v1";
const RUN_SCHEMA = "openthrottle.kernel-run/v1";
const root = mkdtempSync(join(tmpdir(), "ot-kernel-sandbox-e2e-"));
const containers = [];

function run(command, args, options = {}) {
  const { quiet = false, ...execOptions } = options;
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
      timeout: execOptions.timeout ?? 180_000,
      maxBuffer: 8 * 1024 * 1024,
      ...execOptions,
    }).trim();
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${stderr ? `: ${stderr.slice(-2_000)}` : ""}`,
      { cause: error },
    );
  }
}

function status(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 180_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function docker(container, args, options = {}) {
  return run("docker", ["exec", container, ...args], options);
}

function dockerStatus(container, args, options = {}) {
  return status("docker", ["exec", container, ...args], options);
}

function safePathId(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) {
    throw new Error(`${label} is unsafe for the Docker proof transport`);
  }
  return value;
}

function lineCount(value) {
  return value.trim() ? value.trim().split(/\r?\n/).length : 0;
}

function createSourceRepository(directory, label) {
  const repository = join(directory, "source");
  mkdirSync(repository, { recursive: true });
  run("git", ["-C", repository, "init", "--quiet", "--initial-branch=main"]);
  run("git", ["-C", repository, "config", "user.name", "Kernel E2E"]);
  run("git", ["-C", repository, "config", "user.email", "kernel-e2e@example.com"]);
  writeFileSync(join(repository, "work.txt"), "base\n");
  writeFileSync(join(repository, "structured.txt"), "base\n");
  run("git", ["-C", repository, "add", "."]);
  run("git", ["-C", repository, "commit", "--quiet", "-m", `${label} base`]);
  return {
    repository,
    source: run("git", ["-C", repository, "rev-parse", "HEAD"]),
  };
}

function createCodexStub(path) {
  writeFileSync(path, String.raw`#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
mkdir -p /tmp/kernel-e2e-launches
printf 'launch\n' >> "/tmp/kernel-e2e-launches/$OT_ATTEMPT_ID"

if test -d "$CODEX_HOME/skills/implement-plan"; then
  grep -qx base work.txt
  printf 'ordinary-implemented\n' > work.txt
  kind=action
  first='Ordinary implementation completed.'
  second='Supervisor transport verified.'
elif test -d "$CODEX_HOME/skills/review-change"; then
  grep -qx ordinary-implemented work.txt
  kind=review
  first='Ordinary review completed.'
  second='Accepted checkpoint inspected.'
elif test -d "$CODEX_HOME/skills/implement-unit"; then
  grep -qx base structured.txt
  printf 'structured-implemented\n' >> structured.txt
  kind=unit
  first='Structured unit implemented.'
  second='Frontier checkpoint produced.'
elif test -d "$CODEX_HOME/skills/simplify-unit"; then
  grep -qx structured-implemented structured.txt
  printf 'structured-simplified\n' >> structured.txt
  kind=unit
  first='Structured unit simplified.'
  second='Restarted successor completed.'
else
  echo "unexpected action profile" >&2
  exit 42
fi

node --input-type=module - "$kind" "$first" "$second" "$OT_ATTEMPT_ID" <<'NODE'
const [kind, first, second, attemptId] = process.argv.slice(2);
const payload = kind === "unit"
  ? {
      summary: [first, second],
      assumptions: [],
      decisions: [],
      issues: [],
      verification: ["stub assertions passed"],
      downstream_context: [],
      requested_human_input: [],
    }
  : kind === "review"
    ? { summary: [first, second], findings: [] }
    : {
        summary: [first, second],
        evidence: ["stub assertions passed"],
        findings: [],
        actions: [],
        uncertainty: [],
      };
const candidate = {
  schema: "openthrottle.result-candidate/v1",
  outcome: "success",
  payload,
};
process.stdout.write(JSON.stringify({
  type: "thread.started",
  thread_id: "session-" + attemptId,
}) + "\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: JSON.stringify(candidate) },
}) + "\n");
NODE
`);
  chmodSync(path, 0o755);
}

function startContainer(directory, sourceRepository) {
  const stub = join(directory, "codex");
  createCodexStub(stub);
  const container = run("docker", ["run", "-d", "--entrypoint", "tail", IMAGE, "-f", "/dev/null"]);
  containers.push(container);
  docker(container, ["mkdir", "-p", SOURCE_REPOSITORY, "/transport", "/tmp/stub"]);
  run("docker", ["cp", `${sourceRepository}/.`, `${container}:${SOURCE_REPOSITORY}/`]);
  run("docker", ["cp", stub, `${container}:/tmp/stub/codex`]);
  docker(container, ["sh", "-c", `find -P ${SOURCE_REPOSITORY} -exec chown -h root:root -- {} +`]);
  docker(container, ["sh", "-c", `find -P ${SOURCE_REPOSITORY} ! -type l -exec chmod go-w -- {} +`]);
  docker(container, ["chown", "-R", "root:root", "/tmp/stub"]);
  docker(container, ["chown", "root:root", SOURCE_REPOSITORY_PARENT]);
  docker(container, ["chmod", "0700", SOURCE_REPOSITORY_PARENT]);
  docker(container, ["chmod", "0755", "/tmp/stub/codex"]);
  return container;
}

function compilePipeline(release, source, pipelineId) {
  const configPath = ".openthrottle/config.yml";
  const original = readFileSync(join(REPOSITORY_ROOT, configPath), "utf8");
  const selected = original.replace(/^pipeline: .*$/m, `pipeline: ${pipelineId}`);
  assert.match(selected, new RegExp(`^pipeline: ${pipelineId}$`, "m"));
  const compilation = compileDefinitionBundle({
    repository: {
      source_commit: source,
      files: new Map([[configPath, { type: "file", content: selected }]]),
    },
    platform: release.platform,
    compiler_environment: release.compiler_environment,
    selected_pipeline: pipelineId,
  });
  assert.equal(compilation.bundle.value.source_commit, source);
  assert.equal(compilation.bundle.value.pipeline_id, pipelineId);
  assert.equal(compilation.manifest.value.definition_bundle_hash, compilation.bundle.digest);
  return compilation;
}

function definitionSnapshots(compilation) {
  return compilation.bundle.value.entries.map((entry) => ({
    definition_kind: entry.definition_kind,
    definition_id: entry.definition_id,
    source_commit: entry.origin.source_commit,
    content_hash: entry.content_hash,
    normalized_payload: entry.normalized_payload,
  }));
}

function createRun({ id, compilation, source, cursor, attempts }) {
  return {
    schema: RUN_SCHEMA,
    id,
    pipeline_id: compilation.manifest.value.pipeline_id,
    definition_bundle_hash: compilation.bundle.digest,
    current_subject: source,
    status: "pending",
    terminal_outcome: null,
    cursor,
    version: 0,
    work_retry_limit: 1,
    result_correction_limit: 1,
    active_attempt_versions: Object.fromEntries(attempts.map((attempt) => [attempt.id, attempt.version])),
    active_effect_versions: {},
    checkpoint_ids: {},
  };
}

function seedRun({ store, blobs, registrationId, compilation, run, attempts, taskPrompt }) {
  const bundle = blobs.put({
    bytes: compilation.bundle.normalized,
    encoding: "utf-8",
    media_type: "application/json",
    payload_schema: "openthrottle.definition-bundle/v1",
    expected_digest: compilation.bundle.digest,
  });
  store.admitPipelineRun({
    work_item: {
      id: `work-${run.id}`,
      repository_registration_id: registrationId,
      source_provider: "operator",
      source_id: `source-${run.id}`,
      source_reference: run.id,
      state: "active",
      title: `Kernel sandbox proof ${run.id}`,
      payload_schema: WORK_REQUEST_SCHEMA,
      payload: { inline: { schema: WORK_REQUEST_SCHEMA, task_prompt: taskPrompt } },
    },
    definitions: definitionSnapshots(compilation),
    run,
    definition_bundle: bundle,
    initial_attempts: attempts,
  });
}

function runtimeProvisionDelivery(runId, identity) {
  return {
    schema: "openthrottle.record/v1",
    kind: "delivery",
    id: `delivery-${runId}-runtime`,
    pipeline_run_id: runId,
    effect_id: `effect-${runId}-runtime`,
    idempotency_key: `${runId}:runtime`,
    external_identity: `daytona:${identity}`,
    status: "confirmed",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: { inline: {
      effect_kind: "daytona/create-sandbox@1",
      provider: "daytona",
      result: { identity },
    } },
    created_at: "2026-08-22T00:00:00.000Z",
  };
}

async function assertPublicationPreflight({
  active,
  compilation,
  blobs,
  taskPrompt,
  implementation,
  runId,
  implementationAttemptId,
}) {
  const view = await active.store.loadExactReductionView({
    pipeline_run_id: runId,
    attempt_id: implementationAttemptId,
    record_ids: [],
    checkpoint_ids: [implementation.checkpoint_id],
  });
  const candidate = view.checkpoints.get(implementation.checkpoint_id);
  assert(candidate, "ordinary implementation must persist its exact checkpoint");
  assert.equal(
    candidate.id,
    `checkpoint:${implementation.request_hash.slice(0, 32)}`,
  );
  assert.equal(candidate.output_subject, implementation.output_subject);

  const runtimeIdentity = "d".repeat(64);
  const runtimeDelivery = runtimeProvisionDelivery(view.run.id, runtimeIdentity);
  const context = {
    records: new Map([[runtimeDelivery.id, runtimeDelivery]]),
    checkpoints: view.checkpoints,
  };
  const publishAttempt = createPendingStageAttempt({
    id: `attempt-${"c".repeat(48)}`,
    pipeline_run_id: view.run.id,
    stage_id: "publish",
    input_subject: implementation.output_subject,
    bundle: compilation.bundle.value,
    manifest: compilation.manifest.value,
    action_inputs: {
      task_prompt: taskPrompt,
      context: { records: [runtimeDelivery], checkpoints: [candidate] },
    },
  });
  const publishStage = view.manifest.stages.find(({ id }) => id === "publish");
  assert.equal(publishStage?.kind, "effect");
  assert.equal(publishStage.effect, "core/publish@1");

  const environments = new SqliteKernelRunEnvironmentStore({ db: active.db });
  const plans = createKernelExternalPlanBindings({ environments, blob_store: blobs });
  const publish = plans.find(({ external_kind }) => external_kind === "core/publish@1");
  assert(publish, "kernel plan registry must expose core/publish@1");
  const prepared = await publish.prepare({
    run: view.run,
    attempt: publishAttempt,
    stage: publishStage,
    context,
    bundle: compilation.bundle.value,
  });
  assert.equal(prepared.checkpoint_payload.candidate_checkpoint_id, candidate.id);
  const integrationPhase = prepared.phases[0];
  assert.equal(integrationPhase?.id, "integrate-checkpoint");
  assert.equal(integrationPhase.effects.length, 1);
  assert.equal(
    integrationPhase.effects[0]?.payload.candidate_checkpoint_id,
    candidate.id,
  );

  const intents = materializeExternalEffectIntents({
    run_id: view.run.id,
    attempt_id: publishAttempt.id,
    decision_record_id: "decision-ordinary-publication-preflight",
    phase_id: integrationPhase.id,
    candidates: integrationPhase.effects,
  });
  assert.equal(intents.length, 1);
  const intent = intents[0];
  assert(intent, "publication preflight must materialize its integration EffectIntent");
  assert.deepEqual(
    validateEffectIntent(intent, { source: "publication_preflight_intent" }).value,
    intent,
  );
  assert.equal(intent.kind, "daytona/integrate-checkpoint@1");
  assert.equal(intent.payload.candidate_checkpoint_id, candidate.id);
  assert(intent.idempotency_key.length > 200 && intent.idempotency_key.length <= 500);

  let providerTouches = 0;
  const daytona = new Proxy({}, {
    get() {
      providerTouches += 1;
      throw new Error("pre-dispatch integration reconciliation touched Daytona");
    },
  });
  const adapter = new DaytonaKernelAdapter(daytona, {
    snapshot: "kernel-e2e",
    github_read_token: "unused",
    task_timeout_seconds: 1,
    runtime_capability_digest: compilation.manifest.value.runtime_capability_digest,
    blob_store: blobs,
    environments,
    attempt_inputs: {
      loadAttemptRequestInputs() {
        throw new Error("publication preflight does not load Attempt inputs");
      },
    },
    materialize_model_credentials() {
      throw new Error("publication preflight does not materialize model credentials");
    },
    poll_interval_ms: 1,
  });
  const integration = adapter.effectBindings().find(
    ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
  );
  assert(integration, "Daytona adapter must expose integration reconciliation");
  assert.deepEqual(await integration.adapter.reconcile({
    intent,
    external_identity: intent.target,
    dispatch_fence: null,
  }), { kind: "not_found" });
  assert.equal(providerTouches, 0);
}

class DockerKernelRuntime {
  constructor({ container, directory, blobs }) {
    this.container = container;
    this.directory = directory;
    this.blobs = blobs;
    this.requests = [];
  }

  async executeWork(request, callbacks) {
    this.requests.push(request);
    return this.#execute(request, callbacks);
  }

  async correctResult() {
    throw new Error("the bounded kernel/sandbox proof does not enter result correction");
  }

  async #execute(request, callbacks) {
    await callbacks.on_heartbeat();
    const attempt = safePathId(request.attempt_id, "attempt ID");
    const lease = safePathId(request.lease_id, "lease ID");
    const leaseGeneration = callbacks.lease_generation;
    assert(
      Number.isSafeInteger(leaseGeneration) && leaseGeneration >= 0,
      "runtime callback must carry a non-negative lease generation",
    );
    const containerDirectory = `/transport/actions/${attempt}/${lease}`;
    const requestPath = `${containerDirectory}/request.json`;
    const resultPath = `${containerDirectory}/result.json`;
    const sessionPath = `${containerDirectory}/session.json`;
    const leaseGenerationFencePath = `${containerDirectory}/lease-generation.json`;
    const leaseGenerationLockPath = `${containerDirectory}/lease-generation.lock`;

    const collect = async () => {
      if (dockerStatus(this.container, ["test", "-f", resultPath]).status !== 0) return null;
      if (request.action.kind === "agent") {
        const session = parseKernelSessionEvent(
          docker(this.container, ["cat", sessionPath], { quiet: true }),
          request,
        );
        await callbacks.on_session(session.native_session_id);
      }
      return parseKernelRuntimeResult({
        raw: docker(this.container, ["cat", resultPath], { quiet: true }),
        request,
        artifacts: {
          materialize: (descriptor) => this.#materializeArtifact(
            request,
            containerDirectory,
            descriptor,
          ),
        },
      });
    };

    const replay = await collect();
    if (replay !== null) return replay;

    this.#materializeInputSubject(request);
    docker(this.container, ["mkdir", "-p", containerDirectory]);
    const localRequest = join(this.directory, `${attempt}-${lease}.request.json`);
    writeFileSync(localRequest, `${canonicalJson(request)}\n`, { mode: 0o400 });
    const localLeaseGenerationFence = join(
      this.directory,
      `${attempt}-${lease}-${leaseGeneration}.lease-generation.json`,
    );
    writeFileSync(localLeaseGenerationFence, `${canonicalJson({
      schema: "openthrottle.kernel-lease-generation-fence/v1",
      attempt_id: request.attempt_id,
      lease_generation: leaseGeneration,
    })}\n`, { mode: 0o400 });
    run("docker", ["cp", localRequest, `${this.container}:${requestPath}`]);
    run("docker", ["cp", localLeaseGenerationFence, `${this.container}:${leaseGenerationFencePath}`]);
    docker(this.container, ["touch", leaseGenerationLockPath]);
    docker(this.container, ["chown", "root:root", requestPath]);
    docker(this.container, [
      "chown", "root:root", leaseGenerationFencePath, leaseGenerationLockPath,
    ]);
    docker(this.container, ["chmod", "0400", requestPath]);
    docker(this.container, ["chmod", "0444", leaseGenerationFencePath, leaseGenerationLockPath]);
    docker(this.container, [
      "env",
      "PATH=/tmp/stub:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      `OT_ACTION_REQUEST_FILE=${requestPath}`,
      `OT_ACTION_RESULT_FILE=${resultPath}`,
      `OT_ACTION_SESSION_FILE=${sessionPath}`,
      `OT_LEASE_GENERATION_FENCE_FILE=${leaseGenerationFencePath}`,
      `OT_LEASE_GENERATION_LOCK_FILE=${leaseGenerationLockPath}`,
      "/opt/openthrottle/entrypoint.sh",
    ], { timeout: 240_000 });
    const outcome = await collect();
    if (outcome === null) throw new Error(`sandbox produced no result for ${request.attempt_id}`);
    return outcome;
  }

  #materializeInputSubject(request) {
    if (dockerStatus(this.container, [
      "git", "-C", SOURCE_REPOSITORY, "cat-file", "-e", `${request.input_subject}^{commit}`,
    ]).status === 0) return;
    const candidates = request.context.checkpoints.filter(
      (checkpoint) => checkpoint.output_subject === request.input_subject,
    );
    assert.equal(candidates.length, 1, "successor must carry one exact checkpoint for its input subject");
    const boundary = candidates[0];
    const pointer = boundary.payload?.blob;
    assert(pointer, "successor checkpoint must be content-addressed");
    const bytes = this.blobs.read(pointer);
    const inspected = inspectKernelCheckpointBundle({
      bytes,
      expected_commit: request.input_subject,
      shallow_boundary: boundary.input_subject,
      ...(request.input_subject === boundary.input_subject
        ? {}
        : { expected_parent: boundary.input_subject }),
      allowed_ref: /^refs\/openthrottle\/(?:checkpoints|integrations)\/[a-f0-9]{64}$/,
    });
    const localBundle = join(this.directory, `${pointer.digest}.input.bundle`);
    const containerBundle = `/transport/${pointer.digest}.input.bundle`;
    writeFileSync(localBundle, bytes, { mode: 0o400 });
    run("docker", ["cp", localBundle, `${this.container}:${containerBundle}`]);
    docker(this.container, [
      "git", "-C", SOURCE_REPOSITORY, "fetch", "--quiet", "--no-tags",
      containerBundle, `${inspected.ref}:refs/openthrottle/materialized/${pointer.digest}`,
    ]);
    assert.equal(
      docker(this.container, ["git", "-C", SOURCE_REPOSITORY, "rev-parse", request.input_subject]),
      request.input_subject,
    );
  }

  async #materializeArtifact(request, containerDirectory, descriptor) {
    const local = join(
      this.directory,
      `${safePathId(request.attempt_id, "attempt ID")}-${descriptor.file}`,
    );
    run("docker", ["cp", `${this.container}:${containerDirectory}/${descriptor.file}`, local]);
    const bytes = readFileSync(local);
    const inspected = inspectKernelCheckpointBundle({
      bytes,
      expected_commit: descriptor.commit,
      expected_tree: descriptor.tree,
      ...(request.repository_authority === "edit"
        ? {
            shallow_boundary: request.checkpoint_base_subject,
            ...(descriptor.commit === request.input_subject
              ? {}
              : { expected_parent: request.input_subject }),
          }
        : {}),
      allowed_ref: /^refs\/openthrottle\/checkpoints\/[a-f0-9]{64}$/,
    });
    assert.equal(inspected.ref, descriptor.ref);
    assert.equal(inspected.commit, descriptor.commit);
    assert.equal(inspected.tree, descriptor.tree);
    if (
      descriptor.ref.startsWith("refs/openthrottle/checkpoints/") &&
      descriptor.ref !== `refs/openthrottle/checkpoints/${request.request_hash}`
    ) throw new Error("checkpoint artifact changed its exact request ref");
    const token = this.blobs.put({
      bytes,
      encoding: "binary",
      media_type: descriptor.media_type,
      payload_schema: descriptor.payload_schema,
      expected_digest: descriptor.sha256,
    });
    return this.blobs.assertToken(token);
  }
}

function createKernelEnvironment(directory, source, pipelineId) {
  const release = loadKernelReleaseDefinitions({
    release_root: REPOSITORY_ROOT,
    generated_root: join(REPOSITORY_ROOT, "contracts/generated"),
  });
  const compilation = compilePipeline(release, source, pipelineId);
  const blobs = VolumeBlobStore.initialize(join(directory, "blobs"), `kernel-e2e-${pipelineId.replace("/", "-")}`);
  const databasePath = join(directory, "epoch.sqlite");
  const registrationId = `registration-${pipelineId.replace("/", "-")}`;
  const bootstrap = createFreshEpochBootstrap({
    schema: "openthrottle.fresh-epoch-bootstrap/v1",
    settings: [],
    repository_registrations: [{
      id: registrationId,
      control_provider: "linear",
      route_key: registrationId,
      linear_team_id: registrationId,
      linear_team_key: "E2E",
      github_repo: "owner/kernel-e2e",
      github_installation_id: 1,
      base_branch: "main",
      webhook_id: 1,
      runtime_snapshot: "kernel-e2e",
    }],
  });
  const releaseId = `kernel-e2e-release-${pipelineId.replace("/", "-")}`;
  const initialDb = initializeFreshEpochDatabase({
    database_path: databasePath,
    blob_store: blobs,
    release_id: releaseId,
    runtime_capability_digest: release.execution_policy.runtime_capability_digest,
    bootstrap,
  });
  const activate = (db, runtime) => {
    const store = new SqliteKernelStore({
      db,
      blob_store: blobs,
      manifest_resolver: new VerifiedKernelManifestResolver({
        compiler_environment: release.compiler_environment,
        trusted_platform_definitions: release.trusted_platform_definitions,
      }),
      payload_schemas: ordinaryKernelPayloadSchemas(),
      execution_policy: release.execution_policy,
    });
    const planner = new KernelStructuredSettlementPlanner({ store });
    const coordinator = new OrdinaryKernelCoordinator({
      store,
      definition_bundles: new VerifiedKernelDefinitionBundleResolver({
        bytes: store,
        trusted_platform_definitions: release.trusted_platform_definitions,
      }),
      runtime,
      runtime_sessions: new KernelRuntimeSessionService({ transitions: store }),
      settlement_planner: planner,
      attempt_lease_duration_ms: 5 * 60 * 1_000,
    });
    return { db, store, coordinator };
  };
  const reopen = () => openKernelEpoch({
    database_path: databasePath,
    blob_store_path: blobs.root,
    blob_store_id: blobs.store_id,
    release_id: releaseId,
    runtime_capability_digest: release.execution_policy.runtime_capability_digest,
    bootstrap_checksum: bootstrap.checksum,
  }).db;
  return { compilation, blobs, registrationId, initialDb, activate, reopen };
}

async function executeNext(coordinator, label, ordinal) {
  return coordinator.leaseAndExecuteNext({
    worker_id: `${label}-worker`,
    lease_id: `${label}-lease-${ordinal}`,
    expires_at: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
  });
}

function assertOneLaunch(container, attemptId) {
  assert.equal(
    lineCount(docker(container, ["cat", `/tmp/kernel-e2e-launches/${attemptId}`], { quiet: true })),
    1,
    `attempt ${attemptId} must launch exactly once`,
  );
}

async function ordinaryScenario() {
  const directory = join(root, "ordinary");
  mkdirSync(directory, { recursive: true });
  const fixture = createSourceRepository(directory, "ordinary");
  const container = startContainer(directory, fixture.repository);
  const environment = createKernelEnvironment(directory, fixture.source, "core/implement");
  const taskPrompt = "Implement the OPE-188 fixture, then review the accepted checkpoint.";
  const runId = `run-${"a".repeat(48)}`;
  const implementationAttemptId = `attempt-${"b".repeat(48)}`;
  const initialAttempt = createPendingStageAttempt({
    id: implementationAttemptId,
    pipeline_run_id: runId,
    stage_id: "implement",
    input_subject: fixture.source,
    bundle: environment.compilation.bundle.value,
    manifest: environment.compilation.manifest.value,
    action_inputs: { task_prompt: taskPrompt, context: { records: [], checkpoints: [] } },
  });
  const cursor = compileKernelCursor({
    stage_id: "implement",
    version: 0,
    attempts: [initialAttempt],
  });
  const runValue = createRun({
    id: runId,
    compilation: environment.compilation,
    source: fixture.source,
    cursor,
    attempts: [initialAttempt],
  });
  const firstRuntime = new DockerKernelRuntime({
    container,
    directory,
    blobs: environment.blobs,
  });
  let active = environment.activate(environment.initialDb, firstRuntime);
  seedRun({
    store: active.store,
    blobs: environment.blobs,
    registrationId: environment.registrationId,
    compilation: environment.compilation,
    run: runValue,
    attempts: [initialAttempt],
    taskPrompt,
  });

  const first = await executeNext(active.coordinator, "ordinary", 1);
  assert.deepEqual(first, {
    disposition: "settled",
    pipeline_run_id: runId,
    attempt_id: initialAttempt.id,
    stage_id: "implement",
    run_status: "running",
    next_stage_id: "review",
  });
  const implementation = active.db.prepare(`
    SELECT request_hash, output_subject, checkpoint_id, result_record_id FROM attempts WHERE id = ?
  `).get(initialAttempt.id);
  const persisted = active.db.prepare(`
    SELECT original_candidate_hash, normalized_candidate_hash, inline_payload
    FROM records WHERE id = ? AND kind = 'result'
  `).get(implementation.result_record_id);
  const payload = JSON.parse(persisted.inline_payload);
  assert.equal(payload.payload.summary, "Ordinary implementation completed.\nSupervisor transport verified.");
  assert.equal(payload.transformations[0]?.id, "string-array-to-newlines/v1");
  assert.notEqual(persisted.original_candidate_hash, persisted.normalized_candidate_hash);
  assert.match(implementation.output_subject, /^[a-f0-9]{40,64}$/);
  assertOneLaunch(container, initialAttempt.id);
  await assertPublicationPreflight({
    active,
    compilation: environment.compilation,
    blobs: environment.blobs,
    taskPrompt,
    implementation,
    runId,
    implementationAttemptId,
  });

  active.db.close();
  const restartedRuntime = new DockerKernelRuntime({
    container,
    directory,
    blobs: environment.blobs,
  });
  active = environment.activate(environment.reopen(), restartedRuntime);
  const recovered = await active.store.loadExactReductionView({
    pipeline_run_id: runId,
    attempt_id: initialAttempt.id,
    record_ids: [],
    checkpoint_ids: [],
  });
  assert.equal(recovered.current_attempt.status, "settled");
  assert.equal(recovered.current_attempt.request_hash, initialAttempt.request_hash);
  assert.equal(recovered.run.current_subject, implementation.output_subject);

  const second = await executeNext(active.coordinator, "ordinary", 2);
  assert.equal(second.disposition, "settled");
  assert.equal(second.stage_id, "review");
  assert.equal(second.next_stage_id, "simplify");
  assert.equal(restartedRuntime.requests[0].input_subject, implementation.output_subject);
  assert.equal(restartedRuntime.requests[0].change_boundary.output_subject, implementation.output_subject);
  assert.equal(
    active.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE stage_id = 'implement'").get().count,
    1,
  );
  assertOneLaunch(container, initialAttempt.id);
  assertOneLaunch(container, restartedRuntime.requests[0].attempt_id);
  active.db.close();
  process.stdout.write(
    "ordinary supervisor/sandbox normalization + restart + publication preflight proof passed\n",
  );
}

async function structuredScenario() {
  const directory = join(root, "structured");
  mkdirSync(directory, { recursive: true });
  const fixture = createSourceRepository(directory, "structured");
  const container = startContainer(directory, fixture.repository);
  const environment = createKernelEnvironment(directory, fixture.source, "core/structured");
  const taskPrompt = "Execute the sealed one-unit structured plan in dependency order.";
  const provisionBoundary = {
    ...createPendingStageAttempt({
      id: "structured-root",
      pipeline_run_id: "structured-run",
      stage_id: environment.compilation.manifest.value.entry_stage,
      input_subject: fixture.source,
      bundle: environment.compilation.bundle.value,
      manifest: environment.compilation.manifest.value,
      action_inputs: { task_prompt: taskPrompt, context: { records: [], checkpoints: [] } },
    }),
    // This proof begins immediately after the external Daytona provisioner has
    // emitted the unit frontier. Keep its parent boundary non-leaseable while
    // preserving the production foreign-key identity required by loop items.
    status: "work_complete",
  };
  const frontier = compileStructuredLoopFrontier({
    pipeline_run_id: "structured-run",
    parent_attempt_id: "structured-root",
    stage_id: "implement_unit",
    loop_id: "execution_plan.units",
    integration_stage_id: "integrate_unit",
    round: 0,
    input_subject: fixture.source,
    cursor_version: 0,
    completed_scope_keys: [],
    max_parallel: 1,
    members: [{
      id: "unit-a",
      depends_on: [],
      action_inputs: { task_prompt: taskPrompt, context: { records: [], checkpoints: [] } },
    }],
    completed_integrations: new Map(),
    bundle: environment.compilation.bundle.value,
    manifest: environment.compilation.manifest.value,
  });
  assert(frontier, "one unfinished structured unit must produce a frontier");
  const initialAttempt = frontier.attempts[0];
  const runValue = createRun({
    id: "structured-run",
    compilation: environment.compilation,
    source: fixture.source,
    cursor: frontier.cursor,
    attempts: [provisionBoundary, ...frontier.attempts],
  });
  const firstRuntime = new DockerKernelRuntime({
    container,
    directory,
    blobs: environment.blobs,
  });
  let active = environment.activate(environment.initialDb, firstRuntime);
  seedRun({
    store: active.store,
    blobs: environment.blobs,
    registrationId: environment.registrationId,
    compilation: environment.compilation,
    run: runValue,
    attempts: [provisionBoundary, ...frontier.attempts],
    taskPrompt,
  });
  const retiredBoundary = active.db.prepare(`
    UPDATE attempts SET status = 'superseded', version = version + 1
    WHERE id = ? AND pipeline_run_id = ? AND status = 'work_complete'
  `).run(provisionBoundary.id, "structured-run");
  assert.equal(retiredBoundary.changes, 1, "post-provision fixture boundary must retire exactly once");

  const first = await executeNext(active.coordinator, "structured", 1);
  assert.equal(first.disposition, "settled");
  assert.equal(first.stage_id, "implement_unit");
  assert.equal(first.next_stage_id, "simplify_unit");
  const implemented = active.db.prepare(`
    SELECT request_hash, output_subject FROM attempts WHERE id = ?
  `).get(initialAttempt.id);
  assert.match(implemented.output_subject, /^[a-f0-9]{40,64}$/);
  assertOneLaunch(container, initialAttempt.id);

  active.db.close();
  const restartedRuntime = new DockerKernelRuntime({
    container,
    directory,
    blobs: environment.blobs,
  });
  active = environment.activate(environment.reopen(), restartedRuntime);
  const beforeResume = await active.store.loadExactReductionView({
    pipeline_run_id: "structured-run",
    attempt_id: null,
    record_ids: [],
    checkpoint_ids: [],
  });
  assert.equal(beforeResume.run.cursor.stage_id, "simplify_unit");
  assert.deepEqual(beforeResume.run.cursor.frontier.map(({ scope }) => scope), [{
    kind: "loop_item",
    stage_id: "simplify_unit",
    parent_attempt_id: "structured-root",
    loop_id: "execution_plan.units",
    item_id: "unit-a",
    item_index: 0,
  }]);

  const second = await executeNext(active.coordinator, "structured", 2);
  assert.equal(second.disposition, "settled");
  assert.equal(second.stage_id, "simplify_unit");
  assert.equal(second.next_stage_id, "unit_test");
  const attempts = active.db.prepare(`
    SELECT id, stage_id, scope_kind, parent_attempt_id, scope_group_id,
           scope_item_id, status, request_hash, input_subject, output_subject
    FROM attempts WHERE pipeline_run_id = 'structured-run' ORDER BY created_at, id
  `).all();
  const implement = attempts.find(({ stage_id }) => stage_id === "implement_unit");
  const simplify = attempts.find(({ stage_id }) => stage_id === "simplify_unit");
  const unitTest = attempts.find(({ stage_id }) => stage_id === "unit_test");
  assert.equal(implement.status, "settled");
  assert.equal(simplify.status, "settled");
  assert.equal(unitTest.status, "pending");
  assert.equal(simplify.input_subject, implement.output_subject);
  assert.equal(unitTest.input_subject, simplify.output_subject);
  assert.notEqual(simplify.request_hash, implement.request_hash);
  for (const attempt of [implement, simplify, unitTest]) {
    assert.deepEqual({
      kind: attempt.scope_kind,
      parent: attempt.parent_attempt_id,
      group: attempt.scope_group_id,
      item: attempt.scope_item_id,
    }, {
      kind: "loop_item",
      parent: "structured-root",
      group: "execution_plan.units",
      item: "unit-a",
    });
  }
  assertOneLaunch(container, initialAttempt.id);
  assertOneLaunch(container, simplify.id);
  active.db.close();
  process.stdout.write("structured supervisor/sandbox frontier + restart proof passed\n");
}

try {
  for (const command of ["docker", "git", "node"]) {
    const probe = status(command, ["--version"]);
    if (probe.status !== 0) throw new Error(`missing kernel E2E dependency: ${command}`);
  }
  run("docker", ["image", "inspect", IMAGE], { quiet: true });
  await ordinaryScenario();
  await structuredScenario();
  process.stdout.write("supervisor-to-sandbox kernel E2E proof passed\n");
} finally {
  for (const container of containers.splice(0)) {
    status("docker", ["rm", "-f", container]);
  }
  rmSync(root, { recursive: true, force: true });
}
