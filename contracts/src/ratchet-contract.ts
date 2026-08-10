import {
  IDENTIFIER,
  SHA256,
  arrayAt,
  enumAt,
  fail,
  normalizedContract,
  objectAt,
  stringAt,
  unique,
  type ValidatedContract,
} from "./validation.js";

export const RATCHET_CONTRACT_SCHEMA = "openthrottle.ratchet-contract/v1" as const;
export const RATCHET_DECISION_SCHEMA = "openthrottle.ratchet-decision/v1" as const;

export const RATCHET_ARTIFACT_KINDS = [
  "candidate_evidence",
  "command_result",
  "execution_graph_result",
  "human_approval",
  "integration_evidence",
  "provider_check",
  "publish_subject",
  "review",
  "stage_result",
  "standard_receipt",
] as const;

export const RATCHET_REJECTION_REASONS = [
  "missing_pinned_artifact",
  "missing_proposed_artifact",
  "artifact_digest_changed",
  "provenance_digest_changed",
  "human_authority_missing",
  "tuner_authority_missing",
  "authority_conflict",
] as const;

export interface RatchetArtifactDigest {
  id: string;
  kind: (typeof RATCHET_ARTIFACT_KINDS)[number];
  artifact_digest: string;
  provenance_digest: string;
}

export interface RatchetHumanAuthority {
  actor_id: string;
  approval_digest: string;
}

export interface RatchetTunerAuthority {
  tuner_id: string;
  proposal_digest: string;
  model_digest: string;
}

export interface RatchetDifferentialInput {
  schema: typeof RATCHET_CONTRACT_SCHEMA;
  id: string;
  pinned: RatchetArtifactDigest[];
  proposed: RatchetArtifactDigest[];
  human_authority: RatchetHumanAuthority | null;
  tuner_authority: RatchetTunerAuthority | null;
}

export interface RatchetDifference {
  reason: (typeof RATCHET_REJECTION_REASONS)[number];
  artifact_id?: string;
}

export interface RatchetDecision {
  schema: typeof RATCHET_DECISION_SCHEMA;
  input_digest: string;
  outcome: "accept" | "reject";
  reject_reasons: Array<(typeof RATCHET_REJECTION_REASONS)[number]>;
  differences: RatchetDifference[];
}

function parseArtifactDigest(value: unknown, path: string): RatchetArtifactDigest {
  const input = objectAt(value, path, ["id", "kind", "artifact_digest", "provenance_digest"]);
  return {
    id: stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER }),
    kind: enumAt(input.kind, `${path}.kind`, RATCHET_ARTIFACT_KINDS),
    artifact_digest: stringAt(input.artifact_digest, `${path}.artifact_digest`, { pattern: SHA256 }),
    provenance_digest: stringAt(input.provenance_digest, `${path}.provenance_digest`, { pattern: SHA256 }),
  };
}

function parseHumanAuthority(value: unknown, path: string): RatchetHumanAuthority {
  const input = objectAt(value, path, ["actor_id", "approval_digest"]);
  return {
    actor_id: stringAt(input.actor_id, `${path}.actor_id`, { max: 160 }),
    approval_digest: stringAt(input.approval_digest, `${path}.approval_digest`, { pattern: SHA256 }),
  };
}

function parseTunerAuthority(value: unknown, path: string): RatchetTunerAuthority {
  const input = objectAt(value, path, ["tuner_id", "proposal_digest", "model_digest"]);
  return {
    tuner_id: stringAt(input.tuner_id, `${path}.tuner_id`, { pattern: IDENTIFIER }),
    proposal_digest: stringAt(input.proposal_digest, `${path}.proposal_digest`, { pattern: SHA256 }),
    model_digest: stringAt(input.model_digest, `${path}.model_digest`, { pattern: SHA256 }),
  };
}

function parseArtifactList(value: unknown, path: string): RatchetArtifactDigest[] {
  const artifacts = arrayAt(value, path, parseArtifactDigest, { min: 1, max: 64 });
  unique(artifacts.map((artifact) => artifact.id), path);
  return artifacts;
}

