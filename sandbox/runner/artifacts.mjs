import { createHash } from "node:crypto";
import { CAPABILITY_CONTRACTS, canonicalJson } from "./capabilities.mjs";

export const STAGE_OUTCOMES = Object.freeze([
  "success",
  "no_change",
  "semantic_repair_required",
  "retryable_infrastructure_failure",
  "needs_human",
  "canceled",
  "superseded",
  "failure",
]);
const PROPOSAL_OUTCOMES = STAGE_OUTCOMES.filter(
  (outcome) => outcome !== "canceled" && outcome !== "superseded",
);

const STAGE_PROPOSAL_SCHEMA = "openthrottle.stage-proposal/v1";
const STANDARD_RECEIPT_SCHEMA = "openthrottle.receipt/v1";

const PROPOSAL_KEYS = new Set([
  "schema",
  "suggested_outcome",
  "summary",
  "evidence",
  "findings",
  "actions",
  "uncertainty",
]);
const STANDARD_RECEIPT_KEYS = new Set([
  "schema",
  "type",
  "assurance",
  "result",
  "producer",
  "subject",
  "fence",
  "evidence",
  "payload",
  "issued_at",
]);
// Mirrors contracts/src/receipts.ts RECEIPT_RESULTS_BY_TYPE; exported so
// tests/contracts-mirror.test.mjs can pin the two against each other.
export const STANDARD_RECEIPT_RESULTS = Object.freeze({
  unit_completion: ["success", "failure", "needs_human", "exited"],
  unit_decision: ["accept", "revise", "context_update", "needs_human"],
  semantic_review: ["success", "no_change", "semantic_repair_required", "failure", "needs_human"],
  command_result: ["success", "failure", "not_configured"],
  candidate_evidence: ["success", "failure"],
  integration_evidence: ["success", "failure"],
  publish_subject: ["success", "failure"],
  provider_evidence: ["success", "semantic_repair_required", "failure"],
  human_approval: ["approved", "rejected", "needs_human"],
  tune_analysis: ["success", "failure", "needs_human"],
  tune_proposal: ["success", "no_change", "failure", "needs_human"],
  admission_decision: ["simple", "structured", "needs_human"],
  admission_review: ["approved", "rejected", "needs_human"],
});
const STANDARD_RECEIPT_STAGE_OUTCOMES = Object.freeze({
  accept: "success",
  approved: "success",
  context_update: "no_change",
  exited: "needs_human",
  failure: "failure",
  needs_human: "needs_human",
  no_change: "no_change",
  not_configured: "success",
  rejected: "failure",
  revise: "semantic_repair_required",
  semantic_repair_required: "semantic_repair_required",
  success: "success",
});
const SEMANTIC_RECEIPTS = new Set([
  "unit_completion",
  "unit_decision",
  "semantic_review",
  "tune_analysis",
  "tune_proposal",
  "admission_decision",
  "admission_review",
]);
const SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SUBJECT = /^[a-f0-9]{40,64}$/;
const SKILL_REFERENCE = /^(?:builtin:\/\/[a-z][a-z0-9]*(?:[._/@-][a-z0-9]+)*@\d+|repo:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}#(?:(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+\/)*(?!\.{1,2}$)[A-Za-z0-9._-]+)$/;
const NATIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_ARTIFACT_PAYLOAD_BYTES = 12 * 1024;
const MAX_TUNE_ARTIFACT_PAYLOAD_BYTES = 768 * 1024;
export const ADMISSION_EXECUTION_PLAN_ARTIFACT_MAX_BYTES = 320 * 1024;
// Kept byte-identical with contracts/src/receipts.ts. Sixteen command receipts
// can enter one bounded prior-evidence envelope, so these diagnostics are byte
// bounded independently of the outer artifact limit.
export const COMMAND_DIAGNOSTIC_TAIL_MAX_BYTES = 512;
const SECRET_PATTERNS = [
  /gh[opsu]_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /sk-[A-Za-z0-9_-]+/g,
  /lin_(?:api|oauth)_[A-Za-z0-9_]+/g,
];
const BEARER_CANDIDATE = /(?:\b|(?<=\\[nrt]))Bearer(?:\s|\\+[nrt])+([A-Za-z0-9._~+/\-]+={0,2})/gi;
const BEARER_PROSE = /^(?:authentication|authorization|credentials?|tokens?)(?:-based)?\.*$/i;

function skipAuthorizationSeparators(text, from) {
  let cursor = from;
  while (cursor >= 0) {
    if (/\s/.test(text[cursor]) || text[cursor] === "\\") {
      cursor -= 1;
      continue;
    }
    if (/[nrt]/.test(text[cursor]) && cursor > 0 && text[cursor - 1] === "\\") {
      cursor -= 2;
      while (cursor >= 0 && text[cursor] === "\\") cursor -= 1;
      continue;
    }
    break;
  }
  return cursor;
}

function hasAuthorizationContext(text, offset) {
  let cursor = skipAuthorizationSeparators(text, offset - 1);
  if (text[cursor] === '"' || text[cursor] === "'") {
    cursor = skipAuthorizationSeparators(text, cursor - 1);
  }
  if (text[cursor] !== ":") return false;
  cursor = skipAuthorizationSeparators(text, cursor - 1);
  if (text[cursor] === '"' || text[cursor] === "'") {
    cursor = skipAuthorizationSeparators(text, cursor - 1);
  }
  const start = cursor - "Authorization".length + 1;
  return start >= 0 && text.slice(start, cursor + 1).toLowerCase() === "authorization";
}

function isSecretBearerCandidate(text, candidate, offset) {
  if (hasAuthorizationContext(text, offset)) return true;
  return !BEARER_PROSE.test(candidate);
}

function redactBearerSecrets(text) {
  return text.replace(BEARER_CANDIDATE, (match, candidate, offset) =>
    isSecretBearerCandidate(text, candidate, offset) ? "[REDACTED]" : match);
}

export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

// One complete markdown code fence and nothing else: an opening ``` with an
// optional info string on its own line, a closing ``` on the final line.
const OUTER_CODE_FENCE = /^```[^\n]*\n([\s\S]*)\n```$/;

