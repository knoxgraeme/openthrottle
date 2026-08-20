import {
  EXECUTION_PLAN_SCHEMA_V2,
  canonicalJson,
  digestNormalized,
  validateGraphContract,
  type RepositoryConfigContract,
  type RatchetFileSnapshot,
  type RatchetRepositorySkillPackage,
  type TuneProposal,
} from "@openthrottle/contracts";
import { parseRepositoryConfig } from "./manifest.js";

function fileMap(files: RatchetFileSnapshot[], label: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of files) {
    if (map.has(file.path)) throw new Error(`${label} repeats ${file.path}`);
    map.set(file.path, file.content);
  }
  return map;
}

function flattenedSkillFiles(packages: RatchetRepositorySkillPackage[], label: string): RatchetFileSnapshot[] {
  const files: RatchetFileSnapshot[] = [];
  const paths = new Set<string>();
  for (const skill of packages) {
    for (const file of skill.files) {
      if (paths.has(file.path)) throw new Error(`${label} repeats ${file.path}`);
      paths.add(file.path);
      files.push(file);
    }
  }
  return files;
}

function sortedFiles(files: RatchetFileSnapshot[]): RatchetFileSnapshot[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path));
}

function assertExactChangeSet(proposal: TuneProposal, pinned: Map<string, string>, proposed: Map<string, string>): void {
  const expected = [...new Set([...pinned.keys(), ...proposed.keys()])]
    .sort()
    .flatMap((path) => {
      const before = pinned.get(path);
      const after = proposed.get(path);
      if (before === after) return [];
      return [{
        path,
        operation: before === undefined ? "add" : after === undefined ? "delete" : "modify",
        before_digest: before === undefined ? null : digestNormalized(before),
        after_digest: after === undefined ? null : digestNormalized(after),
        after_content: after ?? null,
      }];
    });
  const actual = proposal.changes
    .map(({ rationale: _rationale, ...change }) => change)
    .sort((left, right) => left.path.localeCompare(right.path));
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("tune proposal changes do not exactly match the ratchet file material");
  }
}

function assertTargetBaseline(proposal: TuneProposal, pinned: Map<string, string>): string {
  const targetPath = proposal.target.path;
  if (!targetPath) throw new Error("tune mutation target requires an exact repository path");
  const content = pinned.get(targetPath);
  if (content === undefined || digestNormalized(content) !== proposal.target.digest) {
    throw new Error("tune ratchet pinned material does not match the supervisor-sealed target digest");
  }
  return targetPath;
}

/**
 * Proves that the deterministic ratchet evaluated the exact bytes later
 * carried by the edit authorization. Agent-authored ratchet structure is not
 * authority until this binding succeeds.
 */
