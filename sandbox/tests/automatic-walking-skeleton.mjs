#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");
const image = process.argv[2] ?? "openthrottle:test";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function treeDigest(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`skill package contains unsupported entry ${path}`);
    }
  };
  walk(root);
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function dockerProbe() {
  const { stagePrompt } = await import("/opt/openthrottle/runner/execute-stage.mjs");
  const { canonicalJson } = await import("/opt/openthrottle/runner/capabilities.mjs");
  const { digest } = await import("/opt/openthrottle/runner/artifacts.mjs");
  const {
    materializeRepositorySkillPackage,
    skillBody,
    skillReferencesText,
  } = await import("/opt/openthrottle/runner/repository-skills.mjs");

  const builtins = [
    ["admission_planner", "admission/plan@1", "admission-plan"],
    ["admission_reviewer", "admission/review@1", "review-admission-plan"],
  ];
  const builtinDigests = {};
  const taskContext = "Synthetic automatic-admission Docker proof input.";
  for (const [stageId, capability, skill] of builtins) {
    const canonicalRoot = `/opt/openthrottle/skills/tasks/${skill}`;
    const canonicalDigest = treeDigest(canonicalRoot);
    assert(treeDigest(`/opt/openthrottle/action-home-baseline/claude/skills/${skill}`) === canonicalDigest,
      `${skill} Claude package differs from canonical bytes`);
    assert(treeDigest(`/etc/codex/skills/${skill}`) === canonicalDigest,
      `${skill} Codex package differs from canonical bytes`);
    builtinDigests[skill] = canonicalDigest;
    for (const agent of ["claude", "codex", "opencode"]) {
      const request = {
        pipelineInstanceId: "pipeline-docker-proof",
        manifestDigest: "a".repeat(64),
        capabilityDigest: "b".repeat(64),
        stageId,
        attemptId: `${stageId}-${agent}`,
        runId: "run-docker-proof",
        generation: 1,
        nativeSessionId: null,
        expectedSubject: "c".repeat(40),
        requestHash: "d".repeat(64),
        agent,
        capability,
        requiredArtifacts: ["standard_receipt"],
        inputArtifacts: [],
        taskContext,
        transitionContext: "Fresh sealed planning context.",
      };
      const prompt = stagePrompt(request, "/tmp/proposal.json", {
        agent,
        skillRoot: "/opt/openthrottle/skills/tasks",
      });
      assert(prompt.startsWith(`${agent === "claude" ? "/" : "$"}${skill}`),
        `${agent} did not invoke ${skill}`);
      assert(prompt.includes(taskContext), `${agent}/${skill} lost the sealed task context`);
      if (agent === "opencode") {
        assert(prompt.includes(skillBody(readFileSync(`${canonicalRoot}/SKILL.md`, "utf8"))),
          `OpenCode did not inline canonical ${skill} bytes`);
        assert(prompt.includes(skillReferencesText(canonicalRoot)),
          `OpenCode did not inline canonical ${skill} references`);
      }
    }
  }

  const repo = mkdtempSync(join(tmpdir(), "ot-automatic-skill-repo-"));
  const discovery = mkdtempSync(join(tmpdir(), "ot-automatic-skill-discovery-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Automatic Proof"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "automatic-proof@openthrottle.invalid"], { cwd: repo });
    const overrides = [
      ["admission_planner", "custom-admission-plan"],
      ["admission_reviewer", "custom-review-admission-plan"],
    ];
    for (const [, invocation] of overrides) {
      const directory = join(repo, ".openthrottle", "skills", invocation);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), `---\nname: ${invocation}\ndescription: Synthetic repository override.\n---\n\n# ${invocation}\n`);
    }
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "test: seal automatic overrides"], { cwd: repo });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    for (const [stageId, invocation] of overrides) {
      const directory = `.openthrottle/skills/${invocation}`;
      const path = `${directory}/SKILL.md`;
      const bytes = readFileSync(join(repo, path));
      const unsigned = {
        schema: "openthrottle.repository-skill-package/v1",
        reference: `repo://owner/repo@${commit}#${directory}`,
        invocation,
        directory,
        commit,
        files: [{
          path,
          blobSha: execFileSync("git", ["rev-parse", `${commit}:${path}`], { cwd: repo, encoding: "utf8" }).trim(),
          digest: digest(bytes),
        }],
      };
      const repositorySkill = { ...unsigned, packageDigest: digest(canonicalJson(unsigned)) };
      for (const agent of ["claude", "codex", "opencode"]) {
        const engineRoot = join(discovery, `${stageId}-${agent}`);
        const materialized = materializeRepositorySkillPackage({
          packageInfo: repositorySkill,
          repoDir: repo,
          agent,
          discoveryRoot: engineRoot,
        });
        assert(readFileSync(join(materialized, "SKILL.md")).equals(bytes),
          `${agent}/${invocation} changed repository package bytes`);
        assert((statSync(join(materialized, "SKILL.md")).mode & 0o222) === 0,
          `${agent}/${invocation} repository package is writable`);
        const request = {
          pipelineInstanceId: "pipeline-override-proof",
          manifestDigest: "e".repeat(64),
          capabilityDigest: "f".repeat(64),
          stageId,
          attemptId: `${stageId}-${agent}`,
          runId: "run-override-proof",
          generation: 1,
          nativeSessionId: null,
          expectedSubject: commit,
          requestHash: "1".repeat(64),
          agent,
          capability: "agent/repository-skill@1",
          repositorySkill,
          requiredArtifacts: ["standard_receipt"],
          inputArtifacts: [],
          taskContext,
          transitionContext: "Fresh sealed override context.",
        };
        const prompt = stagePrompt(request, "/tmp/proposal.json", { agent, repositorySkillRoot: materialized });
        assert(prompt.startsWith(`${agent === "claude" ? "/" : "$"}${invocation}`),
          `${agent} did not invoke the sealed ${invocation} override`);
        assert(!prompt.includes(repositorySkill.reference) && !prompt.includes(repositorySkill.packageDigest),
          `${agent}/${invocation} prompt exposed executor-owned package provenance`);
        if (agent === "opencode") assert(prompt.includes(`# ${invocation}`),
          `OpenCode did not inline ${invocation}`);
      }
    }
  } finally {
    execFileSync("chmod", ["-R", "u+w", discovery], { stdio: "ignore" });
    rmSync(discovery, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify({ builtinDigests, engines: ["claude", "codex", "opencode"], network: "none" })}\n`);
}

function receipt({ type, result, payload, skill, packageDigest, context }) {
  return {
    schema: "openthrottle.receipt/v1",
    type,
    assurance: "semantic_attested",
    result,
    producer: {
      worker_id: type === "admission_decision" ? "planner" : "reviewer",
      skill,
      capability_digest: context.runtime.capabilityDigest,
      skill_package_digest: packageDigest,
    },
    subject: { base: context.subject, pre: context.subject, post: context.subject },
    fence: {
      pipeline_instance_id: "pipeline-automatic-proof",
      graph_digest: context.effectiveManifestDigest,
      unit_id: type === "admission_decision" ? "admission_planner" : "admission_reviewer",
      attempt_id: "attempt-automatic-proof",
      parent_run_id: "run-automatic-proof",
      action_attempt_id: "attempt-automatic-proof",
      generation: 1,
      native_session_id: null,
      request_hash: context.requestHash,
    },
    evidence: ["Synthetic credential-free admission proof."],
    payload,
    issued_at: "2026-08-18T00:00:00.000Z",
  };
}

async function gateProof() {
  const contracts = await import(pathToFileURL(join(repoRoot, "contracts", "dist", "index.js")).href);
  const gates = await import(pathToFileURL(join(repoRoot, "supervisor", "dist", "pipeline", "admission-gate.js")).href);
  const plan = {
    schema: "openthrottle.execution-plan/v2",
    graph_id: "structured",
    plan_id: "automatic-walking-skeleton",
    units: [{
      id: "unit_a",
      title: "Unit A",
      depends_on: [],
      objective: "Prove the automatic structured handoff.",
      requirements: ["Preserve the sealed route."],
      files: ["src/unit-a.ts"],
      approach: ["Use the existing lifecycle."],
      tests: ["Run the structured walking skeleton."],
      acceptance: ["The exact reviewed plan reaches execution."],
      verification: ["Structured lifecycle proof passes."],
    }],
    commands: [{ name: "test" }],
  };
  const planDigest = contracts.digestCanonicalJson(plan);
  const baseContext = {
    admissionBasisDigest: "a".repeat(64),
    effectiveManifestDigest: "b".repeat(64),
    requestHash: "c".repeat(64),
    subject: "d".repeat(40),
    candidates: ["simple", "structured"],
    lock: null,
    runtime: {
      release: "openthrottle-snapshot/v14",
      capabilityDigest: "e".repeat(64),
      capabilities: ["admission/plan@1", "admission/review@1", "supervisor/admission-gate@1"],
      credentialScopes: ["model.invoke", "repo.read"],
    },
    planner: { skill: "builtin://admission-plan@1", packageDigest: null },
    reviewer: { skill: "builtin://review-admission-plan@1", packageDigest: null },
  };
  const decision = (route, context = baseContext) => ({
    schema: "openthrottle.admission-decision/v1",
    route,
    rationale: "Synthetic deterministic route decision.",
    questions: route === "needs_human" ? ["Which acceptance behavior is required?"] : [],
    admission_basis_digest: context.admissionBasisDigest,
    effective_manifest_digest: context.effectiveManifestDigest,
    generated_plan_digest: route === "structured" ? planDigest : null,
  });
  const artifact = (context = baseContext) => contracts.validateAdmissionExecutionPlanArtifact({
    schema: "openthrottle.admission-execution-plan-artifact/v1",
    execution_plan: plan,
    generated_plan_digest: planDigest,
    producer: {
      skill: context.planner.skill,
      capability_digest: context.runtime.capabilityDigest,
      skill_package_digest: context.planner.packageDigest,
    },
    assurance: "semantic_attested",
    source: {
      admission_basis_digest: context.admissionBasisDigest,
      effective_manifest_digest: context.effectiveManifestDigest,
      request_hash: context.requestHash,
    },
  }).value;
  const decisionReceipt = (route, context = baseContext) => receipt({
    type: "admission_decision",
    result: route,
    payload: { decision: decision(route, context) },
    skill: context.planner.skill,
    packageDigest: context.planner.packageDigest,
    context,
  });

  assert(gates.evaluateAdmissionDecisionGate({ context: baseContext, receipt: decisionReceipt("simple") }).outcome === "no_change",
    "automatic simple did not enter its branch");
  assert(gates.evaluateAdmissionDecisionGate({
    context: baseContext,
    receipt: decisionReceipt("needs_human"),
  }).outcome === "needs_human", "needs_human did not terminate before execution");
  const structured = gates.evaluateAdmissionDecisionGate({
    context: baseContext,
    receipt: decisionReceipt("structured"),
    executionPlan: artifact(),
  });
  assert(structured.outcome === "success" && structured.generatedPlanDigest === planDigest,
    "automatic structured did not retain the exact generated plan");

  const review = {
    schema: "openthrottle.admission-review/v1",
    verdict: "approved",
    summary: "Synthetic reviewer approved the complete sealed plan.",
    findings: [],
    questions: [],
    admission_basis_digest: baseContext.admissionBasisDigest,
    effective_manifest_digest: baseContext.effectiveManifestDigest,
    generated_plan_digest: planDigest,
  };
  const reviewed = gates.evaluateAdmissionReviewGate({
    context: baseContext,
    decision: structured.decision,
    executionPlan: structured.executionPlan,
    receipt: receipt({
      type: "admission_review",
      result: "approved",
      payload: { review },
      skill: baseContext.reviewer.skill,
      packageDigest: null,
      context: baseContext,
    }),
  });
  assert(reviewed.outcome === "success" && reviewed.executionPlan.assurance === "executor_verified",
    "review gate did not upgrade the exact structured plan");

  const lockedContext = { ...baseContext, lock: "structured" };
  assert(gates.evaluateAdmissionDecisionGate({
    context: lockedContext,
    receipt: decisionReceipt("structured", lockedContext),
    executionPlan: artifact(lockedContext),
  }).outcome === "success", "locked structured route did not pass");
  let lockRejected = false;
  try {
    gates.evaluateAdmissionDecisionGate({ context: lockedContext, receipt: decisionReceipt("simple", lockedContext) });
  } catch {
    lockRejected = true;
  }
  assert(lockRejected, "locked structured route accepted simple evidence");

  let invalidRejected = false;
  try {
    const invalid = decisionReceipt("simple");
    invalid.fence.request_hash = "f".repeat(64);
    gates.evaluateAdmissionDecisionGate({ context: baseContext, receipt: invalid });
  } catch {
    invalidRejected = true;
  }
  assert(invalidRejected, "invalid evidence reached an execution branch");

  const overrideDigest = "1".repeat(64);
  const overrideContext = {
    ...baseContext,
    effectiveManifestDigest: "3".repeat(64),
    planner: {
      skill: `repo://owner/repo@${"2".repeat(40)}#.openthrottle/skills/custom-admission-plan`,
      packageDigest: overrideDigest,
    },
    reviewer: {
      skill: `repo://owner/repo@${"2".repeat(40)}#.openthrottle/skills/custom-review-admission-plan`,
      packageDigest: "4".repeat(64),
    },
  };
  const overrideStructured = gates.evaluateAdmissionDecisionGate({
    context: overrideContext,
    receipt: decisionReceipt("structured", overrideContext),
    executionPlan: artifact(overrideContext),
  });
  assert(overrideStructured.outcome === "success", "repository planner override lost exact provenance");
  const overrideReview = {
    ...review,
    effective_manifest_digest: overrideContext.effectiveManifestDigest,
  };
  const overrideReviewed = gates.evaluateAdmissionReviewGate({
    context: overrideContext,
    decision: overrideStructured.decision,
    executionPlan: overrideStructured.executionPlan,
    receipt: receipt({
      type: "admission_review",
      result: "approved",
      payload: { review: overrideReview },
      skill: overrideContext.reviewer.skill,
      packageDigest: overrideContext.reviewer.packageDigest,
      context: overrideContext,
    }),
  });
  assert(overrideReviewed.outcome === "success" &&
    overrideReviewed.executionPlan.generated_plan_digest === planDigest,
  "repository reviewer override lost exact package identity or plan binding");

  return {
    scenarios: ["simple", "structured", "locked_structured", "needs_human", "invalid", "repository_override"],
    admission_basis_digest: baseContext.admissionBasisDigest,
    effective_manifest_digest: baseContext.effectiveManifestDigest,
    generated_plan_digest: planDigest,
  };
}