// Every complete markdown code fence in the text, in order: an opening ``` with
// an optional info string, a closing ``` alone on a later line. A fence left
// unterminated at the end of the text yields nothing, because its extent is
// unknown.
function fencedBlocks(text) {
  const blocks = [];
  let open = null;
  for (const line of text.split("\n")) {
    if (open === null) {
      if (/^[ \t]{0,3}```/.test(line)) open = [];
    } else if (/^[ \t]{0,3}```[ \t]*$/.test(line)) {
      blocks.push(open.join("\n"));
      open = null;
    } else {
      open.push(line);
    }
  }
  return blocks;
}

// The qualifying blocks, in order. A block qualifies only when it parses as
// JSON *and* the caller's predicate recognizes it, so prose, diffs, and log
// excerpts inside fences are simply not candidates.
function qualifyingFencedBlocks(text, qualifies) {
  const found = [];
  for (const block of fencedBlocks(text)) {
    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    if (qualifies(parsed)) found.push(parsed);
  }
  return found;
}

function shapedObject(value, schema) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && value.schema === schema;
}

// The qualifiers are deliberately narrower than the validators: a candidate
// must carry the exact schema id and a value from the closed vocabulary that
// gives the document its kind. Anything that passes is unambiguously an
// attempt at this document, whatever else is wrong with it -- and a document
// that passes here still faces the full validator (and, for a loop receipt,
// assertLoopReceiptFence) before it can be believed.
export function isStandardReceiptShaped(value) {
  return shapedObject(value, STANDARD_RECEIPT_SCHEMA) &&
    Object.hasOwn(STANDARD_RECEIPT_RESULTS, String(value.type));
}

export function isStageProposalShaped(value) {
  return shapedObject(value, STAGE_PROPOSAL_SCHEMA) &&
    PROPOSAL_OUTCOMES.includes(value.suggested_outcome);
}

// Agent-authored JSON reaches us as text the model typed, and models fence JSON
// by reflex and narrate around it by reflex. Three tiers, each strictly
// narrower than guessing:
//
//   1. The text is the JSON (unchanged, the only tier before OPE-101).
//   2. The text is exactly one complete fence and nothing else: peel it and
//      parse the interior (generation 6, PR #152). The value is identical to
//      the unfenced case, so every downstream check is untouched.
//   3. The text is prose *around* fenced blocks, and exactly one of those
//      blocks is recognizably the document the caller asked for (generation 8,
//      below). Callers opt in by passing `qualifies`.
//
// Tier 3 needs a qualifier because "some JSON is in here somewhere" is not a
// decision an executor may make. Un-fenced JSON buried in prose never
// qualifies at all: its extent is a guess.
export function parseAgentJson(raw, { qualifies, label = "receipt" } = {}) {
  const text = String(raw).trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    const fenced = OUTER_CODE_FENCE.exec(text);
    if (fenced) return JSON.parse(fenced[1]);
    if (!qualifies) throw error;
    // Narration around the payload. OPE-101 generation 8 wrote "Good -- only
    // the test file is modified. Now composing the receipt." and then a fully
    // valid fenced receipt; generation 6 had already proved that a text
    // prohibition does not stop a model from narrating. When exactly one
    // fenced block is recognizably this document, the surrounding text is
    // narrative and the block is the answer -- there is nothing to guess.
    // Zero or several and we still refuse: the whole point is that the
    // executor never picks between competing candidates.
    const candidates = qualifyingFencedBlocks(text, qualifies);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) throw error;
    const ambiguous = new Error(
      `${candidates.length} ${label}-like blocks found; refusing to guess which one is the ${label}`,
    );
    ambiguous.ambiguousAgentJson = true;
    throw ambiguous;
  }
}

export function sanitizeArtifactText(value, env = process.env) {
  let output = String(value ?? "");
  const secrets = Object.entries(env)
    .filter(([name, secret]) => /(TOKEN|KEY|SECRET|PASSWORD|AUTH_JSON)/i.test(name) && secret)
    .flatMap(([, secret]) => {
      const values = [String(secret)];
      try {
        const visit = (child) => {
          if (typeof child === "string" && child.length >= 8) values.push(child);
          else if (Array.isArray(child)) child.forEach(visit);
          else if (child && typeof child === "object") Object.values(child).forEach(visit);
        };
        visit(JSON.parse(String(secret)));
      } catch {
        // Scalar secret.
      }
      return values;
    })
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) output = output.split(secret).join("[REDACTED]");
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, "[REDACTED]");
  return redactBearerSecrets(output)
    .replace(/(?:\b|(?<=\\[nrt]))Bearer(?:\s|\\+[nrt])+\[REDACTED\]/gi, "[REDACTED]");
}

export function commandDiagnosticTail(value, env = process.env) {
  const sanitized = sanitizeArtifactText(value, env).trim();
  if (!sanitized) return undefined;
  const bytes = Buffer.from(sanitized, "utf8");
  if (bytes.length <= COMMAND_DIAGNOSTIC_TAIL_MAX_BYTES) return sanitized;
  let start = bytes.length - COMMAND_DIAGNOSTIC_TAIL_MAX_BYTES;
  // Do not begin inside a multi-byte UTF-8 code point. Moving forward can
  // only shrink the tail, preserving the hard byte ceiling.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function boundedText(value, label, max, env) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const sanitized = sanitizeArtifactText(value, env).trim();
  if (!sanitized) throw new Error(`${label} must not be empty`);
  return sanitized.slice(0, max);
}

function boundedDiagnosticTail(value, label, env) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const tail = sanitizeArtifactText(value, env).trim();
  if (!tail) throw new Error(`${label} must not be empty`);
  if (Buffer.byteLength(tail, "utf8") > COMMAND_DIAGNOSTIC_TAIL_MAX_BYTES) {
    throw new Error(`${label} must contain at most ${COMMAND_DIAGNOSTIC_TAIL_MAX_BYTES} UTF-8 bytes`);
  }
  return tail;
}