export function validateRatchetDifferentialInput(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<RatchetDifferentialInput> {
  const source = options.source ?? "ratchet_contract";
  const input = objectAt(value, source, [
    "schema", "id", "pinned", "proposed", "human_authority", "tuner_authority",
  ]);
  if (input.schema !== RATCHET_CONTRACT_SCHEMA) fail(`${source}.schema`, `must be ${RATCHET_CONTRACT_SCHEMA}`);
  const contract: RatchetDifferentialInput = {
    schema: RATCHET_CONTRACT_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
    pinned: parseArtifactList(input.pinned, `${source}.pinned`),
    proposed: parseArtifactList(input.proposed, `${source}.proposed`),
    human_authority: input.human_authority === null
      ? null
      : parseHumanAuthority(input.human_authority, `${source}.human_authority`),
    tuner_authority: input.tuner_authority === null
      ? null
      : parseTunerAuthority(input.tuner_authority, `${source}.tuner_authority`),
  };
  return normalizedContract(contract);
}

export function parseRatchetDifferentialInput(
  raw: string,
  options: { source?: string } = {}
): ValidatedContract<RatchetDifferentialInput> {
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) fail(options.source ?? "ratchet_contract", "JSON exceeds 256 KiB");
  return validateRatchetDifferentialInput(JSON.parse(raw) as unknown, options);
}

export function decideDifferentialRatchet(input: RatchetDifferentialInput): RatchetDecision {
  const validated = validateRatchetDifferentialInput(input);
  const contract = validated.value;
  const pinnedById = new Map(contract.pinned.map((artifact) => [artifact.id, artifact]));
  const proposedById = new Map(contract.proposed.map((artifact) => [artifact.id, artifact]));
  const differences: RatchetDifference[] = [];

  for (const pinned of contract.pinned) {
    const proposed = proposedById.get(pinned.id);
    if (!proposed) {
      differences.push({ reason: "missing_proposed_artifact", artifact_id: pinned.id });
      continue;
    }
    if (proposed.artifact_digest !== pinned.artifact_digest) {
      differences.push({ reason: "artifact_digest_changed", artifact_id: pinned.id });
    }
    if (proposed.provenance_digest !== pinned.provenance_digest) {
      differences.push({ reason: "provenance_digest_changed", artifact_id: pinned.id });
    }
  }

  for (const proposed of contract.proposed) {
    if (!pinnedById.has(proposed.id)) {
      differences.push({ reason: "missing_pinned_artifact", artifact_id: proposed.id });
    }
  }

  if (!contract.human_authority) differences.push({ reason: "human_authority_missing" });
  if (!contract.tuner_authority) differences.push({ reason: "tuner_authority_missing" });
  if (contract.human_authority && contract.tuner_authority &&
      contract.human_authority.approval_digest === contract.tuner_authority.proposal_digest) {
    differences.push({ reason: "authority_conflict" });
  }

  const reject_reasons = unique(differences.map((difference) => difference.reason), "ratchet_decision.reject_reasons");
  return {
    schema: RATCHET_DECISION_SCHEMA,
    input_digest: validated.digest,
    outcome: differences.length === 0 ? "accept" : "reject",
    reject_reasons,
    differences,
  };
}

export function validateRatchetDecision(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<RatchetDecision> {
  const source = options.source ?? "ratchet_decision";
  const input = objectAt(value, source, ["schema", "input_digest", "outcome", "reject_reasons", "differences"]);
  if (input.schema !== RATCHET_DECISION_SCHEMA) fail(`${source}.schema`, `must be ${RATCHET_DECISION_SCHEMA}`);
  const decision: RatchetDecision = {
    schema: RATCHET_DECISION_SCHEMA,
    input_digest: stringAt(input.input_digest, `${source}.input_digest`, { pattern: SHA256 }),
    outcome: enumAt(input.outcome, `${source}.outcome`, ["accept", "reject"]),
    reject_reasons: unique(arrayAt(input.reject_reasons, `${source}.reject_reasons`, (entry, entryPath) => {
      return enumAt(entry, entryPath, RATCHET_REJECTION_REASONS);
    }, { max: 16 }), `${source}.reject_reasons`),
    differences: arrayAt(input.differences, `${source}.differences`, (entry, entryPath) => {
      const difference = objectAt(entry, entryPath, ["reason", "artifact_id"]);
      return {
        reason: enumAt(difference.reason, `${entryPath}.reason`, RATCHET_REJECTION_REASONS),
        ...(difference.artifact_id === undefined ? {} : {
          artifact_id: stringAt(difference.artifact_id, `${entryPath}.artifact_id`, { pattern: IDENTIFIER }),
        }),
      };
    }, { max: 128 }),
  };
  if (decision.outcome === "accept" && (decision.reject_reasons.length > 0 || decision.differences.length > 0)) {
    fail(source, "accept decisions must not include rejection reasons");
  }
  if (decision.outcome === "reject" && (decision.reject_reasons.length === 0 || decision.differences.length === 0)) {
    fail(source, "reject decisions must include rejection reasons");
  }
  for (const difference of decision.differences) {
    if (!decision.reject_reasons.includes(difference.reason)) {
      fail(`${source}.differences.${difference.reason}`, "must be listed in reject_reasons");
    }
  }
  return normalizedContract(decision);
}
