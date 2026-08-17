#!/usr/bin/env node
// Deterministic stand-in for the `claude` CLI used only by
// sandbox/tests/structured-walking-skeleton.mjs. Bind-mounted over
// /usr/local/bin/claude inside the built image so execute-loop.mjs's real
// invocation path (gosu <action-principal> env ... claude --print ...) runs
// unmodified.
//
// A structured loop action carries every fence value a worker needs inside
// the "## Receipt Authority Contract" block of its prompt (see
// sandbox/runner/execute-loop.mjs loopPrompt()); this stub parses that block
// instead of reading any sealed file directly, exactly like a real agent
// would, so it proves the same agent-facing contract a real engine uses.
//
// It makes one deterministic worktree edit (implement/simplify/repair) and
// computes subject.post by running the installed `ot-subject-post` command,
// exactly as a real agent is instructed to by canonical block E of every
// worker SKILL.md, so the receipt it prints is byte-for-byte fence-correct
// without needing to guess.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractJsonBlock } from "/opt/openthrottle/runner/json-block.mjs";
import { claudeProjectSlug } from "/opt/openthrottle/runner/native-session-package.mjs";

// The one path an agent actually has: the installed command, not the module
// behind it. Importing `computeWorkspaceTreeOid` directly (as this stub used
// to) left Dockerfile's COPY/chmod/symlink of ot-subject-post untestable --
// all three could break and docker-smoke would still go green, with the first
// failure a live loop action whose `ot-subject-post` call `command not
// found`s. Exercising the binary makes those install lines load-bearing.
const OT_SUBJECT_POST = "/usr/local/bin/ot-subject-post";
const REVIEW_PERSONA_SKILLS = new Set([
  "correctness-dataflow",
  "tests-contracts",
  "reliability-adversarial",
  "agent-native-contracts",
  "security",
  "data-migration",
  "performance",
  "project-standards",
]);
const REVIEW_SUBACTION_SEPARATOR = ".review.";
// The host harness enables concurrent review fanout only for this scenario.
// Other scenarios deliberately retain the serial rollback path, so their
// first persona must not wait for a sibling that is intentionally unlaunched.
const CONCURRENT_REVIEW_PLAN_ID = "walking-skeleton-happy-path";