function boundedStrings(value, label, maxItems, maxLength, env) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} must contain at most ${maxItems} items`);
  }
  return value.map((item, index) => boundedText(item, `${label}[${index}]`, maxLength, env));
}

function objectWithKnownKeys(value, label, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`${label} has unknown field ${unknown}`);
  return value;
}

function exactPayload(value, label, keys, env, maxBytes = 32 * 1024) {
  return boundedPlainObject(objectWithKnownKeys(value, label, keys), label, env, maxBytes);
}

function boundedContextRecords(value, label, env) {
  if (!Array.isArray(value) || value.length > 32) throw new Error(`${label} must contain at most 32 items`);
  return value.map((item, index) => {
    const record = exactObject(item, `${label}[${index}]`, new Set(["unit_id", "summary"]));
    return {
      unit_id: boundedText(record.unit_id, `${label}[${index}].unit_id`, 120, env),
      summary: boundedText(record.summary, `${label}[${index}].summary`, 2_000, env),
    };
  });
}

function boundedFindings(value, label, env) {
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${label} must contain at most 64 items`);
  return value.map((item, index) => {
    const finding = objectWithKnownKeys(item, `${label}[${index}]`, new Set(["severity", "message", "path"]));
    if (!SEVERITIES.has(finding.severity)) throw new Error(`${label}[${index}].severity is invalid`);
    return {
      severity: finding.severity,
      message: boundedText(finding.message, `${label}[${index}].message`, 2_000, env),
      ...(finding.path === undefined ? {} : { path: boundedText(finding.path, `${label}[${index}].path`, 300, env) }),
    };
  });
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is invalid`);
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid`);
  return value;
}

