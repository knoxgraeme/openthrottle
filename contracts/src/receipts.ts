import {
  GIT_SUBJECT,
  SHA256,
  SKILL_REFERENCE,
  arrayAt,
  enumAt,
  fail,
  integerAt,
  normalizedContract,
  objectAt,
  stringAt,
  type ValidatedContract,
} from "./validation.js";
import { RECEIPT_TYPES, type ReceiptType } from "./graph.js";

export const RECEIPT_SCHEMA = "openthrottle.receipt/v1" as const;
export const ASSURANCE_CLASSES = [
  "semantic_attested",
  "semantic_corroborated",
  "executor_verified",
  "provider_verified",
  "human_approved",
] as const;
export const RECEIPT_RESULTS = ["success", "failure", "needs_human", "not_configured"] as const;

export interface ReceiptProducer {
  worker_id: string;
  skill: string;
  capability_digest: string;
}

export interface ReceiptFence {
  pipeline_instance_id: string;
  graph_digest: string;
  unit_id: string;
  attempt_id: string;
  request_hash: string;
}

export interface StandardReceipt {
  schema: typeof RECEIPT_SCHEMA;
  type: ReceiptType;
  assurance: (typeof ASSURANCE_CLASSES)[number];
  result: (typeof RECEIPT_RESULTS)[number];
  producer: ReceiptProducer;
  subject: {
    base: string;
    pre: string;
    post: string;
  };
  fence: ReceiptFence;
  evidence: string[];
  issued_at: string;
}

const SEMANTIC_RECEIPTS = new Set<ReceiptType>(["unit_completion", "semantic_review", "unit_decision"]);

function parseProducer(value: unknown, path: string): ReceiptProducer {
  const input = objectAt(value, path, ["worker_id", "skill", "capability_digest"]);
  return {
    worker_id: stringAt(input.worker_id, `${path}.worker_id`, { max: 120 }),
    skill: stringAt(input.skill, `${path}.skill`, { max: 240, pattern: SKILL_REFERENCE }),
    capability_digest: stringAt(input.capability_digest, `${path}.capability_digest`, { pattern: SHA256 }),
  };
}

function parseFence(value: unknown, path: string): ReceiptFence {
  const input = objectAt(value, path, [
    "pipeline_instance_id", "graph_digest", "unit_id", "attempt_id", "request_hash",
  ]);
  return {
    pipeline_instance_id: stringAt(input.pipeline_instance_id, `${path}.pipeline_instance_id`, { max: 160 }),
    graph_digest: stringAt(input.graph_digest, `${path}.graph_digest`, { pattern: SHA256 }),
    unit_id: stringAt(input.unit_id, `${path}.unit_id`, { max: 120 }),
    attempt_id: stringAt(input.attempt_id, `${path}.attempt_id`, { max: 160 }),
    request_hash: stringAt(input.request_hash, `${path}.request_hash`, { pattern: SHA256 }),
  };
}

function parseSubject(value: unknown, path: string): StandardReceipt["subject"] {
  const input = objectAt(value, path, ["base", "pre", "post"]);
  return {
    base: stringAt(input.base, `${path}.base`, { pattern: GIT_SUBJECT }),
    pre: stringAt(input.pre, `${path}.pre`, { pattern: GIT_SUBJECT }),
    post: stringAt(input.post, `${path}.post`, { pattern: GIT_SUBJECT }),
  };
}

function timestamp(value: unknown, path: string): string {
  const result = stringAt(value, path, { max: 64 });
  if (Number.isNaN(Date.parse(result))) fail(path, "must be an ISO timestamp");
  return result;
}

export function validateStandardReceipt(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<StandardReceipt> {
  const source = options.source ?? "receipt";
  const input = objectAt(value, source, [
    "schema", "type", "assurance", "result", "producer", "subject", "fence", "evidence", "issued_at",
  ]);
  if (input.schema !== RECEIPT_SCHEMA) fail(`${source}.schema`, `must be ${RECEIPT_SCHEMA}`);
  const type = enumAt(input.type, `${source}.type`, RECEIPT_TYPES);
  const receipt: StandardReceipt = {
    schema: RECEIPT_SCHEMA,
    type,
    assurance: enumAt(input.assurance, `${source}.assurance`, ASSURANCE_CLASSES),
    result: enumAt(input.result, `${source}.result`, RECEIPT_RESULTS),
    producer: parseProducer(input.producer, `${source}.producer`),
    subject: parseSubject(input.subject, `${source}.subject`),
    fence: parseFence(input.fence, `${source}.fence`),
    evidence: arrayAt(input.evidence, `${source}.evidence`, (entry, entryPath) => {
      return stringAt(entry, entryPath, { max: 1_000 });
    }, { max: 32 }),
    issued_at: timestamp(input.issued_at, `${source}.issued_at`),
  };
  if (SEMANTIC_RECEIPTS.has(type) && ["executor_verified", "provider_verified", "human_approved"].includes(receipt.assurance)) {
    fail(`${source}.assurance`, "semantic receipts cannot claim executor, provider, or human assurance");
  }
  integerAt(receipt.evidence.length, `${source}.evidence.length`, 1, 32);
  return normalizedContract(receipt);
}

export function parseStandardReceipt(raw: string, options: { source?: string } = {}): ValidatedContract<StandardReceipt> {
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) fail(options.source ?? "receipt", "JSON exceeds 64 KiB");
  return validateStandardReceipt(JSON.parse(raw) as unknown, options);
}