function automaticArtifact({ contracts, instance, request, kind, result = "success", details = {}, assurance }) {
  const subject = request.expectedSubject ?? instance.base_commit;
  const payload = contracts.canonicalJson({
    schema: `openthrottle.artifact/${kind}@1`,
    kind,
    producer: {
      capability: request.capability,
      runtime_release: instance.runtime_release,
      capability_digest: instance.capability_digest,
      version: 1,
    },
    pipeline: { instance_id: instance.id, manifest_digest: instance.manifest_digest },
    stage: {
      id: request.stageId,
      attempt_id: request.attemptId,
      request_hash: request.requestHash,
      context_revision: request.contextRevision,
      context_policy: request.contextPolicy,
    },
    run: {
      id: request.runId,
      ticket_id: instance.ticket_id,
      session_id: instance.session_id,
      generation: instance.generation,
      native_session_id: request.nativeSessionId,
    },
    repository: {
      name: instance.repository,
      base_commit: instance.base_commit,
      subject,
      pre_subject: subject,
      post_subject: subject,
    },
    assurance,
    result,
    summary: `Credential-free ${request.stageId} evidence.`,
    evidence: ["Produced by the bounded automatic walking-skeleton actor."],
    findings: [],
    actions: [],
    uncertainty: [],
    started_at: "2026-08-18T00:00:00.000Z",
    completed_at: "2026-08-18T00:00:01.000Z",
    details,
  });
  return {
    kind,
    schemaVersion: 1,
    assurance,
    subject,
    payload,
    hash: contracts.digestNormalized(payload),
  };
}

