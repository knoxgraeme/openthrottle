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
const STANDARD_RECEIPT_RESULTS = Object.freeze({
  unit_completion: ["success", "failure", "needs_human", "exited"],
  unit_decision: ["accept", "revise", "context_update", "needs_human"],
  semantic_review: ["success", "no_change", "semantic_repair_required", "failure", "needs_human"],
  command_result: ["success", "failure", "not_configured"],
  candidate_evidence: ["success", "failure"],
  integration_evidence: ["success", "failure"],
  publish_subject: ["success", "failure"],
  provider_evidence: ["success", "semantic_repair_required", "failure"],
  human_approval: ["approved", "rejected", "needs_human"],
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
const SEMANTIC_RECEIPTS = new Set(["unit_completion", "unit_decision", "semantic_review"]);
const SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SUBJECT = /^[a-f0-9]{40,64}$/;
const MAX_ARTIFACT_PAYLOAD_BYTES = 12 * 1024;
const SECRET_PATTERNS = [
  /gh[opsu]_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /sk-[A-Za-z0-9_-]+/g,
  /lin_(?:api|oauth)_[A-Za-z0-9_]+/g,
  /Bearer\s+\S+/g,
];

export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
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
  return output;
}

function boundedText(value, label, max, env) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const sanitized = sanitizeArtifactText(value, env).trim();
  if (!sanitized) throw new Error(`${label} must not be empty`);
  return sanitized.slice(0, max);
}

function boundedStrings(value, label, maxItems, maxLength, env) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} must contain at most ${maxItems} items`);
  }
  return value.map((item, index) => boundedText(item, `${label}[${index}]`, maxLength, env));
}

export function validateSemanticProposal(value, env = process.env) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stage proposal must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!PROPOSAL_KEYS.has(key)) throw new Error(`stage proposal cannot set authoritative field ${key}`);
  }
  if (value.schema !== "openthrottle.stage-proposal/v1") {
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
    schema: "openthrottle.stage-proposal/v1",
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

function boundedPlainObject(value, label, env) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const sanitized = sanitizeArtifactText(JSON.stringify(value), env);
  if (Buffer.byteLength(sanitized, "utf8") > 32 * 1024) throw new Error(`${label} exceeds the receipt payload limit`);
  return JSON.parse(sanitized);
}

export function validateStandardReceipt(value, env = process.env) {
  const input = exactObject(value, "standard receipt", STANDARD_RECEIPT_KEYS);
  if (input.schema !== "openthrottle.receipt/v1") throw new Error("standard receipt has an invalid schema");
  const results = STANDARD_RECEIPT_RESULTS[input.type];
  if (!results) throw new Error("standard receipt has an invalid type");
  if (!["semantic_attested", "semantic_corroborated", "executor_verified", "provider_verified", "human_approved"].includes(input.assurance)) {
    throw new Error("standard receipt has an invalid assurance");
  }
  if (SEMANTIC_RECEIPTS.has(input.type) && ["executor_verified", "provider_verified", "human_approved"].includes(input.assurance)) {
    throw new Error("semantic standard receipt cannot claim executor, provider, or human assurance");
  }
  if (!results.includes(input.result)) throw new Error("standard receipt has an invalid result");
  const producer = exactObject(input.producer, "standard receipt producer", new Set(["worker_id", "skill", "capability_digest"]));
  const subject = exactObject(input.subject, "standard receipt subject", new Set(["base", "pre", "post"]));
  const fence = exactObject(input.fence, "standard receipt fence", new Set([
    "pipeline_instance_id", "graph_digest", "unit_id", "attempt_id", "request_hash",
  ]));
  if (!SHA256.test(producer.capability_digest)) throw new Error("standard receipt capability digest is invalid");
  if (![subject.base, subject.pre, subject.post].every((entry) => typeof entry === "string" && GIT_SUBJECT.test(entry))) {
    throw new Error("standard receipt subject is invalid");
  }
  if (![fence.graph_digest, fence.request_hash].every((entry) => typeof entry === "string" && SHA256.test(entry))) {
    throw new Error("standard receipt fence digest is invalid");
  }
  const evidence = boundedStrings(input.evidence, "standard receipt evidence", 32, 1_000, env);
  const issuedAt = boundedText(input.issued_at, "standard receipt issued_at", 64, env);
  if (Number.isNaN(Date.parse(issuedAt))) throw new Error("standard receipt issued_at is invalid");
  return {
    schema: "openthrottle.receipt/v1",
    type: input.type,
    assurance: input.assurance,
    result: input.result,
    producer: {
      worker_id: boundedText(producer.worker_id, "standard receipt producer worker", 120, env),
      skill: boundedText(producer.skill, "standard receipt producer skill", 240, env),
      capability_digest: producer.capability_digest,
    },
    subject,
    fence: {
      pipeline_instance_id: boundedText(fence.pipeline_instance_id, "standard receipt pipeline instance", 160, env),
      graph_digest: fence.graph_digest,
      unit_id: boundedText(fence.unit_id, "standard receipt unit", 120, env),
      attempt_id: boundedText(fence.attempt_id, "standard receipt attempt", 160, env),
      request_hash: fence.request_hash,
    },
    evidence,
    payload: boundedPlainObject(input.payload, "standard receipt payload", env),
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
  if (Buffer.byteLength(normalized, "utf8") > MAX_ARTIFACT_PAYLOAD_BYTES) {
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

export function buildStandardReceiptArtifacts({ receipt, fence, requiredArtifacts = ["standard_receipt"], env = process.env }) {
  const normalized = validateStandardReceipt(receipt, env);
  const receiptPayload = canonicalJson(normalized);
  const receiptHash = digest(receiptPayload);
  const result = STANDARD_RECEIPT_STAGE_OUTCOMES[normalized.result];
  if (!result) throw new Error(`standard receipt result ${normalized.result} cannot map to a stage outcome`);
  const kinds = [...new Set(["stage_result", ...requiredArtifacts])];
  return kinds.map((kind) => sealArtifact(artifactPayload({
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
}