function patternedText(value, label, pattern, env, max = 1_000) {
  const text = boundedText(value, label, max, env);
  if (!pattern.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function receiptPayload(type, value, env) {
  if (type === "unit_completion") {
    const payload = exactPayload(value, "standard receipt payload", new Set([
      "summary", "assumptions", "decisions", "issues", "verification", "downstream_context", "requested_human_input",
    ]), env);
    return {
      summary: boundedText(payload.summary, "standard receipt payload summary", 4_000, env),
      assumptions: boundedStrings(payload.assumptions, "standard receipt payload assumptions", 32, 1_000, env),
      decisions: boundedStrings(payload.decisions, "standard receipt payload decisions", 32, 1_000, env),
      issues: boundedStrings(payload.issues, "standard receipt payload issues", 32, 1_000, env),
      verification: boundedStrings(payload.verification, "standard receipt payload verification", 32, 1_000, env),
      downstream_context: boundedContextRecords(payload.downstream_context, "standard receipt payload downstream_context", env),
      requested_human_input: boundedStrings(payload.requested_human_input, "standard receipt payload requested_human_input", 16, 1_000, env),
    };
  }
  if (type === "unit_decision") {
    const payload = exactPayload(value, "standard receipt payload", new Set(["rationale", "revision_request", "context_updates", "accepted_subject"]), env);
    return {
      rationale: boundedText(payload.rationale, "standard receipt payload rationale", 4_000, env),
      ...(payload.revision_request === undefined ? {} : {
        revision_request: boundedText(payload.revision_request, "standard receipt payload revision_request", 4_000, env),
      }),
      context_updates: boundedContextRecords(payload.context_updates, "standard receipt payload context_updates", env),
      ...(payload.accepted_subject === undefined ? {} : {
        accepted_subject: patternedText(payload.accepted_subject, "standard receipt payload accepted_subject", GIT_SUBJECT, env, 64),
      }),
    };
  }
  if (type === "semantic_review") {
    const payload = exactPayload(value, "standard receipt payload", new Set(["summary", "findings"]), env);
    return {
      summary: boundedText(payload.summary, "standard receipt payload summary", 4_000, env),
      findings: boundedFindings(payload.findings, "standard receipt payload findings", env),
    };
  }
  if (type === "admission_decision") {
    const payload = exactPayload(value, "standard receipt payload", new Set(["decision"]), env);
    const decision = exactObject(payload.decision, "standard receipt payload decision", new Set([
      "schema", "route", "rationale", "questions", "admission_basis_digest",
      "effective_manifest_digest", "generated_plan_digest",
    ]));
    if (decision.schema !== "openthrottle.admission-decision/v1") {
      throw new Error("standard receipt payload decision has an invalid schema");
    }
    if (!["simple", "structured", "needs_human"].includes(decision.route)) {
      throw new Error("standard receipt payload decision route is invalid");
    }
    const generatedPlanDigest = nullable(decision.generated_plan_digest, (entry) =>
      patternedText(entry, "standard receipt payload decision generated_plan_digest", SHA256, env, 64));
    if ((decision.route === "structured") !== (generatedPlanDigest !== null)) {
      throw new Error("standard receipt payload decision generated_plan_digest is inconsistent with route");
    }
    const questions = boundedStrings(decision.questions, "standard receipt payload decision questions", 16, 1_000, env);
    if ((decision.route === "needs_human") !== (questions.length > 0)) {
      throw new Error("standard receipt payload decision questions are inconsistent with route");
    }
    return { decision: {
      schema: decision.schema,
      route: decision.route,
      rationale: boundedText(decision.rationale, "standard receipt payload decision rationale", 4_000, env),
      questions,
      admission_basis_digest: patternedText(decision.admission_basis_digest, "standard receipt payload decision admission_basis_digest", SHA256, env, 64),
      effective_manifest_digest: patternedText(decision.effective_manifest_digest, "standard receipt payload decision effective_manifest_digest", SHA256, env, 64),
      generated_plan_digest: generatedPlanDigest,
    } };
  }
  if (type === "admission_review") {
    const payload = exactPayload(value, "standard receipt payload", new Set(["review"]), env);
    const review = exactObject(payload.review, "standard receipt payload review", new Set([
      "schema", "verdict", "summary", "findings", "questions", "admission_basis_digest",
      "effective_manifest_digest", "generated_plan_digest",
    ]));
    if (review.schema !== "openthrottle.admission-review/v1") {
      throw new Error("standard receipt payload review has an invalid schema");
    }
    if (!["approved", "rejected", "needs_human"].includes(review.verdict)) {
      throw new Error("standard receipt payload review verdict is invalid");
    }
    const findings = boundedFindings(review.findings, "standard receipt payload review findings", env);
    const questions = boundedStrings(review.questions, "standard receipt payload review questions", 16, 1_000, env);
    if (review.verdict === "approved" && (findings.length > 0 || questions.length > 0)) {
      throw new Error("approved admission review cannot carry findings or questions");
    }
    if (review.verdict === "rejected" && findings.length === 0) {
      throw new Error("rejected admission review requires findings");
    }
    if ((review.verdict === "needs_human") !== (questions.length > 0)) {
      throw new Error("admission review questions are inconsistent with verdict");
    }
    return { review: {
      schema: review.schema,
      verdict: review.verdict,
      summary: boundedText(review.summary, "standard receipt payload review summary", 4_000, env),
      findings,
      questions,
      admission_basis_digest: patternedText(review.admission_basis_digest, "standard receipt payload review admission_basis_digest", SHA256, env, 64),
      effective_manifest_digest: patternedText(review.effective_manifest_digest, "standard receipt payload review effective_manifest_digest", SHA256, env, 64),
      generated_plan_digest: patternedText(review.generated_plan_digest, "standard receipt payload review generated_plan_digest", SHA256, env, 64),
    } };
  }
  if (type === "tune_analysis" || type === "tune_proposal") {
    const contractField = type === "tune_analysis" ? "analysis" : "proposal";
    const expectedSchema = type === "tune_analysis"
      ? "openthrottle.tune-analysis/v1"
      : "openthrottle.tune-proposal/v1";
    const payload = exactPayload(
      value,
      "standard receipt payload",
      new Set(["summary", contractField]),
      env,
      type === "tune_analysis" ? 256 * 1024 : 640 * 1024
    );
    if (!payload[contractField] || typeof payload[contractField] !== "object" || Array.isArray(payload[contractField])) {
      throw new Error(`standard receipt payload ${contractField} must be an object`);
    }
    if (payload[contractField].schema !== expectedSchema) {
      throw new Error(`standard receipt payload ${contractField} has an invalid schema`);
    }
    return {
      summary: boundedText(payload.summary, "standard receipt payload summary", 4_000, env),
      [contractField]: payload[contractField],
    };
  }
  if (type === "command_result") {
    const payload = exactPayload(value, "standard receipt payload", new Set([
      "command", "exit_code", "summary", "stdout_digest", "stderr_digest", "stdout_tail", "stderr_tail",
    ]), env);
    return {
      command: boundedText(payload.command, "standard receipt payload command", 80, env),
      exit_code: integer(payload.exit_code, "standard receipt payload exit_code", 0, 255),
      summary: boundedText(payload.summary, "standard receipt payload summary", 4_000, env),
      ...(payload.stdout_digest === undefined ? {} : { stdout_digest: patternedText(payload.stdout_digest, "standard receipt payload stdout_digest", SHA256, env, 64) }),
      ...(payload.stderr_digest === undefined ? {} : { stderr_digest: patternedText(payload.stderr_digest, "standard receipt payload stderr_digest", SHA256, env, 64) }),
      ...(payload.stdout_tail === undefined ? {} : { stdout_tail: boundedDiagnosticTail(payload.stdout_tail, "standard receipt payload stdout_tail", env) }),
      ...(payload.stderr_tail === undefined ? {} : { stderr_tail: boundedDiagnosticTail(payload.stderr_tail, "standard receipt payload stderr_tail", env) }),
    };
  }
  if (type === "candidate_evidence" || type === "integration_evidence") {
    const payload = exactPayload(value, "standard receipt payload", new Set(["tree", "diff_digest", "changed_paths", "clean"]), env);
    return {
      tree: patternedText(payload.tree, "standard receipt payload tree", GIT_SUBJECT, env, 64),
      diff_digest: patternedText(payload.diff_digest, "standard receipt payload diff_digest", SHA256, env, 64),
      changed_paths: boundedStrings(payload.changed_paths, "standard receipt payload changed_paths", 512, 1_000, env),
      clean: boolean(payload.clean, "standard receipt payload clean"),
    };
  }
  if (type === "publish_subject") {
    const payload = exactPayload(value, "standard receipt payload", new Set(["commit", "tree", "pr_url"]), env);
    return {
      commit: patternedText(payload.commit, "standard receipt payload commit", GIT_SUBJECT, env, 64),
      tree: patternedText(payload.tree, "standard receipt payload tree", GIT_SUBJECT, env, 64),
      pr_url: boundedText(payload.pr_url, "standard receipt payload pr_url", 2_000, env),
    };
  }
  if (type === "provider_evidence") {
    const payload = exactPayload(value, "standard receipt payload", new Set(["review_url", "check_run_url", "summary"]), env);
    return {
      ...(payload.review_url === undefined ? {} : { review_url: boundedText(payload.review_url, "standard receipt payload review_url", 2_000, env) }),
      ...(payload.check_run_url === undefined ? {} : { check_run_url: boundedText(payload.check_run_url, "standard receipt payload check_run_url", 2_000, env) }),
      summary: boundedText(payload.summary, "standard receipt payload summary", 4_000, env),
    };
  }
  const payload = exactPayload(value, "standard receipt payload", new Set(["approver", "rationale"]), env);
  return {
    approver: boundedText(payload.approver, "standard receipt payload approver", 160, env),
    rationale: boundedText(payload.rationale, "standard receipt payload rationale", 4_000, env),
  };
}

export function validateSemanticProposal(value, env = process.env) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stage proposal must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!PROPOSAL_KEYS.has(key)) throw new Error(`stage proposal cannot set authoritative field ${key}`);
  }
  if (value.schema !== STAGE_PROPOSAL_SCHEMA) {
    throw new Error("stage proposal has an invalid schema");
  }
  if (!PROPOSAL_OUTCOMES.includes(value.suggested_outcome)) {
    throw new Error("stage proposal has an invalid suggested_outcome");
  }
  const findings = value.findings ?? [];
  if (!Array.isArray(findings) || findings.length > 50) {
    throw new Error("stage proposal findings must contain at most 50 items");
  }
  const normalizedFindings = findings.map((finding, index) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error(`findings[${index}] must be an object`);
    }
    const keys = Object.keys(finding);
    if (keys.some((key) => !["severity", "code", "summary", "path", "line"].includes(key))) {
      throw new Error(`findings[${index}] has an unknown field`);
    }
    if (!SEVERITIES.has(finding.severity)) throw new Error(`findings[${index}] has an invalid severity`);
    if (finding.line !== undefined && (!Number.isSafeInteger(finding.line) || finding.line < 1)) {
      throw new Error(`findings[${index}].line is invalid`);
    }
    return {
      severity: finding.severity,
      code: boundedText(finding.code, `findings[${index}].code`, 80, env),
      summary: boundedText(finding.summary, `findings[${index}].summary`, 400, env),
      ...(finding.path === undefined
        ? {}
        : { path: boundedText(finding.path, `findings[${index}].path`, 200, env) }),
      ...(finding.line === undefined ? {} : { line: finding.line }),
    };
  });
  return {
    schema: STAGE_PROPOSAL_SCHEMA,
    suggested_outcome: value.suggested_outcome,
    summary: boundedText(value.summary, "summary", 1_000, env),
    evidence: boundedStrings(value.evidence, "evidence", 50, 300, env).slice(0, 10),
    // Blocking findings are retained ahead of advisory findings so bounding
    // can never turn a P0/P1 result into apparent success.
    findings: [
      ...normalizedFindings.filter((finding) => finding.severity === "P0" || finding.severity === "P1"),
      ...normalizedFindings.filter((finding) => finding.severity !== "P0" && finding.severity !== "P1"),
    ].slice(0, 10),
    actions: boundedStrings(value.actions, "actions", 50, 300, env).slice(0, 10),
    uncertainty: boundedStrings(value.uncertainty, "uncertainty", 20, 300, env).slice(0, 6),
  };
}

