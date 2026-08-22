import {
  chmodSync,
  chownSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isRoot } from "./filesystem-isolation.mjs";
import { canonicalJson, digest } from "./kernel-json.mjs";

export const ACTION_CONTEXT_SCHEMA = "openthrottle.agent-action-context/v1";
export const ACTION_CONTEXT_ARTIFACT_MAX_BYTES = 512 * 1024;

const SEMANTIC_RESULT_SCHEMA = "openthrottle.semantic-result-record/v1";
const COMMAND_RESULT_SCHEMA = "openthrottle.command-result-record/v1";
const EXTERNAL_RESULT_SCHEMA = "openthrottle.external-result-record/v1";
const PIPELINE_DECISION_SCHEMA = "openthrottle.pipeline-decision-record/v1";
const ADMISSION_PROMOTION_SCHEMA = "openthrottle.admission-promotion/v1";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const SUBJECT = /^[a-f0-9]{40,64}$/;
const MAX_CONTEXT_ITEMS = 256;
const MAX_EXTERNAL_DELIVERY_RECORDS = 128;
const MAX_EXTERNAL_SUMMARY_LENGTH = 4_000;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new Error(`${label} must be a bounded identifier`);
  }
  return value;
}

function text(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function subject(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !SUBJECT.test(value)) {
    throw new Error(`${label} must be a Git object id`);
  }
  return value;
}