export function assertTuneRatchetMaterialBinding(
  proposal: TuneProposal,
  options: { repositoryConfig?: RepositoryConfigContract } = {}
): void {
  const ratchet = proposal.ratchet_input;
  if (!ratchet.pinned_files || !ratchet.proposed_files) {
    throw new Error("tune ratchet requires paired exact pinned_files and proposed_files material");
  }
  const pinned = fileMap(ratchet.pinned_files, "tune ratchet pinned_files");
  const proposed = fileMap(ratchet.proposed_files, "tune ratchet proposed_files");
  const targetPath = assertTargetBaseline(proposal, pinned);
  assertExactChangeSet(proposal, pinned, proposed);

  if (proposal.target.kind === "skill") {
    if (!ratchet.pinned_repository_skills || !ratchet.proposed_repository_skills) {
      throw new Error("skill tune ratchet requires paired repository skill packages");
    }
    const packageRoot = `.openthrottle/skills/${proposal.target.id}/`;
    if (!proposal.changes.every((change) => change.path.startsWith(packageRoot))) {
      throw new Error("skill tune changes must stay within the sealed target skill package");
    }
    if (!ratchet.pinned_repository_skills.some((skill) => skill.id === proposal.target.id) ||
        !ratchet.proposed_repository_skills.some((skill) => skill.id === proposal.target.id)) {
      throw new Error("skill tune ratchet is missing the sealed target skill package");
    }
    if (!options.repositoryConfig || !ratchet.pinned_config || !ratchet.proposed_config ||
        canonicalJson(ratchet.pinned_config) !== canonicalJson(options.repositoryConfig) ||
        canonicalJson(ratchet.proposed_config) !== canonicalJson(options.repositoryConfig)) {
      throw new Error("skill tune ratchet config does not match the supervisor-pinned repository config");
    }
    const configuredSkill = options.repositoryConfig.skills?.find((skill) => skill.id === proposal.target.id);
    if (!configuredSkill || configuredSkill.path !== `.openthrottle/skills/${proposal.target.id}` ||
        configuredSkill.tunable === false) {
      throw new Error("skill tune target is not an unlocked skill in the supervisor-pinned repository config");
    }
    const pinnedSkillFiles = flattenedSkillFiles(ratchet.pinned_repository_skills, "pinned repository skills");
    const proposedSkillFiles = flattenedSkillFiles(ratchet.proposed_repository_skills, "proposed repository skills");
    if (canonicalJson(sortedFiles(pinnedSkillFiles)) !== canonicalJson(sortedFiles(ratchet.pinned_files)) ||
        canonicalJson(sortedFiles(proposedSkillFiles)) !== canonicalJson(sortedFiles(ratchet.proposed_files))) {
      throw new Error("skill tune ratchet packages do not match the exact file material");
    }
    return;
  }

  if (pinned.size !== 1 || proposed.size !== 1 || !proposed.has(targetPath)) {
    throw new Error("config and graph tune ratchets must bind exactly the sealed target file");
  }
  if (proposal.target.kind === "contract") {
    if (!ratchet.pinned_config || !ratchet.proposed_config) {
      throw new Error("repository-config tune ratchet requires paired config contracts");
    }
    if (canonicalJson(parseRepositoryConfig(pinned.get(targetPath)!, targetPath).config) !== canonicalJson(ratchet.pinned_config) ||
        canonicalJson(parseRepositoryConfig(proposed.get(targetPath)!, targetPath).config) !== canonicalJson(ratchet.proposed_config)) {
      throw new Error("repository-config tune ratchet contracts do not match the exact file material");
    }
    return;
  }
  if (proposal.target.kind === "graph") {
    if (!ratchet.pinned_graph || !ratchet.proposed_graph) {
      throw new Error("graph tune ratchet requires paired graph contracts");
    }
    const pinnedGraph = validateGraphContract(JSON.parse(pinned.get(targetPath)!) as unknown, {
      source: `${targetPath}.pinned`,
      config: ratchet.pinned_config,
    }).value;
    const proposedGraph = validateGraphContract(JSON.parse(proposed.get(targetPath)!) as unknown, {
      source: `${targetPath}.proposed`,
      config: ratchet.proposed_config,
    }).value;
    if (canonicalJson(pinnedGraph) !== canonicalJson(ratchet.pinned_graph) ||
        canonicalJson(proposedGraph) !== canonicalJson(ratchet.proposed_graph)) {
      throw new Error("graph tune ratchet contracts do not match the exact file material");
    }
    return;
  }
  throw new Error(`tune mutations for ${proposal.target.kind} targets have no deterministic policy ratchet`);
}

export function executionPlanForTuneProposal(proposal: TuneProposal) {
  return {
    schema: EXECUTION_PLAN_SCHEMA_V2,
    pipeline_id: "core/structured",
    plan_id: `tune-${proposal.id}`,
    units: [{
      id: "approved_tune_change",
      title: `Apply approved tune proposal ${proposal.id}`,
      depends_on: [],
      objective: "Apply exactly the supervisor-approved tune material.",
      requirements: [
        "Apply every authorized change from the sealed openthrottle.tune-change-material/v1 contract. " +
          "Use each exact after_content byte sequence; do not reconstruct content from a digest or rationale.",
      ],
      files: [...new Set(proposal.changes.map((change) => change.path))],
      approach: [
        "Read the sealed tune edit verification payload and apply only the authorized changed bytes.",
      ],
      tests: [
        "Run the configured deterministic command gates for the structured graph.",
      ],
      acceptance: [
        "The exact sealed tune material is applied and deterministic command and review gates pass.",
      ],
      verification: [
        "The executor verifies the tune edit authorization and command receipts before integration.",
      ],
    }],
    commands: [{ name: "test" }, { name: "build" }],
  };
}
