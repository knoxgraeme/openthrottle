// Loop-action request and result primitives shared by the structured child
// runtime and the review orchestrator it delegates to. They live here, below
// both, so neither has to import the other.
import { createHash } from "node:crypto";
import { canonicalJson, digestCanonicalJson } from "@openthrottle/contracts";
import { MAX_LOOP_REQUEST_ENVELOPE_BYTES } from "../pipeline/structured-loop-envelope.js";
import type { ExpectedReceiptProducer } from "../pipeline/execution-gates.js";
import type { ExecutionWorkPrivateArtifact } from "../persistence/pipeline/unit-store.js";
import type {
  ChildExecutorActionResult,
  LoopActionRequest,
  LoopActionResult,
} from "../runtime/contracts.js";

// Head slice for a non-success diagnostic stored as lastError -- fits inside
// the 2,000-char budget the store applies (unit-store.ts) with room to spare.
export const DIAGNOSTIC_TEXT_HEAD_CHARS = 1_500;

export function terminalPayloadForLoopResult(result: LoopActionResult): string | undefined {
  if (!result.recoveryArtifact) return undefined;
  return canonicalJson({
    schema: "openthrottle.execution-work-terminal-payload/v1",
    receipt_recovery_artifact: JSON.parse(result.recoveryArtifact) as unknown,
  });
}

export function privateArtifactForLoopResult(result: LoopActionResult): ExecutionWorkPrivateArtifact | undefined {
  if (!result.recoveryArtifact || !result.recoveryPayload) return undefined;
  const payload = Buffer.from(result.recoveryPayload);
  return {
    schema: "openthrottle.execution-work-private-artifact/v1",
    manifest: result.recoveryArtifact,
    payload,
    payloadSha256: createHash("sha256").update(payload).digest("hex"),
    payloadBytes: payload.byteLength,
  };
}

export function actionResultHash(result: ChildExecutorActionResult | LoopActionResult): string {
  if (!("recoveryPayload" in result) || !result.recoveryPayload) return digestCanonicalJson(result);
  const { recoveryPayload, ...boundedResult } = result;
  const payload = Buffer.from(recoveryPayload);
  return digestCanonicalJson({
    ...boundedResult,
    recoveryPayload: {
      bytes: payload.byteLength,
      sha256: createHash("sha256").update(payload).digest("hex"),
    },
  });
}

function normalizedLoopRequestForHash(
  request: Omit<LoopActionRequest, "requestHash" | "idempotencyKey">
): Omit<LoopActionRequest, "requestHash" | "idempotencyKey"> {
  const { candidateSubject, ...withoutCandidate } = request;
  return candidateSubject === null || candidateSubject === undefined
    ? withoutCandidate
    : { ...withoutCandidate, candidateSubject };
}

export function buildLoopActionRequest(
  request: Omit<LoopActionRequest, "requestHash" | "idempotencyKey">
): LoopActionRequest {
  const normalized = normalizedLoopRequestForHash(request);
  const requestHash = digestCanonicalJson(normalized);
  return {
    ...normalized,
    requestHash,
    idempotencyKey: `loop:${request.attemptId}:${request.actionId}:${requestHash}`,
  };
}

export function assertLoopRequestEnvelopeBound(request: LoopActionRequest): void {
  if (Buffer.byteLength(canonicalJson(request), "utf8") > MAX_LOOP_REQUEST_ENVELOPE_BYTES) {
    throw new Error("sealed loop action request exceeds 262144 bytes");
  }
}

export function builtinProducer(
  skill: "command_result" | "candidate_evidence" | "integration_evidence" | "review-orchestrator",
  capabilityDigest: string,
  assurance: ExpectedReceiptProducer["assurance"] = "executor_verified"
): ExpectedReceiptProducer {
  return {
    workerId: "executor",
    skill: `builtin://${skill}@1`,
    capabilityDigest,
    skillPackageDigest: null,
    assurance,
  };
}