function exactObject(value, label, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  const missing = [...keys].find((key) => !(key in value));
  if (unknown) throw new Error(`${label} has unknown field ${unknown}`);
  if (missing) throw new Error(`${label} is missing field ${missing}`);
  return value;
}

function boundedPlainObject(value, label, env, maxBytes = 32 * 1024) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const sanitized = sanitizeArtifactText(JSON.stringify(value), env);
  if (Buffer.byteLength(sanitized, "utf8") > maxBytes) throw new Error(`${label} exceeds the receipt payload limit`);
  return JSON.parse(sanitized);
}

function nullable(value, parse) {
  return value === null ? null : parse(value);
}

export function validateStandardReceipt(value, env = process.env) {
  const input = exactObject(value, "standard receipt", STANDARD_RECEIPT_KEYS);
  if (input.schema !== STANDARD_RECEIPT_SCHEMA) throw new Error("standard receipt has an invalid schema");
  const results = STANDARD_RECEIPT_RESULTS[input.type];
  if (!results) throw new Error("standard receipt has an invalid type");
  if (!["semantic_attested", "semantic_corroborated", "executor_verified", "provider_verified", "human_approved"].includes(input.assurance)) {
    throw new Error("standard receipt has an invalid assurance");
  }
  if (SEMANTIC_RECEIPTS.has(input.type) && ["executor_verified", "provider_verified", "human_approved"].includes(input.assurance)) {
    throw new Error("semantic standard receipt cannot claim executor, provider, or human assurance");
  }
  if (!results.includes(input.result)) throw new Error("standard receipt has an invalid result");
  const producer = exactObject(input.producer, "standard receipt producer", new Set([
    "worker_id", "skill", "capability_digest", "skill_package_digest",
  ]));
  const subject = exactObject(input.subject, "standard receipt subject", new Set(["base", "pre", "post"]));
  const fence = exactObject(input.fence, "standard receipt fence", new Set([
    "pipeline_instance_id", "graph_digest", "unit_id", "attempt_id",
    "parent_run_id", "action_attempt_id", "generation", "native_session_id", "request_hash",
  ]));
  if (!SHA256.test(producer.capability_digest)) throw new Error("standard receipt capability digest is invalid");
  const skillPackageDigest = nullable(producer.skill_package_digest, (entry) => {
    if (typeof entry !== "string" || !SHA256.test(entry)) throw new Error("standard receipt skill package digest is invalid");
    return entry;
  });
  if (![subject.base, subject.pre, subject.post].every((entry) => typeof entry === "string" && GIT_SUBJECT.test(entry))) {
    throw new Error("standard receipt subject is invalid");
  }
  if (![fence.graph_digest, fence.request_hash].every((entry) => typeof entry === "string" && SHA256.test(entry))) {
    throw new Error("standard receipt fence digest is invalid");
  }
  integer(fence.generation, "standard receipt fence generation", 1, 1_000_000);
  const nativeSessionId = nullable(fence.native_session_id, (entry) =>
    patternedText(entry, "standard receipt fence native session", NATIVE_SESSION_ID, env, 200));
  const evidence = boundedStrings(input.evidence, "standard receipt evidence", 32, 1_000, env);
  const issuedAt = boundedText(input.issued_at, "standard receipt issued_at", 64, env);
  if (Number.isNaN(Date.parse(issuedAt))) throw new Error("standard receipt issued_at is invalid");
  const payload = receiptPayload(input.type, input.payload, env);
  if (input.type === "command_result" && input.result !== "failure"
      && (payload.stdout_tail !== undefined || payload.stderr_tail !== undefined)) {
    throw new Error("standard receipt payload diagnostic tails are only valid for failed command receipts");
  }
  return {
    schema: STANDARD_RECEIPT_SCHEMA,
    type: input.type,
    assurance: input.assurance,
    result: input.result,
    producer: {
      worker_id: boundedText(producer.worker_id, "standard receipt producer worker", 120, env),
      skill: patternedText(producer.skill, "standard receipt producer skill", SKILL_REFERENCE, env, 320),
      capability_digest: producer.capability_digest,
      skill_package_digest: skillPackageDigest,
    },
    subject,
    fence: {
      pipeline_instance_id: boundedText(fence.pipeline_instance_id, "standard receipt pipeline instance", 160, env),
      graph_digest: fence.graph_digest,
      unit_id: boundedText(fence.unit_id, "standard receipt unit", 120, env),
      attempt_id: boundedText(fence.attempt_id, "standard receipt attempt", 160, env),
      parent_run_id: boundedText(fence.parent_run_id, "standard receipt parent run", 160, env),
      action_attempt_id: boundedText(fence.action_attempt_id, "standard receipt action attempt", 160, env),
      generation: fence.generation,
      native_session_id: nativeSessionId,
      request_hash: fence.request_hash,
    },
    evidence,
    payload,
    issued_at: issuedAt,
  };
}