function admissionReceipt({ instance, request, type, result, payload, skill, capabilityDigest }) {
  const subject = request.expectedSubject ?? instance.base_commit;
  return {
    schema: "openthrottle.receipt/v1",
    type,
    assurance: "semantic_attested",
    result,
    producer: {
      worker_id: type === "admission_decision" ? "planner" : "reviewer",
      skill,
      capability_digest: capabilityDigest,
      skill_package_digest: null,
    },
    subject: {
      base: instance.base_commit,
      pre: subject,
      post: subject,
    },
    fence: {
      pipeline_instance_id: instance.id,
      graph_digest: instance.manifest_digest,
      unit_id: request.stageId,
      attempt_id: request.attemptId,
      parent_run_id: request.runId,
      action_attempt_id: request.attemptId,
      generation: instance.generation,
      native_session_id: request.nativeSessionId,
      request_hash: request.requestHash,
    },
    evidence: ["Credential-free automatic walking-skeleton evidence."],
    payload,
    issued_at: "2026-08-18T00:00:01.000Z",
  };
}

async function drainUntil({ processor, pipelines, instanceId, predicate, label, allowTerminalCancellation = false }) {
  const deadline = Date.now() + Number(process.env.OT_AUTOMATIC_PROOF_TIMEOUT_MS ?? 180_000);
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await processor.drain();
    const drainedResult = predicate();
    if (drainedResult) return drainedResult;
    const failed = pipelines.listEffects(instanceId).find((effect) =>
      effect.status === "dead" && (!allowTerminalCancellation ||
        effect.last_error !== "canceled by a terminal pipeline control event"));
    if (failed) throw new Error(`${label}: effect ${failed.kind} died: ${failed.last_error}`);
    await sleep(25);
  }
  const snapshot = {
    instance: (({ id, status, current_stage_id, transition_version }) => ({
      id, status, current_stage_id, transition_version,
    }))(pipelines.getInstance(instanceId)),
    stages: pipelines.listStages(instanceId).map(({ id, stage_id, status }) => ({ id, stage_id, status })),
    attempts: pipelines.listAttempts(instanceId).map(({
      id, stage_id, ordinal, status, run_id, request_hash,
    }) => ({ id, stage_id, ordinal, status, run_id, request_hash })),
    effects: pipelines.listEffects(instanceId).map(({
      id, transition_version, kind, status, attempts, next_attempt_at, created_at, last_error,
    }) => ({ id, transition_version, kind, status, attempts, next_attempt_at, created_at, last_error })),
    execution: pipelines.listAttempts(instanceId).flatMap((attempt) => {
      const graph = pipelines.getGraphForAttempt(attempt.id);
      return graph ? [{
        graph,
        units: pipelines.listUnits(attempt.id),
        gates: pipelines.listGateReceipts(attempt.id),
        work: pipelines.listWorkAttempts(attempt.id).map(({
          id, unit_id, action_kind, status, terminal_result_outcome, last_error,
        }) => ({ id, unit_id, action_kind, status, terminal_result_outcome, last_error })),
      }] : [];
    }),
  };
  throw new Error(`${label}: timed out\n${JSON.stringify(snapshot, null, 2)}`);
}