function assertSiblingHomeIsolation(contract, planContext) {
  const home = process.env.HOME;
  if (!home) throw new Error("stub review persona requires HOME for sibling isolation proof");
  const currentActionId = contract.action_attempt_id;
  const separatorIndex = currentActionId.lastIndexOf(REVIEW_SUBACTION_SEPARATOR);
  if (separatorIndex < 0) throw new Error("stub review persona has no review action prefix");
  const actionPrefix = currentActionId.slice(0, separatorIndex + REVIEW_SUBACTION_SEPARATOR.length);
  const sibling = planContext?.review_fanout?.personas?.find(
    (persona) => persona.id !== currentActionId.slice(separatorIndex + REVIEW_SUBACTION_SEPARATOR.length),
  );
  if (!sibling) throw new Error("stub review persona found no sibling in its sealed fanout plan");
  const siblingHome = join(dirname(dirname(home)), `${actionPrefix}${sibling.id}`, "home");
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline) {
    try {
      readdirSync(siblingHome);
      throw new Error(`concurrent review persona could read sibling home ${sibling.id}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("could read sibling home")) throw error;
      if (error?.code === "EACCES") return;
      if (error?.code !== "ENOENT") throw error;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error(`concurrent review sibling home ${sibling.id} was never materialized`);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// sealNativeSessionPackage (sandbox/runner/native-session-package.mjs) rejects
// a reported session id unless the profile's own durable transcript already
// contains a record carrying that same id -- exactly what a real `claude`
// process leaves under `$HOME/.claude/projects/`. Mirror that here, matching
// the fixture pattern in sandbox/tests/smoke.sh (write the transcript before
// printing the matching session_id), so the executor's seal step finds it.
// Real Claude Code files each transcript under a per-cwd slug directory
// (projects/<slug>/<sessionId>.jsonl), not flat in projects/. Mirroring the
// slug keeps the skeleton exercising collectNativeSessionPackage's recursive
// walk rather than only its top-level scan -- and, since resumeOrFail() below
// reads back the same location, keeps the skeleton honest about the executor
// having to relocate a restored transcript to this action's own cwd.
// claudeProjectSlug is imported from the runner rather than re-spelled here
// so the stub cannot drift from the convention production restores to.
function nativeSessionTranscriptDir() {
  const home = process.env.HOME;
  if (!home) throw new Error("stub agent requires HOME to materialize its session transcript");
  return join(home, ".claude", "projects", claudeProjectSlug(process.cwd()));
}

// The resume id the executor actually asked for, taken from argv exactly
// where the real CLI takes it (execute-loop.mjs loopAgentCommand appends
// `--resume <id>` only for invocation.mode === "resume").
function requestedResumeSessionId(argv) {
  const index = argv.indexOf("--resume");
  return index >= 0 ? argv[index + 1] ?? null : null;
}

// Real `claude --resume <id>` resolves the id ONLY under the project slug for
// its own cwd, and when it is not there it dies before turn one: exit 1, the
// bare message on stderr, and a subtype:"error_during_execution" result
// record on stdout (verified against the pinned CLI 2.1.201). The stub used
// to fabricate a transcript for whatever id it was handed, so a restore that
// materialized the session under some *other* cwd's slug still looked like a
// clean resume here -- which is why OPE-101 shipped through a green
// walking skeleton. Failing the same way the real engine does makes this
// harness prove the restore, not just the plumbing around it.
function resumeOrFail(sessionId) {
  if (existsSync(join(nativeSessionTranscriptDir(), `${sessionId}.jsonl`))) return;
  const message = `No conversation found with session ID: ${sessionId}`;
  process.stderr.write(`${message}\n`);
  process.stdout.write(`${JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    session_id: sessionId,
    total_cost_usd: 0,
    errors: [message],
  })}\n`);
  process.exit(1);
}

// Appends, never rewrites: a resumed action lands on the transcript the
// restore just relocated here, exactly as the real CLI would. Every real
// Claude record carries the cwd it was written in, and that field is the only
// evidence alignClaudeProjectDirectory has about where a session has actually
// lived. Recording it here is what gives a session resumed across successive
// worktrees the genuine multi-cwd history the restore has to read correctly
// (OPE-101 gen-9): without it the transcript looks placeless, the alignment's
// convention check has nothing to check, and a second consecutive move goes
// green in CI while failing live.
function writeNativeSessionTranscript(sessionId, contract) {
  const dir = nativeSessionTranscriptDir();
  mkdirSync(dir, { recursive: true });
  const record = {
    type: "user",
    sessionId,
    cwd: process.cwd(),
    message: {
      role: "user",
      content: `walking-skeleton stub agent session for ${contract.unit_id ?? "__final__"}/${contract.action_attempt_id}`,
    },
  };
  appendFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`);
}

// A real Claude Code process writes its own config, plugins, and shell state
// directly into the profile root itself at startup, not just into its
// projects/ transcript subtree (see filesystem-isolation.mjs's
// prepareAgentOwnedProfileRoot). OPE-101 was invisible to this skeleton
// because the stub only ever wrote into the one pre-created carve-out;
// mirror the top-level write here so the Docker walking skeleton pins the
// profile root staying agent-writable.
function writeProfileRootStartupFile() {
  const home = process.env.HOME;
  if (!home) throw new Error("stub agent requires HOME to materialize its profile root startup file");
  writeFileSync(
    join(home, ".claude", "ot-stub-agent-startup.json"),
    `${JSON.stringify({ startedAt: new Date().toISOString() })}\n`,
  );
}

function findControlMarker(planContext, name) {
  const text = JSON.stringify(planContext ?? {});
  const match = text.match(new RegExp(`${name}=([a-zA-Z_]+)`));
  return match ? match[1] : null;
}