function assuranceForCapability(capability) {
  const contract = CAPABILITY_CONTRACTS[capability];
  if (!contract) throw new Error(`unknown artifact producer capability ${capability}`);
  if (contract.kind === "command") return "executor_verified";
  if (contract.kind === "provider_wait") return "provider_verified";
  return "semantic_attested";
}

function artifactPayload({ kind, fence, assurance, result, summary, evidence, findings, actions, uncertainty, details }) {
  return {
    schema: `openthrottle.artifact/${kind}@1`,
    kind,
    producer: {
      capability: fence.capability,
      runtime_release: fence.runtimeRelease,
      capability_digest: fence.capabilityDigest,
      version: 1,
    },
    pipeline: {
      instance_id: fence.pipelineInstanceId,
      manifest_digest: fence.manifestDigest,
    },
    stage: {
      id: fence.stageId,
      attempt_id: fence.attemptId,
      request_hash: fence.requestHash,
      context_revision: fence.contextRevision,
      context_policy: fence.contextPolicy,
    },
    run: {
      id: fence.runId,
      ticket_id: fence.issueId,
      session_id: fence.sessionId,
      generation: fence.generation,
      native_session_id: fence.nativeSessionId ?? null,
    },
    repository: {
      name: fence.repository,
      base_commit: fence.baseCommit,
      subject: fence.subject,
      pre_subject: fence.preSubject,
      post_subject: fence.postSubject,
    },
    assurance,
    result,
    summary,
    evidence,
    findings,
    actions,
    uncertainty,
    started_at: fence.startedAt,
    completed_at: fence.completedAt,
    details,
  };
}

function sealArtifact(payload) {
  const normalized = canonicalJson(payload);
  const limit = payload.details?.receipt_type === "tune_analysis" ||
      payload.details?.receipt_type === "tune_proposal"
    ? MAX_TUNE_ARTIFACT_PAYLOAD_BYTES
    : MAX_ARTIFACT_PAYLOAD_BYTES;
  if (Buffer.byteLength(normalized, "utf8") > limit) {
    throw new Error(`artifact ${payload.kind} exceeds the sealed payload limit`);
  }
  return {
    kind: payload.kind,
    schemaVersion: 1,
    assurance: payload.assurance,
    subject: payload.repository.subject,
    payload: normalized,
    hash: digest(normalized),
  };
}

function sealAdmissionExecutionPlan(value, fence, env) {
  const artifact = exactObject(value, "admission execution plan artifact", new Set([
    "schema", "execution_plan", "generated_plan_digest", "producer", "assurance", "source",
  ]));
  if (artifact.schema !== "openthrottle.admission-execution-plan-artifact/v1") {
    throw new Error("admission execution plan artifact has an invalid schema");
  }
  if (artifact.assurance !== "semantic_attested") {
    throw new Error("admission execution plan artifact has invalid assurance");
  }
  if (!artifact.execution_plan || typeof artifact.execution_plan !== "object" || Array.isArray(artifact.execution_plan) ||
      artifact.execution_plan.schema !== "openthrottle.execution-plan/v2" ||
      artifact.execution_plan.graph_id !== "structured") {
    throw new Error("admission execution plan artifact has an invalid structured plan");
  }
  const generatedPlanDigest = patternedText(
    artifact.generated_plan_digest,
    "admission execution plan artifact generated_plan_digest",
    SHA256,
    env,
    64,
  );
  if (digest(canonicalJson(artifact.execution_plan)) !== generatedPlanDigest) {
    throw new Error("admission execution plan artifact digest does not match canonical plan bytes");
  }
  const producer = exactObject(artifact.producer, "admission execution plan artifact producer", new Set([
    "skill", "capability_digest", "skill_package_digest",
  ]));
  const source = exactObject(artifact.source, "admission execution plan artifact source", new Set([
    "admission_basis_digest", "effective_manifest_digest", "request_hash",
  ]));
  const normalized = canonicalJson({
    schema: artifact.schema,
    execution_plan: boundedPlainObject(artifact.execution_plan, "admission execution plan", env, 256 * 1024),
    generated_plan_digest: generatedPlanDigest,
    producer: {
      skill: patternedText(producer.skill, "admission execution plan artifact producer skill", SKILL_REFERENCE, env, 320),
      capability_digest: patternedText(producer.capability_digest, "admission execution plan artifact producer capability_digest", SHA256, env, 64),
      skill_package_digest: nullable(producer.skill_package_digest, (entry) =>
        patternedText(entry, "admission execution plan artifact producer skill_package_digest", SHA256, env, 64)),
    },
    assurance: artifact.assurance,
    source: {
      admission_basis_digest: patternedText(source.admission_basis_digest, "admission execution plan artifact source admission_basis_digest", SHA256, env, 64),
      effective_manifest_digest: patternedText(source.effective_manifest_digest, "admission execution plan artifact source effective_manifest_digest", SHA256, env, 64),
      request_hash: patternedText(source.request_hash, "admission execution plan artifact source request_hash", SHA256, env, 64),
    },
  });
  if (Buffer.byteLength(normalized, "utf8") > ADMISSION_EXECUTION_PLAN_ARTIFACT_MAX_BYTES) {
    throw new Error("admission execution plan artifact exceeds the sealed payload limit");
  }
  return {
    kind: "execution_plan",
    schemaVersion: 1,
    assurance: "semantic_attested",
    subject: fence.subject,
    payload: normalized,
    hash: digest(normalized),
  };
}