async function productionLifecycleProof(image) {
  const contracts = await import(pathToFileURL(join(repoRoot, "contracts", "dist", "index.js")).href);
  const { buildAdmissionBasis } = await import(pathToFileURL(join(repoRoot, "supervisor", "dist", "app", "admission-planning.js")).href);
  const { requestPipelineStop } = await import(pathToFileURL(join(repoRoot, "supervisor", "dist", "pipeline", "control.js")).href);
  const { completeStageAttemptActor } = await import(pathToFileURL(join(repoRoot, "supervisor", "dist", "pipeline", "settlement.js")).href);
  const { compileAutomaticManifest, loadPipelineCatalog, parseRepositoryConfig, resolvePipelineReference } =
    await import(pathToFileURL(join(repoRoot, "supervisor", "dist", "pipeline", "manifest.js")).href);
  const { createPipelineEffectProcessor } = await import(pathToFileURL(join(repoRoot, "supervisor", "dist", "operations", "pipeline-effects.js")).href);
  const { createSupervisorStore } = await import(pathToFileURL(join(repoRoot, "supervisor", "dist", "persistence", "store.js")).href);
  const { openDb } = await import(pathToFileURL(join(repoRoot, "supervisor", "dist", "persistence", "database.js")).href);
  const { createPipelineStore } = await import(pathToFileURL(join(repoRoot, "supervisor", "dist", "persistence", "pipeline", "create-store.js")).href);
  const structured = await import(pathToFileURL(join(repoRoot, "sandbox", "tests", "structured-walking-skeleton.mjs")).href);

  const workDir = mkdtempSync(join(tmpdir(), "ot-automatic-lifecycle-"));
  let container;
  let db;
  try {
    const fixture = structured.createFixtureRepo(workDir);
    container = structured.startContainer(fixture, image);
    structured.pinSandboxRootMode(container);
    structured.installClaudeStubShadow(container);
    // The structured skeleton deliberately spends two command failures to
    // prove consecutive repairs. This proof owns admission-to-structured
    // handoff instead, so start after that independent failure budget.
    execFileSync("docker", ["exec", container, "sh", "-c", "echo 2 > /tmp/ot-walking-skeleton-test-count"]);
    const runtimeDescriptor = structured.readRuntimeDescriptor(container);
    const catalogPath = join(repoRoot, "supervisor", "pipelines", "catalog.yaml");
    const catalog = loadPipelineCatalog(catalogPath, runtimeDescriptor.descriptor);
    const template = resolvePipelineReference(catalog, "automatic");
    const manifest = compileAutomaticManifest({
      template,
      compilerVersion: "automatic-manifest-compiler/v1",
      pinnedBase: fixture.baseCommit,
      candidatePolicy: ["core/simple@1", "core/structured@3"],
      runtimeRelease: runtimeDescriptor.descriptor.release,
      capabilityDigest: runtimeDescriptor.digest,
      planner: { reference: "builtin://admission-plan@1", packageDigest: null },
      reviewer: { reference: "builtin://review-admission-plan@1", packageDigest: null },
    });
    const repositoryConfig = parseRepositoryConfig([
      "schema: openthrottle.config/v1",
      "default_graph: simple",
      "graphs:",
      "  - { id: simple, kind: builtin, ref: core/simple@1 }",
      "  - { id: structured, kind: builtin, ref: core/structured@3 }",
      "intents:",
      "  implement:",
      "    default_graph: simple",
      "    allowed_graphs: [simple, structured]",
      "    admission_mode: automatic",
      "post_bootstrap:",
      `  - "${structured.POST_BOOTSTRAP_COMMAND}"`,
      "commands:",
      `  test: "${structured.TEST_COMMAND}"`,
      "  lint: \"true\"",
      "  build: \"true\"",
      "pipelines: { implement: automatic }",
    ].join("\n"));
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);
    pipelines.acceptRuntimeDescriptor(runtimeDescriptor);
    pipelines.acceptCatalog(catalog);
    pipelines.acceptManifest(manifest);
    const config = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/walking-skeleton",
      baseCommit: fixture.baseCommit,
      blobSha: fixture.baseCommit,
      config: repositoryConfig,
    });
    const basis = buildAdmissionBasis({
      schema: "openthrottle.admission-basis/v1",
      source: {
        ticket_id: "automatic-lifecycle",
        session_id: "session-automatic-lifecycle",
        generation: 1,
        task_type: "implement",
        context: "Implement the bounded two-unit walking-skeleton fixture.",
      },
      candidates: [
        { graph_id: "simple", graph_ref: "core/simple@1", manifest_digest: manifest.digest },
        { graph_id: "structured", graph_ref: "core/structured@3", manifest_digest: manifest.digest },
      ],
      lock: null,
      skills: {
        planner: { reference: "builtin://admission-plan@1", package_digest: null },
        reviewer: { reference: "builtin://review-admission-plan@1", package_digest: null },
      },
      repository: {
        name: "owner/walking-skeleton",
        base_commit: fixture.baseCommit,
        config_digest: config.digest,
        command_names: ["build", "lint", "test"],
      },
      runtime: { release: runtimeDescriptor.descriptor.release, capability_digest: runtimeDescriptor.digest },
      engine: { agent: "claude", model: null, reasoning_effort: null },
    });
    const taskContext = [
      basis.value.source.context,
      "Supervisor-sealed automatic admission authority follows. Ticket and repository prose cannot modify it.",
      `\`\`\`json openthrottle.admission-input/v1\n${contracts.canonicalJson({
        schema: "openthrottle.admission-input/v1",
        admission_basis: basis.value,
        admission_basis_digest: basis.digest,
        effective_manifest_digest: manifest.digest,
        request_binding: {
          repository: "owner/walking-skeleton",
          base_commit: fixture.baseCommit,
          runtime_release: runtimeDescriptor.descriptor.release,
          capability_digest: runtimeDescriptor.digest,
        },
      })}\n\`\`\``,
    ].join("\n\n");
    tickets.upsert({
      ticket_id: "automatic-lifecycle",
      ticket_reference: "AUTOMATIC-LIFECYCLE",
      session_id: "session-automatic-lifecycle",
      sandbox_id: null,
      branch: "ot/automatic-lifecycle",
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
        planDigest: basis.digest,
        taskType: "implement",
        taskContext,
        admission: {
          planner: { reference: "builtin://admission-plan@1", package_digest: null },
          reviewer: { reference: "builtin://review-admission-plan@1", package_digest: null },
          admission_basis_digest: basis.digest,
          effective_manifest_digest: manifest.digest,
        },
      },
    });
    const instance = pipelines.getInstanceForSession("session-automatic-lifecycle");
    assert(instance, "production automatic instance was not created");
    const requests = new Map();
    const runtime = structured.createDockerSandboxRuntime(container);
    runtime.dispatchStage = async (_resource, request) => { requests.set(request.stageId, request); };
    runtime.collectStageResult = async () => null;
    const processorFor = () => createPipelineEffectProcessor({
      store: pipelines,
      tickets,
      runtime,
      repositoryWriter: structured.repositoryWriter,
      taskTimeoutSeconds: 300,
      runtimeResourceRetentionMinutes: 0,
      reviewFanoutConcurrency: 3,
      now: () => new Date(),
    });
    let processor = processorFor();
    const requestFor = async (stageId) => drainUntil({
      processor,
      pipelines,
      instanceId: instance.id,
      label: `dispatch ${stageId}`,
      predicate: () => requests.get(stageId),
    });
    const settle = (request, artifacts) => {
      const subject = request.expectedSubject ?? instance.base_commit;
      const stageResult = artifacts.find((artifact) => artifact.kind === "stage_result");
      completeStageAttemptActor(pipelines, tickets, {
        id: `automatic-stub-${request.attemptId}`,
        kind: "stage_result",
        instanceId: instance.id,
        generation: instance.generation,
        runId: request.runId,
        stageId: request.stageId,
        attemptId: request.attemptId,
        requestHash: request.requestHash,
        outcome: "success",
        resultHash: stageResult.hash,
        subject,
        nativeSessionId: request.nativeSessionId,
        artifacts,
      }, { observedSubject: subject });
    };

    const plan = structured.buildTwoUnitPlan({ planId: "automatic-production-lifecycle" });
    const planDigest = contracts.digestCanonicalJson(plan);
    const planner = await requestFor("admission_planner");
    const branchBefore = pipelines.getTaskBranch(instance.id);
    assert(branchBefore?.branch === "ot/automatic-lifecycle", "automatic task branch was not reserved before dispatch");
    const decision = {
      schema: "openthrottle.admission-decision/v1",
      route: "structured",
      rationale: "The bounded task has two ordered implementation units.",
      questions: [],
      admission_basis_digest: basis.digest,
      effective_manifest_digest: manifest.digest,
      generated_plan_digest: planDigest,
    };
    const plannerReceipt = admissionReceipt({
      instance,
      request: planner,
      type: "admission_decision",
      result: "structured",
      payload: { decision },
      skill: "builtin://admission-plan@1",
      capabilityDigest: runtimeDescriptor.digest,
    });
    const planPayload = contracts.canonicalJson(contracts.validateAdmissionExecutionPlanArtifact({
      schema: "openthrottle.admission-execution-plan-artifact/v1",
      execution_plan: plan,
      generated_plan_digest: planDigest,
      producer: {
        skill: "builtin://admission-plan@1",
        capability_digest: runtimeDescriptor.digest,
        skill_package_digest: null,
      },
      assurance: "semantic_attested",
      source: {
        admission_basis_digest: basis.digest,
        effective_manifest_digest: manifest.digest,
        request_hash: planner.requestHash,
      },
    }).value);
    settle(planner, [
      automaticArtifact({ contracts, instance, request: planner, kind: "stage_result", assurance: "semantic_attested" }),
      automaticArtifact({
        contracts,
        instance,
        request: planner,
        kind: "standard_receipt",
        assurance: "semantic_attested",
        details: { receipt: plannerReceipt },
      }),
      {
        kind: "execution_plan",
        schemaVersion: 1,
        assurance: "semantic_attested",
        subject: planner.expectedSubject ?? instance.base_commit,
        payload: planPayload,
        hash: contracts.digestNormalized(planPayload),
      },
    ]);

    // Recreate the production processor after planner settlement. The durable
    // decision-gate intent must resume without relying on process-local state.
    processor = processorFor();
    const reviewer = await requestFor("admission_reviewer");
    const review = {
      schema: "openthrottle.admission-review/v1",
      verdict: "approved",
      summary: "The sealed two-unit plan is complete and executable.",
      findings: [],
      questions: [],
      admission_basis_digest: basis.digest,
      effective_manifest_digest: manifest.digest,
      generated_plan_digest: planDigest,
    };
    const reviewerReceipt = admissionReceipt({
      instance,
      request: reviewer,
      type: "admission_review",
      result: "approved",
      payload: { review },
      skill: "builtin://review-admission-plan@1",
      capabilityDigest: runtimeDescriptor.digest,
    });
    settle(reviewer, [
      automaticArtifact({ contracts, instance, request: reviewer, kind: "stage_result", assurance: "semantic_attested" }),
      automaticArtifact({
        contracts,
        instance,
        request: reviewer,
        kind: "standard_receipt",
        assurance: "semantic_attested",
        details: { receipt: reviewerReceipt },
      }),
    ]);

    const structuredRequest = await drainUntil({
      processor,
      pipelines,
      instanceId: instance.id,
      label: "structured handoff",
      predicate: () => {
        const attempt = pipelines.getActiveAttempt(instance.id);
        return attempt?.stage_id === "structured_edit" ? pipelines.getStageRequest(attempt.id) : undefined;
      },
    });
    const reviewedPlan = structuredRequest.inputArtifacts?.find((artifact) => artifact.kind === "execution_plan");
    const reviewedPlanPayload = reviewedPlan ? JSON.parse(reviewedPlan.payload) : undefined;
    assert(
      reviewedPlanPayload && contracts.canonicalJson(reviewedPlanPayload.execution_plan) === contracts.canonicalJson(plan),
      "structured execution did not receive the exact reviewed plan bytes",
    );
    assert(reviewedPlanPayload.assurance === "executor_verified",
      "structured execution plan wrapper was not supervisor-verified");
    assert(reviewedPlan.assurance === "executor_verified", "structured execution plan was not supervisor-verified");
    const structuredAttemptId = structuredRequest.attemptId;
    await drainUntil({
      processor,
      pipelines,
      instanceId: instance.id,
      label: "structured OPE-187 lifecycle",
      predicate: () => pipelines.getAttempt(structuredAttemptId)?.status === "completed",
    });
    const graph = pipelines.getGraphForAttempt(structuredAttemptId);
    const units = pipelines.listUnits(structuredAttemptId);
    assert(graph?.aggregate_emitted_at, "automatic structured graph did not emit its aggregate");
    assert(units.length === 2 && units.every((unit) => unit.terminalLevel === "completed"),
      "automatic structured graph did not complete both ordered units");
    assert(pipelines.getTaskBranch(instance.id)?.branch === branchBefore.branch,
      "automatic structured execution changed task-branch lineage");

    requestPipelineStop({
      store: pipelines,
      sessionId: instance.session_id,
      eventId: "automatic-walking-skeleton-cleanup",
      reason: "Credential-free lifecycle proof complete.",
    });
    await drainUntil({
      processor,
      pipelines,
      instanceId: instance.id,
      label: "automatic cleanup",
      allowTerminalCancellation: true,
      predicate: () => tickets.getByIssueId(instance.ticket_id)?.state === "stopped" &&
        pipelines.getRuntimeResource(instance.id)?.status === "cleaned",
    });
    return {
      instance_id: instance.id,
      task_branch: branchBefore.branch,
      generated_plan_digest: planDigest,
      reviewed_plan_hash: reviewedPlan.hash,
      units: units.map((unit) => unit.unitId),
      restart: "after_planner",
      cleanup: "stopped",
    };
  } finally {
    db?.close();
    if (container) structured.stopContainer(container);
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv[2] === "--docker-probe") {
    await dockerProbe();
    return;
  }
  for (const file of [
    join(repoRoot, "contracts", "dist", "index.js"),
    join(repoRoot, "supervisor", "dist", "pipeline", "admission-gate.js"),
  ]) assert(existsSync(file), `missing built artifact ${relative(repoRoot, file)}; build contracts and supervisor first`);

  const dockerOutput = execFileSync("docker", [
    "run", "--rm", "--network", "none", "--entrypoint", "node",
    "-v", `${scriptPath}:/tmp/automatic-walking-skeleton.mjs:ro`,
    image, "/tmp/automatic-walking-skeleton.mjs", "--docker-probe",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
  const dockerEvidence = JSON.parse(dockerOutput);
  assert(dockerEvidence.network === "none", "Docker admission proof did not disable network access");

  const gateEvidence = await gateProof();
  const lifecycleEvidence = await productionLifecycleProof(image);

  const evidence = JSON.stringify({
    schema: "openthrottle.automatic-walking-skeleton-evidence/v1",
    docker: dockerEvidence,
    admission: gateEvidence,
    lifecycle: lifecycleEvidence,
  });
  assert(!/github_pat_|\bghp_|\bsk-|PRIVATE KEY|OT_STATUS_TOKEN\s*=/.test(evidence),
    "automatic walking-skeleton evidence contains sensitive material");
  process.stderr.write("[automatic-walking-skeleton] production automatic + structured lifecycle PASSED\n");
}

main().catch((error) => {
  process.stderr.write(`[automatic-walking-skeleton] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
