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
const SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);
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
      : `Repository command ${commandName} exited with ${execution.exitCode}.`,
    evidence: [],
    findings: [],
    actions: [],
    uncertainty: [],
    details,
  })));
}