export function buildSemanticArtifacts({
  proposal,
  fence,
  requiredArtifacts,
  publishedCommit,
  env = process.env,
}) {
  const normalized = validateSemanticProposal(proposal, env);
  const assurance = assuranceForCapability(fence.capability);
  const kinds = [...new Set(["stage_result", ...requiredArtifacts])];
  return kinds.map((kind) => sealArtifact(artifactPayload({
    kind,
    fence,
    assurance,
    result: normalized.suggested_outcome,
    summary: normalized.summary,
    evidence: normalized.evidence,
    findings: normalized.findings,
    actions: normalized.actions,
    uncertainty: normalized.uncertainty,
    details: {
      proposal_schema: normalized.schema,
      ...(publishedCommit ? { published_commit: publishedCommit } : {}),
    },
  })));
}

export function buildCommandArtifacts({ fence, command, commandName, execution, requiredArtifacts, env = process.env }) {
  const terminated = Boolean(execution.timedOut || execution.signal || execution.exitCode === 137);
  const result = execution.notConfigured
    ? "not_configured"
    : execution.executorFailure
      ? "retryable_infrastructure_failure"
      : execution.exitCode === 0 && !terminated
        ? "success"
        : terminated
          ? "retryable_infrastructure_failure"
          : "failure";
  const details = {
    command_name: commandName,
    command_digest: digest(command),
    exit_code: execution.exitCode,
    signal: execution.signal ?? null,
    timed_out: Boolean(execution.timedOut),
    not_configured: Boolean(execution.notConfigured),
    ...(execution.executorFailure ? { executor_failure: true } : {}),
    stdout: sanitizeArtifactText(execution.stdout ?? "", env).slice(-2_000),
    stderr: sanitizeArtifactText(execution.stderr ?? "", env).slice(-2_000),
  };
  const kinds = [...new Set(["stage_result", ...requiredArtifacts])];
  return kinds.map((kind) => sealArtifact(artifactPayload({
    kind,
    fence,
    assurance: "executor_verified",
    result,
    summary: execution.notConfigured
      ? `Repository command ${commandName} is not configured.`
      : execution.executorFailure
        ? `Repository command ${commandName} executor failed before verified completion.`
        : `Repository command ${commandName} exited with ${execution.exitCode}.`,
    evidence: [],
    findings: [],
    actions: [],
    uncertainty: [],
    details,
  })));
}

function assertStandardReceiptAuthority(receipt, authority) {
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    throw new Error("standard receipt sealing authority is missing");
  }
  if (receipt.assurance !== authority.assurance) {
    throw new Error("standard receipt assurance does not match the sealed stage authority");
  }
  for (const field of ["worker_id", "skill", "capability_digest", "skill_package_digest"]) {
    if (receipt.producer[field] !== authority.producer?.[field]) {
      throw new Error(`standard receipt producer ${field} does not match the sealed stage authority`);
    }
  }
  for (const field of ["base", "pre", "post"]) {
    if (receipt.subject[field] !== authority.subject?.[field]) {
      throw new Error(`standard receipt subject ${field} does not match the sealed stage authority`);
    }
  }
  for (const field of [
    "pipeline_instance_id",
    "graph_digest",
    "unit_id",
    "attempt_id",
    "parent_run_id",
    "action_attempt_id",
    "generation",
    "native_session_id",
    "request_hash",
  ]) {
    if (receipt.fence[field] !== authority.fence?.[field]) {
      throw new Error(`standard receipt fence ${field} does not match the sealed stage authority`);
    }
  }
}

export function buildStandardReceiptArtifacts({
  receipt,
  fence,
  authority,
  executionPlan,
  requiredArtifacts = ["standard_receipt"],
  env = process.env,
}) {
  const normalized = validateStandardReceipt(receipt, env);
  assertStandardReceiptAuthority(normalized, authority);
  const receiptPayload = canonicalJson(normalized);
  const receiptHash = digest(receiptPayload);
  // Admission agents report a typed recommendation, not a stage transition.
  // The supervisor gate must see every valid decision/review receipt and own
  // the branch outcome, including needs_human and rejected results.
  const result = normalized.type === "admission_decision" || normalized.type === "admission_review"
    ? "success"
    : STANDARD_RECEIPT_STAGE_OUTCOMES[normalized.result];
  if (!result) throw new Error(`standard receipt result ${normalized.result} cannot map to a stage outcome`);
  const expectsExecutionPlan = requiredArtifacts.includes("execution_plan");
  if (normalized.type === "admission_decision") {
    const structured = normalized.result === "structured";
    if (structured !== Boolean(executionPlan)) {
      throw new Error(`admission decision ${normalized.result} has inconsistent execution plan presence`);
    }
  } else if (executionPlan !== undefined) {
    throw new Error("only admission decision receipts can carry an execution plan");
  }
  const kinds = [...new Set(["stage_result", ...requiredArtifacts.filter((kind) => kind !== "execution_plan")])];
  const artifacts = kinds.map((kind) => sealArtifact(artifactPayload({
    kind,
    fence,
    assurance: normalized.assurance,
    result,
    summary: `${normalized.type} receipt returned ${normalized.result}.`,
    evidence: [receiptHash],
    findings: normalized.type === "semantic_review" && Array.isArray(normalized.payload.findings)
      ? normalized.payload.findings
      : [],
    actions: [],
    uncertainty: [],
    details: {
      receipt_type: normalized.type,
      receipt_result: normalized.result,
      receipt_hash: receiptHash,
      ...(kind === "standard_receipt" ? { receipt: normalized } : {}),
    },
  })));
  if (executionPlan !== undefined) artifacts.push(sealAdmissionExecutionPlan(executionPlan, fence, env));
  if (expectsExecutionPlan && executionPlan === undefined) {
    throw new Error("stage requires an admission execution plan artifact");
  }
  return artifacts;
}

