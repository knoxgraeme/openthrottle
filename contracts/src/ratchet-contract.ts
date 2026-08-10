import { canonicalJson } from "./canonical.js";
import { validateRepositoryConfigContract, type RepositoryConfigContract } from "./config.js";
import { validateGraphContract, type GraphContract } from "./graph.js";
import {
  IDENTIFIER,
  SHA256,
  arrayAt,
  booleanAt,
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
  "credential_scope_expanded",
  "mcp_scope_expanded",
  "gate_weakened",
  "resource_limit_increased",
  "skill_locked",
  "skill_immutable_changed",
  "skill_bounds_exceeded",
  "skill_forbidden_token",
  "unknown_policy_change",
  "incomparable_policy_change",
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

export interface RatchetRepositorySkillPackageFile {
  path: string;
  content: string;
}

export interface RatchetRepositorySkillPackage {
  id: string;
  tunable: boolean;
  files: RatchetRepositorySkillPackageFile[];
}

export interface RatchetDifferentialInput {
  schema: typeof RATCHET_CONTRACT_SCHEMA;
  id: string;
  pinned: RatchetArtifactDigest[];
  proposed: RatchetArtifactDigest[];
  pinned_config?: RepositoryConfigContract;
  proposed_config?: RepositoryConfigContract;
  pinned_graph?: GraphContract;
  proposed_graph?: GraphContract;
  pinned_repository_skills?: RatchetRepositorySkillPackage[];
  proposed_repository_skills?: RatchetRepositorySkillPackage[];
  human_authority: RatchetHumanAuthority | null;
  tuner_authority: RatchetTunerAuthority | null;
}

export interface RatchetDifference {
  reason: (typeof RATCHET_REJECTION_REASONS)[number];
  artifact_id?: string;
  path?: string;
}

export interface RatchetDecision {
  schema: typeof RATCHET_DECISION_SCHEMA;
  input_digest: string;
  outcome: "accept" | "reject";
  reject_reasons: Array<(typeof RATCHET_REJECTION_REASONS)[number]>;
  differences: RatchetDifference[];
}

type RatchetRejectionReason = (typeof RATCHET_REJECTION_REASONS)[number];

const CONFIG_POLICY_TOP_LEVEL_FIELDS = [
  "schema",
  "default_graph",
  "graphs",
  "skills",
  "agent",
  "model",
  "post_bootstrap",
  "pipelines",
  "intents",
] as const;

function pushDifference(
  differences: RatchetDifference[],
  reason: RatchetRejectionReason,
  path: string
): void {
  differences.push({ reason, path });
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function uniqueDifference(
  differences: RatchetDifference[],
  reason: RatchetRejectionReason,
  path: string
): void {
  if (!differences.some((difference) => difference.reason === reason && difference.path === path)) {
    pushDifference(differences, reason, path);
  }
}

function activeMcpServers(config: RepositoryConfigContract): Map<string, unknown> {
  const active = new Map<string, unknown>();
  for (const [name, server] of Object.entries(config.mcp_servers ?? {})) {
    if (server.enabled !== false) active.set(name, server);
  }
  return active;
}

function isSubset<T extends string>(proposed: readonly T[], pinned: readonly T[]): boolean {
  const pinnedSet = new Set(pinned);
  return proposed.every((entry) => pinnedSet.has(entry));
}

function compareResourceLimit(
  pinned: number | undefined,
  proposed: number | undefined,
  path: string,
  differences: RatchetDifference[]
): void {
  if (pinned === undefined) return;
  if (proposed === undefined || proposed > pinned) {
    pushDifference(differences, "resource_limit_increased", path);
  }
}

function compareRepositoryConfigPolicy(
  pinned: RepositoryConfigContract,
  proposed: RepositoryConfigContract,
  differences: RatchetDifference[]
): void {
  for (const field of CONFIG_POLICY_TOP_LEVEL_FIELDS) {
    if (!sameCanonical(pinned[field], proposed[field])) {
      pushDifference(differences, "unknown_policy_change", `config.${field}`);
    }
  }

  compareResourceLimit(
    pinned.limits?.max_turns,
    proposed.limits?.max_turns,
    "config.limits.max_turns",
    differences
  );
  compareResourceLimit(
    pinned.limits?.task_timeout,
    proposed.limits?.task_timeout,
    "config.limits.task_timeout",
    differences
  );

  const pinnedCommands = pinned.commands ?? {};
  const proposedCommands = proposed.commands ?? {};
  for (const [name, command] of Object.entries(pinnedCommands)) {
    if (!(name in proposedCommands)) {
      pushDifference(differences, "gate_weakened", `config.commands.${name}`);
      continue;
    }
    if (proposedCommands[name] !== command) {
      pushDifference(differences, "incomparable_policy_change", `config.commands.${name}`);
    }
  }

  const pinnedServers = activeMcpServers(pinned);
  const proposedServers = activeMcpServers(proposed);
  for (const [name, server] of proposedServers) {
    const pinnedServer = pinnedServers.get(name);
    if (!pinnedServer) {
      pushDifference(differences, "mcp_scope_expanded", `config.mcp_servers.${name}`);
      continue;
    }
    if (!sameCanonical(server, pinnedServer)) {
      pushDifference(differences, "incomparable_policy_change", `config.mcp_servers.${name}`);
    }
  }
}

const SKILL_FILE_MAX_BYTES = 64 * 1024;
const SKILL_PACKAGE_MAX_BYTES = 256 * 1024;
const SKILL_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/;
const FRONTMATTER_DELIMITER = "---";
const CANONICAL_CONTRACT_SCHEMA = /"schema"\s*:\s*"openthrottle\.[^"]+"/;
const COMMAND_OR_TOOL_ALLOWLIST = /\b(?:command|commands|tool|tools|mcp|allowlist|allowed_mcp_servers)\b/i;
const CRAFT_SECTION = /^##\s+(?:craft|reference|references|heuristic|heuristics|method|methods)\b/i;
const FORBIDDEN_SKILL_TOKENS = [
  /\bce-[a-z][a-z-]*[a-z]\b/,
  /\brequest_user_input\b/,
  /\bask\s+(?:the\s+)?user\s+for\s+confirmation\b/i,
  /\bwait\s+for\s+confirmation\b/i,
  /\bblocking\s+(?:question|approval)\b/i,
  /\bread\s+-p\b/,
  /\bselect\s+[A-Za-z_][A-Za-z0-9_]*\s+in\b/,
  /\binquirer\b/i,
  /\bprompt\s*\(/i,
];

function skillFrontmatter(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== FRONTMATTER_DELIMITER) fail("repository_skills.SKILL.md", "is missing frontmatter");
  const end = lines.indexOf(FRONTMATTER_DELIMITER, 1);
  if (end === -1) fail("repository_skills.SKILL.md", "frontmatter is unterminated");
  return lines.slice(0, end + 1).join("\n");
}

function canonicalContractBlocks(raw: string): string[] {
  const blocks: string[] = [];
  const fence = /```(?:json)?\n([\s\S]*?)```/g;
  for (const match of raw.matchAll(fence)) {
    const body = match[1]!.trim();
    if (CANONICAL_CONTRACT_SCHEMA.test(body)) blocks.push(body);
  }
  return blocks;
}

function immutableSkillLines(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const immutable: string[] = [];
  let currentCraftSection = false;
  for (const line of lines) {
    if (line.startsWith("## ")) currentCraftSection = CRAFT_SECTION.test(line);
    if (!currentCraftSection || COMMAND_OR_TOOL_ALLOWLIST.test(line)) immutable.push(line);
  }
  return immutable;
}

function compareSkillMdImmutableContent(
  pinned: string,
  proposed: string,
  path: string,
  differences: RatchetDifference[]
): void {
  if (skillFrontmatter(pinned) !== skillFrontmatter(proposed)) {
    pushDifference(differences, "skill_immutable_changed", `${path}.frontmatter`);
  }
  if (!sameCanonical(canonicalContractBlocks(pinned), canonicalContractBlocks(proposed))) {
    pushDifference(differences, "skill_immutable_changed", `${path}.canonical_contract_blocks`);
  }
  if (!sameCanonical(immutableSkillLines(pinned), immutableSkillLines(proposed))) {
    pushDifference(differences, "skill_immutable_changed", `${path}.immutable_sections`);
  }
}

function isSkillMd(path: string): boolean {
  return path.endsWith("/SKILL.md") || path === "SKILL.md";
}

function isReferenceFile(path: string): boolean {
  return path.includes("/references/") || path.startsWith("references/");
}

function compareRepositorySkillPackages(
  pinned: RatchetRepositorySkillPackage[],
  proposed: RatchetRepositorySkillPackage[],
  differences: RatchetDifference[]
): void {
  const pinnedById = new Map(pinned.map((skill) => [skill.id, skill]));
  const proposedById = new Map(proposed.map((skill) => [skill.id, skill]));
  for (const pinnedSkill of pinned) {
    const proposedSkill = proposedById.get(pinnedSkill.id);
    if (!proposedSkill) {
      pushDifference(differences, "skill_immutable_changed", `repository_skills.${pinnedSkill.id}`);
      continue;
    }
    const basePath = `repository_skills.${pinnedSkill.id}`;
    if (pinnedSkill.tunable !== proposedSkill.tunable) {
      pushDifference(differences, "skill_immutable_changed", `${basePath}.tunable`);
    }
    if (!pinnedSkill.tunable && !sameCanonical(pinnedSkill, proposedSkill)) {
      pushDifference(differences, "skill_locked", basePath);
      continue;
    }
    const proposedFiles = new Map(proposedSkill.files.map((file) => [file.path, file.content]));
    for (const pinnedFile of pinnedSkill.files) {
      const proposedContent = proposedFiles.get(pinnedFile.path);
      if (proposedContent === undefined) {
        pushDifference(differences, "skill_immutable_changed", `${basePath}.files.${pinnedFile.path}`);
        continue;
      }
      if (isSkillMd(pinnedFile.path)) {
        compareSkillMdImmutableContent(pinnedFile.content, proposedContent, `${basePath}.SKILL.md`, differences);
      } else if (!isReferenceFile(pinnedFile.path) && pinnedFile.content !== proposedContent) {
        pushDifference(differences, "skill_immutable_changed", `${basePath}.files.${pinnedFile.path}`);
      }
    }
  }
  for (const proposedSkill of proposed) {
    const pinnedSkill = pinnedById.get(proposedSkill.id);
    if (!pinnedSkill) {
      pushDifference(differences, "skill_immutable_changed", `repository_skills.${proposedSkill.id}`);
    }
    const pinnedPaths = new Set(pinnedSkill?.files.map((file) => file.path) ?? []);
    for (const file of proposedSkill.files) {
      const path = `repository_skills.${proposedSkill.id}.files.${file.path}`;
      if (!pinnedPaths.has(file.path) && !isReferenceFile(file.path)) {
        pushDifference(differences, "skill_immutable_changed", path);
      }
      if (Buffer.byteLength(file.content, "utf8") > SKILL_FILE_MAX_BYTES) {
        pushDifference(differences, "skill_bounds_exceeded", path);
      }
      for (const token of FORBIDDEN_SKILL_TOKENS) {
        if (token.test(file.content)) uniqueDifference(differences, "skill_forbidden_token", path);
      }
    }
    const packageBytes = proposedSkill.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
    if (packageBytes > SKILL_PACKAGE_MAX_BYTES) {
      pushDifference(differences, "skill_bounds_exceeded", `repository_skills.${proposedSkill.id}`);
    }
  }
}

function commandPhases(graph: GraphContract): Map<string, readonly string[]> {
  const phases = new Map<string, readonly string[]>();
  for (const node of graph.nodes) {
    for (const [index, phase] of (node.phases ?? []).entries()) {
      if (phase.kind === "command") phases.set(`${node.id}.phases[${index}]`, phase.commands ?? []);
    }
    if (node.kind === "command" && node.command) phases.set(`${node.id}.command`, [node.command]);
  }
  return phases;
}

function graphWithoutComparablePolicyFields(graph: GraphContract): unknown {
  return {
    ...graph,
    workers: graph.workers.map((worker) => ({ ...worker, credentials: [], allowed_mcp_servers: [] })),
    loops: graph.loops.map((loop) => ({ ...loop, max_rounds: 1, timeout_seconds: 1 })),
    nodes: graph.nodes.map((node) => ({
      ...node,
      command: node.kind === "command" ? "" : node.command,
      phases: node.phases?.map((phase) => ({
        ...phase,
        commands: phase.kind === "command" ? [] : phase.commands,
      })),
    })),
  };
}

function compareGraphPolicy(
  pinned: GraphContract,
  proposed: GraphContract,
  differences: RatchetDifference[]
): void {
  const proposedWorkers = new Map(proposed.workers.map((worker) => [worker.id, worker]));
  for (const worker of pinned.workers) {
    const proposedWorker = proposedWorkers.get(worker.id);
    if (!proposedWorker) {
      pushDifference(differences, "unknown_policy_change", `graph.workers.${worker.id}`);
      continue;
    }
    if (!isSubset(proposedWorker.credentials, worker.credentials)) {
      pushDifference(differences, "credential_scope_expanded", `graph.workers.${worker.id}.credentials`);
    }
    if (!isSubset(proposedWorker.allowed_mcp_servers, worker.allowed_mcp_servers)) {
      pushDifference(differences, "mcp_scope_expanded", `graph.workers.${worker.id}.allowed_mcp_servers`);
    }
    const pinnedComparable = { ...worker, credentials: [], allowed_mcp_servers: [] };
    const proposedComparable = { ...proposedWorker, credentials: [], allowed_mcp_servers: [] };
    if (!sameCanonical(pinnedComparable, proposedComparable)) {
      pushDifference(differences, "unknown_policy_change", `graph.workers.${worker.id}`);
    }
  }
  for (const worker of proposed.workers) {
    if (!pinned.workers.some((pinnedWorker) => pinnedWorker.id === worker.id)) {
      if (worker.credentials.length > 0) pushDifference(differences, "credential_scope_expanded", `graph.workers.${worker.id}.credentials`);
      if (worker.allowed_mcp_servers.length > 0) pushDifference(differences, "mcp_scope_expanded", `graph.workers.${worker.id}.allowed_mcp_servers`);
    }
  }

  const proposedLoops = new Map(proposed.loops.map((loop) => [loop.id, loop]));
  for (const loop of pinned.loops) {
    const proposedLoop = proposedLoops.get(loop.id);
    if (!proposedLoop) {
      pushDifference(differences, "gate_weakened", `graph.loops.${loop.id}`);
      continue;
    }
    compareResourceLimit(loop.max_rounds, proposedLoop.max_rounds, `graph.loops.${loop.id}.max_rounds`, differences);
    compareResourceLimit(loop.timeout_seconds, proposedLoop.timeout_seconds, `graph.loops.${loop.id}.timeout_seconds`, differences);
    const pinnedComparable = { ...loop, max_rounds: 1, timeout_seconds: 1 };
    const proposedComparable = { ...proposedLoop, max_rounds: 1, timeout_seconds: 1 };
    if (!sameCanonical(pinnedComparable, proposedComparable)) {
      pushDifference(differences, "unknown_policy_change", `graph.loops.${loop.id}`);
    }
  }

  const proposedCommandPhases = commandPhases(proposed);
  for (const [path, commands] of commandPhases(pinned)) {
    const proposedCommands = proposedCommandPhases.get(path);
    if (!proposedCommands || !isSubset(commands, proposedCommands)) {
      pushDifference(differences, "gate_weakened", `graph.nodes.${path}`);
    }
  }

  if (!sameCanonical(graphWithoutComparablePolicyFields(pinned), graphWithoutComparablePolicyFields(proposed))) {
    pushDifference(differences, "incomparable_policy_change", "graph");
  }
}

function parseOptionalConfig(
  value: unknown,
  source: string
): RepositoryConfigContract | undefined {
  return value === undefined ? undefined : validateRepositoryConfigContract(value, { source }).value;
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

function parseRepositorySkillPackageFile(value: unknown, path: string): RatchetRepositorySkillPackageFile {
  const input = objectAt(value, path, ["path", "content"]);
  return {
    path: stringAt(input.path, `${path}.path`, { max: 320, pattern: SKILL_PATH }),
    content: stringAt(input.content, `${path}.content`, { max: SKILL_PACKAGE_MAX_BYTES }),
  };
}

function parseRepositorySkillPackage(value: unknown, path: string): RatchetRepositorySkillPackage {
  const input = objectAt(value, path, ["id", "tunable", "files"]);
  const skill: RatchetRepositorySkillPackage = {
    id: stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER }),
    tunable: booleanAt(input.tunable, `${path}.tunable`),
    files: arrayAt(input.files, `${path}.files`, parseRepositorySkillPackageFile, { min: 1, max: 64 }),
  };
  unique(skill.files.map((file) => file.path), `${path}.files.path`);
  if (!skill.files.some((file) => isSkillMd(file.path))) {
    fail(`${path}.files`, "must include SKILL.md");
  }
  const packageBytes = skill.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
  if (packageBytes > SKILL_PACKAGE_MAX_BYTES) fail(path, `must contain at most ${SKILL_PACKAGE_MAX_BYTES} UTF-8 bytes`);
  return skill;
}

