#!/usr/bin/env node
// Deterministic stand-in for the `claude` CLI used only by
// sandbox/tests/structured-walking-skeleton.mjs. Bind-mounted over
// /usr/local/bin/claude inside the built image so execute-loop.mjs's real
// invocation path (gosu agent env ... claude --print ...) runs unmodified.
//
// A structured loop action carries every fence value a worker needs inside
// the "## Receipt Authority Contract" block of its prompt (see
// sandbox/runner/execute-loop.mjs loopPrompt()); this stub parses that block
// instead of reading any sealed file directly, exactly like a real agent
// would, so it proves the same agent-facing contract a real engine uses.
//
// It makes one deterministic worktree edit (implement/simplify/repair) and
// computes subject.post with the executor's own tree-oid algorithm so the
// receipt it prints is byte-for-byte fence-correct without needing to guess.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeWorkspaceTreeOid } from "/opt/openthrottle/runner/repository-control.mjs";
import { extractJsonBlock } from "/opt/openthrottle/runner/json-block.mjs";

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
function nativeSessionTranscriptDir() {
  const home = process.env.HOME;
  if (!home) throw new Error("stub agent requires HOME to materialize its session transcript");
  return join(home, ".claude", "projects");
}

function writeNativeSessionTranscript(sessionId, contract) {
  const dir = nativeSessionTranscriptDir();
  mkdirSync(dir, { recursive: true });
  const record = {
    type: "user",
    sessionId,
    message: {
      role: "user",
      content: `walking-skeleton stub agent session for ${contract.unit_id ?? "__final__"}/${contract.action_attempt_id}`,
    },
  };
  appendFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`);
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
  return computeWorkspaceTreeOid(cwd);
}

function main() {
  const prompt = readStdin();
  const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";
  const skill = firstLine.replace(/^\//, "");
  const contract = extractJsonBlock(prompt, "## Receipt Authority Contract\n");
  const priorEvidence = extractJsonBlock(prompt, "## Prior Evidence\n");
  if (!contract) throw new Error("stub agent could not find the Receipt Authority Contract in its prompt");
  const cwd = process.cwd();

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