function jsonValue(value, label) {
  try {
    canonicalJson(value);
  } catch {
    throw new Error(`${label} must be canonical JSON data`);
  }
  return value;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inlinePayload(record) {
  const payload = object(record.payload, `record ${record.id} payload`);
  if (payload.blob !== undefined) {
    throw new Error(`required semantic record ${record.id} is blob-backed`);
  }
  if (payload.inline === undefined) {
    throw new Error(`required semantic record ${record.id} has no inline payload`);
  }
  return object(payload.inline, `record ${record.id} inline payload`);
}

function semanticResult(record) {
  const payload = inlinePayload(record);
  if (payload.schema !== SEMANTIC_RESULT_SCHEMA) {
    throw new Error(`semantic result record ${record.id} changed its payload schema`);
  }
  return {
    record_id: record.id,
    kind: "semantic_result",
    semantic_schema_id: identifier(
      payload.semantic_schema_id,
      `semantic result record ${record.id} schema ID`,
    ),
    outcome: identifier(payload.outcome, `semantic result record ${record.id} outcome`),
    payload: jsonValue(payload.payload, `semantic result record ${record.id} payload`),
  };
}

function commandResult(record) {
  const payload = inlinePayload(record);
  if (payload.schema !== COMMAND_RESULT_SCHEMA || !Number.isSafeInteger(payload.exit_code)) {
    throw new Error(`command result record ${record.id} has an invalid payload`);
  }
  return {
    record_id: record.id,
    kind: "command_result",
    command_id: identifier(payload.command_id, `command result record ${record.id} command ID`),
    outcome: identifier(payload.outcome, `command result record ${record.id} outcome`),
    exit_code: payload.exit_code,
    summary: text(payload.summary, `command result record ${record.id} summary`),
  };
}

function externalResult(record) {
  const payload = inlinePayload(record);
  if (payload.schema !== EXTERNAL_RESULT_SCHEMA) {
    throw new Error(`external result record ${record.id} changed its payload schema`);
  }
  const summary = text(payload.summary, `external result record ${record.id} summary`);
  const deliveryIds = payload.delivery_record_ids;
  if (
    summary.length > MAX_EXTERNAL_SUMMARY_LENGTH || !Array.isArray(deliveryIds) ||
    deliveryIds.length > MAX_EXTERNAL_DELIVERY_RECORDS
  ) {
    throw new Error(`external result record ${record.id} has an invalid payload`);
  }
  const exactDeliveryIds = deliveryIds.map((id) => identifier(
    id,
    `external result record ${record.id} delivery record ID`,
  ));
  if (new Set(exactDeliveryIds).size !== exactDeliveryIds.length) {
    throw new Error(`external result record ${record.id} repeats a delivery record ID`);
  }
  return {
    record_id: record.id,
    kind: "external_result",
    external_kind: identifier(
      payload.external_kind,
      `external result record ${record.id} external kind`,
    ),
    outcome: identifier(payload.outcome, `external result record ${record.id} outcome`),
    summary,
  };
}

function pipelineDecision(record) {
  const payload = inlinePayload(record);
  if (payload.schema !== PIPELINE_DECISION_SCHEMA) {
    throw new Error(`pipeline decision record ${record.id} changed its payload schema`);
  }
  return {
    record_id: record.id,
    kind: "pipeline_decision",
    stage_id: identifier(payload.stage_id, `pipeline decision record ${record.id} stage ID`),
    evaluator: identifier(payload.evaluator, `pipeline decision record ${record.id} evaluator`),
    outcome: identifier(payload.outcome, `pipeline decision record ${record.id} outcome`),
    reason: text(payload.reason, `pipeline decision record ${record.id} reason`),
  };
}

function admissionPromotion(record) {
  const payload = inlinePayload(record);
  if (
    payload.schema !== ADMISSION_PROMOTION_SCHEMA ||
    !["core/implement", "core/structured"].includes(payload.selected_pipeline)
  ) {
    throw new Error(`admission promotion record ${record.id} has an invalid payload`);
  }
  return {
    record_id: record.id,
    kind: "admission_promotion",
    selected_pipeline: payload.selected_pipeline,
    source_commit: subject(payload.source_commit, `admission promotion record ${record.id} source commit`),
    execution_plan: payload.execution_plan === null
      ? null
      : jsonValue(payload.execution_plan, `admission promotion record ${record.id} execution plan`),
  };
}

function projectedRecord(record) {
  object(record, "action context record");
  identifier(record.id, "action context record ID");
  if (record.kind === "delivery") return null;
  if (record.kind === "result") {
    if (record.payload_schema === SEMANTIC_RESULT_SCHEMA) return semanticResult(record);
    if (record.payload_schema === COMMAND_RESULT_SCHEMA) return commandResult(record);
    if (record.payload_schema === EXTERNAL_RESULT_SCHEMA) return externalResult(record);
    throw new Error(
      `required result record ${record.id} uses unsupported payload schema ${String(record.payload_schema)}`,
    );
  }
  if (record.kind === "decision") {
    if (record.payload_schema === PIPELINE_DECISION_SCHEMA) return pipelineDecision(record);
    if (record.payload_schema === ADMISSION_PROMOTION_SCHEMA) return admissionPromotion(record);
    throw new Error(
      `required decision record ${record.id} uses unsupported payload schema ${String(record.payload_schema)}`,
    );
  }
  throw new Error(`action context record ${record.id} has an unsupported kind`);
}

function projectedScope(stageId, value) {
  const scope = object(value, "action context scope");
  if (identifier(scope.stage_id, "action context scope stage ID") !== stageId) {
    throw new Error("action context scope stage does not match the sealed stage");
  }
  if (scope.kind === "stage") return { kind: "stage" };
  if (scope.kind === "loop_item") {
    if (!Number.isSafeInteger(scope.item_index) || scope.item_index < 0) {
      throw new Error("action context loop item index must be a non-negative integer");
    }
    return {
      kind: "loop_item",
      loop_id: identifier(scope.loop_id, "action context loop ID"),
      item_id: identifier(scope.item_id, "action context loop item ID"),
      item_index: scope.item_index,
    };
  }
  if (scope.kind === "fanout_member") {
    if (!Number.isSafeInteger(scope.member_index) || scope.member_index < 0) {
      throw new Error("action context fanout member index must be a non-negative integer");
    }
    return {
      kind: "fanout_member",
      fanout_id: identifier(scope.fanout_id, "action context fanout ID"),
      member_id: identifier(scope.member_id, "action context fanout member ID"),
      member_index: scope.member_index,
    };
  }
  throw new Error("action context scope kind is unsupported");
}

function projectedCheckpoints(checkpoints) {
  if (!Array.isArray(checkpoints) || checkpoints.length > MAX_CONTEXT_ITEMS) {
    throw new Error(`action context checkpoints must contain at most ${MAX_CONTEXT_ITEMS} entries`);
  }
  const ordered = [...checkpoints].sort((left, right) =>
    compareCodeUnits(String(left?.id), String(right?.id)));
  const ids = ordered.map((checkpoint) => identifier(
    object(checkpoint, "action context checkpoint").id,
    "action context checkpoint ID",
  ));
  if (new Set(ids).size !== ids.length) throw new Error("action context checkpoint IDs repeat");
  return ordered.map((checkpoint) => ({
    checkpoint_id: checkpoint.id,
    input_subject: subject(checkpoint.input_subject, `checkpoint ${checkpoint.id} input subject`),
    output_subject: subject(
      checkpoint.output_subject,
      `checkpoint ${checkpoint.id} output subject`,
      true,
    ),
  }));
}

export function projectActionContext(request) {
  const input = object(request, "action context request");
  const stageId = identifier(input.stage_id, "action context stage ID");
  const context = object(input.context, "action context");
  if (!Array.isArray(context.records) || context.records.length > MAX_CONTEXT_ITEMS) {
    throw new Error(`action context records must contain at most ${MAX_CONTEXT_ITEMS} entries`);
  }
  const orderedRecords = [...context.records].sort((left, right) =>
    compareCodeUnits(String(left?.id), String(right?.id)));
  const ids = orderedRecords.map((record) => identifier(
    object(record, "action context record").id,
    "action context record ID",
  ));
  if (new Set(ids).size !== ids.length) throw new Error("action context record IDs repeat");
  const records = orderedRecords.map(projectedRecord).filter((record) => record !== null);
  const checkpoints = projectedCheckpoints(context.checkpoints);
  return {
    schema: ACTION_CONTEXT_SCHEMA,
    stage_id: stageId,
    scope: projectedScope(stageId, input.scope),
    records,
    checkpoints,
    omitted: {
      delivery_records: orderedRecords.length - records.length,
      checkpoint_payloads: checkpoints.length,
    },
  };
}

export function materializeActionContextArtifact({ request, actionDirectory, destination }) {
  const actionRoot = resolve(actionDirectory);
  const artifactPath = resolve(destination);
  const artifactDirectory = join(actionRoot, "action-context");
  if (artifactPath !== join(artifactDirectory, "context.json")) {
    throw new Error("action context artifact must use its executor-owned dedicated location");
  }
  const serialized = `${canonicalJson(projectActionContext(request))}\n`;
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > ACTION_CONTEXT_ARTIFACT_MAX_BYTES) {
    throw new Error(`action context artifact exceeds ${ACTION_CONTEXT_ARTIFACT_MAX_BYTES} bytes`);
  }
  rmSync(artifactDirectory, { recursive: true, force: true });
  mkdirSync(artifactDirectory, { mode: 0o755 });
  writeFileSync(artifactPath, serialized, { flag: "wx", mode: 0o444 });
  if (isRoot()) {
    chownSync(artifactDirectory, 0, 0);
    chownSync(artifactPath, 0, 0);
  }
  chmodSync(artifactPath, 0o444);
  chmodSync(artifactDirectory, 0o555);
  return {
    schema: ACTION_CONTEXT_SCHEMA,
    path: artifactPath,
    bytes,
    sha256: digest(serialized),
  };
}