function parseRepositorySkillPackageList(value: unknown, path: string): RatchetRepositorySkillPackage[] {
  const skills = arrayAt(value, path, parseRepositorySkillPackage, { max: 32 });
  unique(skills.map((skill) => skill.id), path);
  return skills;
}

export function validateRatchetDifferentialInput(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<RatchetDifferentialInput> {
  const source = options.source ?? "ratchet_contract";
  const input = objectAt(value, source, [
    "schema", "id", "pinned", "proposed", "pinned_config", "proposed_config", "pinned_graph", "proposed_graph",
    "pinned_repository_skills", "proposed_repository_skills", "human_authority", "tuner_authority",
  ]);
  if (input.schema !== RATCHET_CONTRACT_SCHEMA) fail(`${source}.schema`, `must be ${RATCHET_CONTRACT_SCHEMA}`);
  const pinnedConfig = parseOptionalConfig(input.pinned_config, `${source}.pinned_config`);
  const proposedConfig = parseOptionalConfig(input.proposed_config, `${source}.proposed_config`);
  const contract: RatchetDifferentialInput = {
    schema: RATCHET_CONTRACT_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
    pinned: parseArtifactList(input.pinned, `${source}.pinned`),
    proposed: parseArtifactList(input.proposed, `${source}.proposed`),
    ...(pinnedConfig === undefined ? {} : { pinned_config: pinnedConfig }),
    ...(proposedConfig === undefined ? {} : { proposed_config: proposedConfig }),
    ...(input.pinned_graph === undefined ? {} : {
      pinned_graph: validateGraphContract(input.pinned_graph, {
        source: `${source}.pinned_graph`,
        config: pinnedConfig,
      }).value,
    }),
    ...(input.proposed_graph === undefined ? {} : {
      proposed_graph: validateGraphContract(input.proposed_graph, {
        source: `${source}.proposed_graph`,
        config: proposedConfig,
      }).value,
    }),
    ...(input.pinned_repository_skills === undefined ? {} : {
      pinned_repository_skills: parseRepositorySkillPackageList(
        input.pinned_repository_skills,
        `${source}.pinned_repository_skills`
      ),
    }),
    ...(input.proposed_repository_skills === undefined ? {} : {
      proposed_repository_skills: parseRepositorySkillPackageList(
        input.proposed_repository_skills,
        `${source}.proposed_repository_skills`
      ),
    }),
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
  if (Boolean(contract.pinned_config) !== Boolean(contract.proposed_config)) {
    pushDifference(differences, "unknown_policy_change", "config");
  } else if (contract.pinned_config && contract.proposed_config) {
    compareRepositoryConfigPolicy(contract.pinned_config, contract.proposed_config, differences);
  }
  if (Boolean(contract.pinned_graph) !== Boolean(contract.proposed_graph)) {
    pushDifference(differences, "unknown_policy_change", "graph");
  } else if (contract.pinned_graph && contract.proposed_graph) {
    compareGraphPolicy(contract.pinned_graph, contract.proposed_graph, differences);
  }
  if (Boolean(contract.pinned_repository_skills) !== Boolean(contract.proposed_repository_skills)) {
    pushDifference(differences, "skill_immutable_changed", "repository_skills");
  } else if (contract.pinned_repository_skills && contract.proposed_repository_skills) {
    compareRepositorySkillPackages(
      contract.pinned_repository_skills,
      contract.proposed_repository_skills,
      differences
    );
  }

  const reject_reasons = [...new Set(differences.map((difference) => difference.reason))];
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
      const difference = objectAt(entry, entryPath, ["reason", "artifact_id", "path"]);
      return {
        reason: enumAt(difference.reason, `${entryPath}.reason`, RATCHET_REJECTION_REASONS),
        ...(difference.artifact_id === undefined ? {} : {
          artifact_id: stringAt(difference.artifact_id, `${entryPath}.artifact_id`, { pattern: IDENTIFIER }),
        }),
        ...(difference.path === undefined ? {} : {
          path: stringAt(difference.path, `${entryPath}.path`, { max: 300 }),
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
