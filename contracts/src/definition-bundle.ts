import { Buffer } from "node:buffer";
import { canonicalJson, digestCanonicalJson } from "./canonical.js";
import {
  GIT_SUBJECT,
  IDENTIFIER,
  SHA256,
  arrayAt,
  enumAt,
  fail,
  jsonValueAt,
  normalizedContract,
  nullable,
  objectAt,
  stringAt,
  type ValidatedContract,
} from "./validation.js";

export const DEFINITION_BUNDLE_SCHEMA = "openthrottle.definition-bundle/v1" as const;
export const DEFINITION_KINDS = ["config", "agent", "pipeline", "skill", "eval", "loop"] as const;
export const DEFINITION_ORIGINS = ["platform", "repository"] as const;
export const DEFINITION_ENTRY_MAX_BYTES = 512 * 1024;

const DEFINITION_PATH = /^\.openthrottle\/(?:config\.yml|agents\/[A-Za-z0-9._/-]+\/instructions\.md|pipelines\/[A-Za-z0-9._/-]+\/(?:pipeline|loops\/[A-Za-z0-9._/-]+)\.ya?ml|skills\/[A-Za-z0-9._/-]+\/SKILL\.md|evals\/[A-Za-z0-9._/-]+\/eval\.ya?ml)$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;

export type DefinitionKind = (typeof DEFINITION_KINDS)[number];
export type DefinitionOriginKind = (typeof DEFINITION_ORIGINS)[number];

export interface DefinitionOrigin {
  kind: DefinitionOriginKind;
  source_commit: string | null;
}

export interface DefinitionBundleEntry {
  definition_kind: DefinitionKind;
  definition_id: string;
  origin: DefinitionOrigin;
  path: string;
  content_hash: string;
  normalized_payload: unknown;
}

export interface DefinitionBundle {
  schema: typeof DEFINITION_BUNDLE_SCHEMA;
  compiler_version: string;
  runtime_capability_digest: string;
  source_commit: string;
  pipeline_id: string;
  entries: DefinitionBundleEntry[];
}

export type TrustedPlatformDefinitionHashes = ReadonlyMap<string, string>;

export function definitionEntryIdentity(kind: DefinitionKind, id: string): string {
  return `${kind}:${id}`;
}

export function definitionEntryContentHash(normalizedPayload: unknown): string {
  return digestCanonicalJson(normalizedPayload);
}

function parseOrigin(value: unknown, path: string): DefinitionOrigin {
  const input = objectAt(value, path, ["kind", "source_commit"]);
  const kind = enumAt(input.kind, `${path}.kind`, DEFINITION_ORIGINS);
  const sourceCommit = nullable(input.source_commit, (entry) =>
    stringAt(entry, `${path}.source_commit`, { pattern: GIT_SUBJECT }));
  if (kind === "repository" && sourceCommit === null) {
    fail(`${path}.source_commit`, "must be present for repository definitions");
  }
  if (kind === "platform" && sourceCommit !== null) {
    fail(`${path}.source_commit`, "must be null for platform definitions");
  }
  return { kind, source_commit: sourceCommit };
}

function definitionPath(value: unknown, kind: DefinitionKind, definitionId: string, path: string): string {
  const parsed = stringAt(value, path, { max: 500, pattern: DEFINITION_PATH });
  const segments = parsed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(path, "must not contain empty, current-directory, or parent-directory segments");
  }
  const expected = kind === "config"
    ? ".openthrottle/config.yml"
    : kind === "agent"
      ? `.openthrottle/agents/${definitionId}/instructions.md`
      : kind === "pipeline"
        ? `.openthrottle/pipelines/${definitionId}/pipeline.yml`
        : kind === "skill"
          ? `.openthrottle/skills/${definitionId}/SKILL.md`
          : kind === "eval"
            ? `.openthrottle/evals/${definitionId}/eval.yml`
            : undefined;
  if (expected !== undefined && parsed !== expected) {
    fail(path, `must be exactly ${expected} for ${kind} ${definitionId}`);
  }
  if (kind === "loop") {
    const [pipelineId, loopId, ...rest] = definitionId.split("/");
    if (!pipelineId || !loopId || rest.length > 0) {
      fail(path, "loop definition_id must be <pipeline-id>/<loop-id>");
    }
    const loopPrefix = `.openthrottle/pipelines/${pipelineId}/loops/${loopId}.`;
    if (parsed !== `${loopPrefix}yml` && parsed !== `${loopPrefix}yaml`) {
      fail(path, `must identify loop ${definitionId} inside its pipeline directory`);
    }
  }
  return parsed;
}