export function verifyActionContextArtifact(descriptor) {
  if (
    descriptor?.schema !== ACTION_CONTEXT_SCHEMA ||
    typeof descriptor.path !== "string" || !descriptor.path.startsWith("/") ||
    !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 ||
    descriptor.bytes > ACTION_CONTEXT_ARTIFACT_MAX_BYTES ||
    typeof descriptor.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.sha256)
  ) {
    throw new Error("action context artifact descriptor is invalid");
  }
  const metadata = lstatSync(descriptor.path);
  const directoryMetadata = lstatSync(dirname(descriptor.path));
  if (
    !directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() ||
    (directoryMetadata.mode & 0o222) !== 0 ||
    (isRoot() && (directoryMetadata.uid !== 0 || directoryMetadata.gid !== 0)) ||
    !metadata.isFile() || metadata.isSymbolicLink() ||
    metadata.size !== descriptor.bytes || (metadata.mode & 0o222) !== 0 ||
    (isRoot() && (metadata.uid !== 0 || metadata.gid !== 0))
  ) {
    throw new Error("action context artifact lost its executor-owned read-only seal");
  }
  if (digest(readFileSync(descriptor.path)) !== descriptor.sha256) {
    throw new Error("action context artifact content changed after materialization");
  }
  return descriptor;
}