function receiptFence(contract) {
  return {
    pipeline_instance_id: contract.pipeline_instance_id,
    graph_digest: contract.graph_digest,
    unit_id: contract.unit_id,
    attempt_id: contract.attempt_id,
    parent_run_id: contract.parent_run_id,
    action_attempt_id: contract.action_attempt_id,
    generation: contract.generation,
    native_session_id: contract.native_session_id,
    request_hash: contract.request_hash,
  };
}

function buildReceipt({ contract, type, result, subjectPost, payload, evidence }) {
  return {
    schema: "openthrottle.receipt/v1",
    type,
    assurance: contract.assurance ?? "semantic_attested",
    result,
    producer: contract.producer,
    subject: { base: contract.subject.base, pre: contract.subject.pre, post: subjectPost },
    fence: receiptFence(contract),
    evidence: evidence ?? ["walking-skeleton stub agent deterministic edit"],
    payload,
    issued_at: new Date().toISOString(),
  };
}

function priorCandidateSubject(priorEvidence) {
  const entry = (priorEvidence?.receipts ?? []).find((candidate) => candidate.role === "candidate");
  if (!entry) throw new Error("stub lead action found no candidate receipt in prior evidence");
  return JSON.parse(entry.receipt).subject.post;
}

// The acceptance and final-review gates (supervisor/src/pipeline/execution-gates.ts
// assertEvidenceBinding) require a lead/review receipt's evidence[] to contain the
// exact receipt hashes of the prior evidence it attests to. Echo them verbatim.
function priorReceiptHashes(priorEvidence) {
  const receipts = priorEvidence?.receipts ?? [];
  if (receipts.length === 0) throw new Error("stub gated action found no prior evidence receipts to bind");
  return receipts.map((entry) => entry.receiptHash);
}