function parseEntry(value: unknown, path: string): DefinitionBundleEntry {
  const input = objectAt(value, path, [
    "definition_kind", "definition_id", "origin", "path", "content_hash", "normalized_payload",
  ]);
  const origin = parseOrigin(input.origin, `${path}.origin`);
  const definitionKind = enumAt(input.definition_kind, `${path}.definition_kind`, DEFINITION_KINDS);
  const definitionId = stringAt(input.definition_id, `${path}.definition_id`, {
    max: 160,
    pattern: IDENTIFIER,
  });
  if (origin.kind === "repository" && (definitionId === "core" || definitionId.startsWith("core/"))) {
    fail(`${path}.definition_id`, "repository definitions cannot use the reserved core namespace");
  }
  const normalizedPayload = jsonValueAt(input.normalized_payload, `${path}.normalized_payload`, {
    maxEntries: 4_096,
    maxKeyLength: 240,
    rejectCarriageReturns: true,
  });
  if (Buffer.byteLength(canonicalJson(normalizedPayload), "utf8") > DEFINITION_ENTRY_MAX_BYTES) {
    fail(`${path}.normalized_payload`, `must be at most ${DEFINITION_ENTRY_MAX_BYTES} canonical JSON bytes`);
  }
  const contentHash = stringAt(input.content_hash, `${path}.content_hash`, { pattern: SHA256 });
  if (definitionEntryContentHash(normalizedPayload) !== contentHash) {
    fail(`${path}.content_hash`, "does not match normalized_payload");
  }
  return {
    definition_kind: definitionKind,
    definition_id: definitionId,
    origin,
    path: definitionPath(input.path, definitionKind, definitionId, `${path}.path`),
    content_hash: contentHash,
    normalized_payload: normalizedPayload,
  };
}

function entryOrder(left: DefinitionBundleEntry, right: DefinitionBundleEntry): number {
  const leftKey = `${left.definition_kind}\0${left.definition_id}\0${left.origin.kind}\0${left.path}`;
  const rightKey = `${right.definition_kind}\0${right.definition_id}\0${right.origin.kind}\0${right.path}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function validateDefinitionBundle(
  value: unknown,
  options: { source?: string; trustedPlatformDefinitions?: TrustedPlatformDefinitionHashes } = {},
): ValidatedContract<DefinitionBundle> {
  const source = options.source ?? "definition_bundle";
  const input = objectAt(value, source, [
    "schema", "compiler_version", "runtime_capability_digest", "source_commit", "pipeline_id", "entries",
  ]);
  if (input.schema !== DEFINITION_BUNDLE_SCHEMA) {
    fail(`${source}.schema`, `must be ${DEFINITION_BUNDLE_SCHEMA}`);
  }
  const sourceCommit = stringAt(input.source_commit, `${source}.source_commit`, { pattern: GIT_SUBJECT });
  const entries = arrayAt(input.entries, `${source}.entries`, parseEntry, { min: 1, max: 512 });
  const identities = entries.map((entry) => `${entry.definition_kind}\0${entry.definition_id}`);
  if (new Set(identities).size !== identities.length) {
    fail(`${source}.entries`, "must not contain duplicate definition identities");
  }
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    fail(`${source}.entries`, "must not contain duplicate definition paths");
  }
  if (entries.filter((entry) => entry.definition_kind === "config").length !== 1) {
    fail(`${source}.entries`, "must contain exactly one behavior-affecting config definition");
  }
  for (const [index, entry] of entries.entries()) {
    if (entry.origin.kind === "repository" && entry.origin.source_commit !== sourceCommit) {
      fail(`${source}.entries[${index}].origin.source_commit`, "must match the bundle source_commit");
    }
    if (entry.origin.kind === "platform") {
      const identity = definitionEntryIdentity(entry.definition_kind, entry.definition_id);
      const trustedHash = options.trustedPlatformDefinitions?.get(identity);
      if (trustedHash !== entry.content_hash) {
        fail(
          `${source}.entries[${index}].origin.kind`,
          `platform definition ${identity} is not present in the trusted platform catalog`,
        );
      }
    }
  }
  const pipelineId = stringAt(input.pipeline_id, `${source}.pipeline_id`, { max: 160, pattern: IDENTIFIER });
  if (!entries.some((entry) => entry.definition_kind === "pipeline" && entry.definition_id === pipelineId)) {
    fail(`${source}.pipeline_id`, "does not reference a bundled pipeline definition");
  }
  return normalizedContract({
    schema: DEFINITION_BUNDLE_SCHEMA,
    compiler_version: stringAt(input.compiler_version, `${source}.compiler_version`, {
      max: 160,
      pattern: VERSION,
    }),
    runtime_capability_digest: stringAt(
      input.runtime_capability_digest,
      `${source}.runtime_capability_digest`,
      { pattern: SHA256 },
    ),
    source_commit: sourceCommit,
    pipeline_id: pipelineId,
    entries: [...entries].sort(entryOrder),
  });
}
