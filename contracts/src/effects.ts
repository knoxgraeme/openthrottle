import { Buffer } from "node:buffer";
import { canonicalJson } from "./canonical.js";
import {
  GIT_SUBJECT,
  fail,
  jsonValueAt,
  normalizedContract,
  nullable,
  objectAt,
  stringAt,
  type ValidatedContract,
} from "./validation.js";

export const EFFECT_INTENT_SCHEMA = "openthrottle.effect-intent/v1" as const;
export const EFFECT_INTENT_PAYLOAD_MAX_BYTES = 64 * 1024;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const EFFECT_KIND = /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*@\d+$/;

export interface EffectIntent {
  schema: typeof EFFECT_INTENT_SCHEMA;
  id: string;
  pipeline_run_id: string;
  decision_record_id: string;
  kind: string;
  idempotency_key: string;
  target: string;
  subject: string | null;
  payload: unknown;
}

function id(value: unknown, path: string): string {
  return stringAt(value, path, { max: 200, pattern: ID });
}

export function validateEffectIntent(
  value: unknown,
  options: { source?: string } = {},
): ValidatedContract<EffectIntent> {
  const source = options.source ?? "effect_intent";
  const input = objectAt(value, source, [
    "schema", "id", "pipeline_run_id", "decision_record_id", "kind", "idempotency_key",
    "target", "subject", "payload",
  ]);
  if (input.schema !== EFFECT_INTENT_SCHEMA) {
    fail(`${source}.schema`, `must be ${EFFECT_INTENT_SCHEMA}`);
  }
  const payload = jsonValueAt(input.payload, `${source}.payload`);
  if (Buffer.byteLength(canonicalJson(payload), "utf8") > EFFECT_INTENT_PAYLOAD_MAX_BYTES) {
    fail(`${source}.payload`, `must be at most ${EFFECT_INTENT_PAYLOAD_MAX_BYTES} canonical JSON bytes`);
  }
  return normalizedContract({
    schema: EFFECT_INTENT_SCHEMA,
    id: id(input.id, `${source}.id`),
    pipeline_run_id: id(input.pipeline_run_id, `${source}.pipeline_run_id`),
    decision_record_id: id(input.decision_record_id, `${source}.decision_record_id`),
    kind: stringAt(input.kind, `${source}.kind`, { max: 200, pattern: EFFECT_KIND }),
    idempotency_key: stringAt(input.idempotency_key, `${source}.idempotency_key`, { max: 500 }),
    target: stringAt(input.target, `${source}.target`, { max: 1_000 }),
    subject: nullable(input.subject, (entry) =>
      stringAt(entry, `${source}.subject`, { pattern: GIT_SUBJECT })),
    payload,
  });
}

export function assertSameIdempotentEffect(
  existing: ValidatedContract<EffectIntent>,
  replay: ValidatedContract<EffectIntent>,
  path = "effect_intent.idempotency_key",
): void {
  if (existing.value.idempotency_key !== replay.value.idempotency_key) {
    fail(path, "does not match the existing effect intent");
  }
  const existingCurrent = validateEffectIntent(existing.value, { source: "existing_effect_intent" });
  const replayCurrent = validateEffectIntent(replay.value, { source: "replay_effect_intent" });
  if (
    existing.digest !== existingCurrent.digest || existing.normalized !== existingCurrent.normalized ||
    replay.digest !== replayCurrent.digest || replay.normalized !== replayCurrent.normalized
  ) {
    fail(path, "references a mutated effect intent");
  }
  if (existingCurrent.digest !== replayCurrent.digest) {
    fail(path, "conflicts with an existing immutable effect intent");
  }
}
