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
        assert(prompt.includes(repositorySkill.reference) && prompt.includes(repositorySkill.packageDigest),
          `${agent}/${invocation} prompt lost package provenance`);
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
  execFileSync(process.execPath, [join(repoRoot, "sandbox", "tests", "structured-walking-skeleton.mjs"), image], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  const evidence = JSON.stringify({
    schema: "openthrottle.automatic-walking-skeleton-evidence/v1",
    docker: dockerEvidence,
    admission: gateEvidence,
    lifecycle: "reused structured walking skeleton",
  });
  assert(!/github_pat_|\bghp_|\bsk-|PRIVATE KEY|OT_STATUS_TOKEN\s*=/.test(evidence),
    "automatic walking-skeleton evidence contains sensitive material");
  process.stderr.write("[automatic-walking-skeleton] automatic admission + reused structured lifecycle PASSED\n");
}

main().catch((error) => {
  process.stderr.write(`[automatic-walking-skeleton] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