function makeDeterministicEdit(cwd, contract) {
  appendFileSync(
    `${cwd}/WORK.md`,
    `- ${contract.unit_id}/${contract.action_attempt_id} touched by walking-skeleton stub agent\n`
  );
  // Run from the worktree root under this process's own sealed environment --
  // the GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY/
  // GIT_ALTERNATE_OBJECT_DIRECTORIES the executor exported for this action
  // (execute-loop.mjs) are already in process.env, and ot-subject-post reads
  // them exactly the way the executor's own post-run fence computation does.
  return execFileSync(OT_SUBJECT_POST, [], {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function main() {
  // stdin is drained before the resume fence so a refused resume never leaves
  // the executor's prompt write hitting a closed pipe -- an EPIPE would show
  // up as a different launch failure than the one being emulated.
  const prompt = readStdin();
  const resumeSessionId = requestedResumeSessionId(process.argv);
  if (resumeSessionId) resumeOrFail(resumeSessionId);
  const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";
  const skill = firstLine.replace(/^\//, "");
  const contract = extractJsonBlock(prompt, "## Receipt Authority Contract\n");
  const priorEvidence = extractJsonBlock(prompt, "## Prior Evidence\n");
  if (!contract) throw new Error("stub agent could not find the Receipt Authority Contract in its prompt");
  const cwd = process.cwd();

  // This is launch evidence, so write it before any skill-specific probe can
  // fail. Keeping it at the end of the turn made a failed isolation assertion
  // indistinguishable from an engine that never reached its action home.
  writeProfileRootStartupFile();

  let receipt;
  if (skill === "implement-unit" || skill === "repair-unit" || skill === "simplify-unit" || skill === "final-repair") {
    const subjectPost = makeDeterministicEdit(cwd, contract);
    receipt = buildReceipt({
      contract,
      type: "unit_completion",
      result: "success",
      subjectPost,
      payload: {
        summary: `walking-skeleton stub completed ${skill} for ${contract.unit_id}`,
        assumptions: [],
        decisions: [],
        issues: [],
        verification: ["walking-skeleton stub: deterministic edit applied"],
        downstream_context: [],
        requested_human_input: [],
      },
    });
  } else if (skill === "accept-unit") {
    const planContext = extractJsonBlock(prompt, "## Execution Plan Context\n");
    const forcedResult = findControlMarker(planContext, "STUB_LEAD_RESULT");
    const result = forcedResult ?? "accept";
    const acceptedSubject = priorCandidateSubject(priorEvidence);
    receipt = buildReceipt({
      contract,
      type: "unit_decision",
      result,
      subjectPost: acceptedSubject,
      evidence: priorReceiptHashes(priorEvidence),
      payload: {
        rationale: `walking-skeleton stub lead decision: ${result} for ${contract.unit_id}`,
        context_updates: [],
        ...(result === "accept" ? { accepted_subject: acceptedSubject } : {}),
      },
    });
  } else if (skill === "final-review") {
    receipt = buildReceipt({
      contract,
      type: "semantic_review",
      result: "success",
      subjectPost: contract.subject.pre,
      evidence: priorReceiptHashes(priorEvidence),
      payload: {
        summary: "walking-skeleton stub final review: no findings",
        findings: [],
      },
    });
  } else if (skill === "select-review-personas") {
    const planContext = extractJsonBlock(prompt, "## Execution Plan Context\n");
    const authority = planContext?.review_selector_authority;
    if (!authority || authority.subject !== contract.subject.pre) {
      throw new Error("stub review selector found no exact-subject authority");
    }
    const selectedIds = authority.required_persona_ids ?? authority.personas
      .filter((persona) => persona.mandatory)
      .map((persona) => persona.id);
    receipt = buildReceipt({
      contract,
      type: "semantic_review",
      result: "success",
      subjectPost: contract.subject.pre,
      payload: {
        summary: JSON.stringify({
          schema: "openthrottle.review-selector-recommendation/v1",
          subject: authority.subject,
          policy_digest: authority.policy_digest,
          personas: selectedIds.map((personaId) => ({
            persona_id: personaId,
            rationale: "walking-skeleton stub selected the sealed deterministic review roster",
          })),
        }),
        findings: [],
      },
    });
  } else if (REVIEW_PERSONA_SKILLS.has(skill)) {
    const planContext = extractJsonBlock(prompt, "## Execution Plan Context\n");
    if (planContext?.plan_id === CONCURRENT_REVIEW_PLAN_ID) {
      // Keep sibling processes overlapped long enough for the designated
      // concurrent scenario to prove each action-scoped CLI home is private.
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        skill === "correctness-dataflow" ? 100 : 400,
      );
      assertSiblingHomeIsolation(contract, planContext);
      // The faster sibling exits while the slower one is still alive. The last
      // action alone may restore the shared checkout; if the faster cleanup
      // exposes it early, this action-principal write succeeds and fails the scenario.
      try {
        writeFileSync("/home/agent/repo/.ot-review-shared-checkout-write-probe", `${skill}\n`);
        throw new Error("concurrent review persona could write the shared integration checkout");
      } catch (error) {
        if (error instanceof Error && error.message.includes("could write")) throw error;
        if (error?.code !== "EACCES" && error?.code !== "ENOENT") throw error;
      }
    }
    receipt = buildReceipt({
      contract,
      type: "semantic_review",
      result: "success",
      subjectPost: contract.subject.pre,
      payload: {
        summary: `walking-skeleton stub ${skill} review: no findings`,
        findings: [],
      },
    });
  } else if (skill === "validate-review-findings") {
    receipt = buildReceipt({
      contract,
      type: "semantic_review",
      result: "success",
      subjectPost: contract.subject.pre,
      payload: {
        summary: "walking-skeleton stub validator rejected every supplied blocker",
        findings: [],
      },
    });
  } else {
    throw new Error(`stub agent does not recognize skill invocation ${JSON.stringify(firstLine)}`);
  }

  // A sealed loop request bound to session_scope:"attempt" (implement/simplify)
  // rejects a reported session id that does not match the one it sealed into
  // the request; only mint a fresh id when the contract carries none (the
  // first action of an attempt).
  const sessionId = contract.native_session_id ?? `stub-${contract.action_attempt_id}`;
  writeNativeSessionTranscript(sessionId, contract);

  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "stub" })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0.01,
    result: receipt,
  })}\n`);
}

main();