// --- Loop receipt extraction -------------------------------------------------
// parseLoopReceipt historically lived in execute-loop.mjs, which forced
// execute-stage.mjs to import the loop runner just to parse a receipt. It
// belongs here with the other receipt validators.

const CODEX_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const STANDARD_RECEIPT_TYPES = new Set(Object.keys(STANDARD_RECEIPT_RESULTS));

function receiptCandidatesFromJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  if (value.type === "item.completed") {
    const codexAgentMessage = codexAgentMessageText(value);
    return codexAgentMessage === null ? [] : [codexAgentMessage];
  }
  const candidates = [];
  for (const key of ["receipt", "output", "content", "message"]) {
    if (value[key] !== undefined) candidates.push(value[key]);
  }
  if (value.type === "result" && value.result !== undefined) candidates.push(value.result);
  return candidates;
}

function codexAgentMessageText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.type !== "item.completed" || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "type") || !Object.hasOwn(value, "item")) return null;
  const item = value.item;
  if (!item || typeof item !== "object" || Array.isArray(item) ||
      item.type !== "agent_message" || !Object.hasOwn(item, "type") ||
      !Object.hasOwn(item, "text") || typeof item.text !== "string" ||
      Object.keys(item).some((key) => !["id", "text", "type"].includes(key)) ||
      (Object.hasOwn(item, "id") && (typeof item.id !== "string" || !CODEX_ITEM_ID.test(item.id)))) return null;
  return item.text;
}

function isLoopReceiptCandidateShaped(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    value.schema === STANDARD_RECEIPT_SCHEMA;
}

function validateStandardReceiptForLoop(value, env, expectedReceiptType) {
  if (expectedReceiptType !== undefined && isLoopReceiptCandidateShaped(value)) {
    if (!Object.hasOwn(value, "type")) throw new Error("standard receipt is missing field type");
    if (!STANDARD_RECEIPT_TYPES.has(value.type)) throw new Error("standard receipt has an invalid type");
    if (value.type !== expectedReceiptType) {
      throw new Error(`loop receipt type mismatch: expected ${expectedReceiptType}, received ${value.type}`);
    }
  }
  return validateStandardReceipt(value, env);
}

function ambiguousCodexReceiptError(jsonl, asReceipt) {
  let receiptLikeMessages = 0;
  for (const line of jsonl.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const text = codexAgentMessageText(event);
    if (text === null) continue;
    try {
      if (isLoopReceiptCandidateShaped(parseAgentJson(text, asReceipt))) receiptLikeMessages += 1;
    } catch (error) {
      if (error?.ambiguousAgentJson) return error;
    }
  }
  if (receiptLikeMessages <= 1) return null;
  const error = new Error(
    `${receiptLikeMessages} receipt-like Codex agent messages found; refusing to guess which one is the receipt`,
  );
  error.ambiguousAgentJson = true;
  return error;
}

export function parseLoopReceipt(raw, env = process.env, expectedReceiptType = undefined) {
  const sanitized = sanitizeArtifactText(raw, env).trim();
  if (!sanitized) throw new Error("loop action did not emit a receipt");
  const candidates = [sanitized, ...sanitized.split("\n").map((line) => line.trim()).filter(Boolean).reverse()];
  // The validator's rejection message is precise ("standard receipt is missing
  // field schema"); discarding it made OPE-101 cost a full live reproduction to
  // learn one sentence. Keep the first error from each layer and report the
  // decisive one. Layer preference matters: the top-layer candidate is the
  // engine's own stream-json envelope, whose rejection is always the same
  // uninformative "unknown field subtype". The nested layer is where the
  // agent-authored receipt actually lives (the `type: "result"` line's `result`
  // text), so its error is the one that names the real defect.
  // Several receipt-shaped blocks in one message is its own situation, and the
  // most decisive thing we can say about that message: the receipt was found,
  // more than once, and the executor declined to pick. It outranks either
  // validator error, which would otherwise describe whichever candidate the
  // scan happened to reach first.
  let ambiguityError = null;
  let nestedError = null;
  let nestedCandidate = null;
  let topError = null;
  let topCandidate = null;
  const asReceipt = { qualifies: isLoopReceiptCandidateShaped, label: "receipt" };
  const codexAmbiguity = ambiguousCodexReceiptError(sanitized, asReceipt);
  if (codexAmbiguity) {
    throw new Error(`loop action emitted invalid standard receipt: ${codexAmbiguity.message}`);
  }
  for (const candidate of candidates) {
    try {
      // parseAgentJson, not JSON.parse: both layers carry text the model
      // typed, so both get the fence peel (OPE-101 generation 6) and the
      // single-qualifying-block extraction (generation 8). The parsed value is
      // identical to the unfenced case, so validation below is untouched.
      const parsed = typeof candidate === "string" ? parseAgentJson(candidate, asReceipt) : candidate;
      try {
        return validateStandardReceiptForLoop(parsed, env, expectedReceiptType);
      } catch (error) {
        topError ??= error;
        topCandidate ??= parsed;
        for (const nested of receiptCandidatesFromJson(parsed)) {
          try {
            const normalized = typeof nested === "string" ? parseAgentJson(nested, asReceipt) : nested;
            return validateStandardReceiptForLoop(normalized, env, expectedReceiptType);
          } catch (error) {
            if (error?.ambiguousAgentJson) ambiguityError ??= error;
            else {
              nestedError ??= error;
              try {
                nestedCandidate ??= typeof nested === "string" ? parseAgentJson(nested, asReceipt) : nested;
              } catch {
                // Keep the validator message as the primary diagnostic.
              }
            }
          }
        }
      }
    } catch (error) {
      // Continue searching bounded agent output for the structured receipt.
      if (error?.ambiguousAgentJson) ambiguityError ??= error;
    }
  }
  const cause = ambiguityError ?? nestedError ?? topError;
  const detail = cause instanceof Error ? cause.message : cause ? String(cause) : "";
  const error = new Error(`loop action emitted invalid standard receipt${detail ? `: ${detail}` : ""}`);
  error.invalidReceiptCandidate = nestedCandidate ?? topCandidate;
  throw error;
}
