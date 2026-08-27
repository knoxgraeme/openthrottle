import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KERNEL_CHECKPOINT_ANCESTRY_MAX_ENTRIES,
  validateKernelCheckpointAncestryChain,
} from "../pipeline/kernel/checkpoint-ancestry.js";

export interface KernelGitBundleDescriptor {
  ref: string;
  commit: string;
  tree: string;
  parents: readonly string[];
}

interface SealedBundleDescriptor {
  ref: string;
  commit: string;
  tree: string;
}

interface KernelIntegrationAncestryBundle {
  checkpoint_id: string;
  bytes: Uint8Array;
  descriptor: SealedBundleDescriptor;
  input_subject: string;
  output_subject: string;
}

export function inspectKernelCheckpointBundleAdvertisement(input: {
  bytes: Uint8Array;
  expected_commit: string;
}): { ref: string; commit: string } {
  subject(input.expected_commit, "checkpoint advertised commit");
  const scratch = mkdtempSync(join(tmpdir(), "openthrottle-kernel-bundle-head-"));
  const bundle = join(scratch, "checkpoint.bundle");
  try {
    writeFileSync(bundle, input.bytes, { mode: 0o400 });
    return exactAdvertisedBundleHead({
      repository: scratch,
      bundle,
      expected_commit: input.expected_commit,
      allowed_ref: CHECKPOINT_REF,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const SUBJECT = /^[a-f0-9]{40,64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CHECKPOINT_REF = /^refs\/openthrottle\/(?:checkpoints|integrations)\/[a-f0-9]{64}$/;
const INTEGRATION_REF = /^refs\/openthrottle\/integrations\/[a-f0-9]{64}$/;
const ORDINARY_CHECKPOINT_REF_PREFIX = "refs/openthrottle/checkpoints/";
const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "OpenThrottle Executor",
  GIT_AUTHOR_EMAIL: "executor@openthrottle.local",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "OpenThrottle Executor",
  GIT_COMMITTER_EMAIL: "executor@openthrottle.local",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};
const SCRATCH_GIT_CONFIG = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
  ["gc.autodetach", "false"],
  ["core.fsmonitor", "false"],
] as const;

export function ordinaryCheckpointRefForCommit(commit: string): string {
  subject(commit, "ordinary checkpoint commit");
  return `${ORDINARY_CHECKPOINT_REF_PREFIX}${createHash("sha256")
    .update(commit, "utf8")
    .digest("hex")}`;
}

export function isCompatibleOrdinaryCheckpointRef(input: {
  ref: string;
  commit: string;
  request_hash: string;
}): boolean {
  if (
    !SUBJECT.test(input.commit) || !DIGEST.test(input.request_hash) ||
    !input.ref.startsWith(ORDINARY_CHECKPOINT_REF_PREFIX)
  ) return false;
  return input.ref === ordinaryCheckpointRefForCommit(input.commit) ||
    input.ref === `${ORDINARY_CHECKPOINT_REF_PREFIX}${input.request_hash}`;
}

function gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_")) delete environment[key];
  }
  const isolated: NodeJS.ProcessEnv = {
    ...environment,
    ...extra,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: String(SCRATCH_GIT_CONFIG.length),
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const [index, [key, value]] of SCRATCH_GIT_CONFIG.entries()) {
    isolated[`GIT_CONFIG_KEY_${index}`] = key;
    isolated[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return isolated;
}

function spawnGit(cwd: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
    env: gitEnvironment(extraEnv),
  });
}

function git(cwd: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  const result = spawnGit(cwd, args, extraEnv);
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || "git command failed").slice(-1_000);
    throw new Error(`checkpoint bundle verification failed: ${detail}`);
  }
  return result.stdout.trim();
}

function exactAdvertisedBundleHead(input: {
  repository: string;
  bundle: string;
  expected_commit: string;
  allowed_ref: RegExp;
}): { ref: string; commit: string } {
  const heads = git(input.repository, ["bundle", "list-heads", input.bundle])
    .split("\n").filter(Boolean);
  if (heads.length !== 1) throw new Error("checkpoint bundle must advertise exactly one sealed ref");
  const [commit, ref, ...extra] = heads[0]!.trim().split(/\s+/);
  if (
    extra.length !== 0 || commit !== input.expected_commit || !ref || !input.allowed_ref.test(ref)
  ) throw new Error("checkpoint bundle does not advertise its exact sealed ref and commit");
  return { ref, commit };
}

function isAncestor(repository: string, ancestor: string, descendant: string): boolean {
  const result = spawnGit(repository, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (!result.error && (result.status === 0 || result.status === 1)) return result.status === 0;
  const detail = String(result.stderr || result.error?.message || "git command failed").slice(-1_000);
  throw new Error(`checkpoint bundle verification failed: ${detail}`);
}

function hasCommit(repository: string, commit: string): boolean {
  const result = spawnGit(repository, ["cat-file", "-e", `${commit}^{commit}`]);
  if (!result.error && result.status === 0) return true;
  if (!result.error && result.status !== null && result.status > 0) return false;
  const detail = String(result.stderr || result.error?.message || "git command failed").slice(-1_000);
  throw new Error(`checkpoint bundle verification failed: ${detail}`);
}

function subject(value: string, label: string): string {
  if (!SUBJECT.test(value)) throw new Error(`${label} has an invalid Git identity`);
  return value;
}

function seedShallowBoundaries(repository: string, boundaries: readonly string[]): void {
  for (const boundary of boundaries) subject(boundary, "checkpoint shallow boundary");
  writeFileSync(
    join(repository, "shallow"),
    `${[...new Set(boundaries)].sort().join("\n")}\n`,
    { mode: 0o600 },
  );
}

function inspectBundleInRepository(input: {
  repository: string;
  bundle: string;
  expected_commit: string;
  expected_tree?: string;
  expected_parent?: string;
  allowed_ref: RegExp;
}): KernelGitBundleDescriptor {
  const { commit, ref } = exactAdvertisedBundleHead(input);
  git(input.repository, ["bundle", "verify", input.bundle]);
  git(input.repository, ["fetch", "--quiet", "--no-tags", input.bundle, ref]);
  const tree = git(input.repository, ["rev-parse", `${commit}^{tree}`]);
  if (!SUBJECT.test(tree)) throw new Error("checkpoint bundle has an invalid Git tree");
  if (input.expected_tree !== undefined && tree !== input.expected_tree) {
    throw new Error("checkpoint bundle commit does not contain its exact accepted tree");
  }
  const revision = git(input.repository, ["rev-list", "--parents", "-n", "1", commit])
    .split(/\s+/).filter(Boolean);
  if (revision.shift() !== commit || revision.some((parent) => !SUBJECT.test(parent))) {
    throw new Error("checkpoint bundle commit has invalid parent evidence");
  }
  const parents = revision;
  if (
    input.expected_parent !== undefined &&
    (parents.length !== 1 || parents[0] !== input.expected_parent)
  ) {
    throw new Error(
      `checkpoint bundle commit does not have ${input.expected_parent} as its exact sole parent`,
    );
  }
  return { ref, commit, tree, parents };
}

/** Verifies one bounded Git bundle from its exact shallow input boundary. */
export function inspectKernelCheckpointBundle(input: {
  bytes: Uint8Array;
  expected_commit: string;
  expected_tree?: string;
  shallow_boundary?: string;
  expected_parent?: string;
  required_ancestor?: string;
  required_descendant?: string;
  allowed_ref: RegExp;
}): KernelGitBundleDescriptor {
  subject(input.expected_commit, "checkpoint expected commit");
  if (input.shallow_boundary !== undefined) {
    subject(input.shallow_boundary, "checkpoint shallow boundary");
  }
  if (input.expected_tree !== undefined) subject(input.expected_tree, "checkpoint expected tree");
  if (input.expected_parent !== undefined) subject(input.expected_parent, "checkpoint expected parent");
  if ((input.required_ancestor === undefined) !== (input.required_descendant === undefined)) {
    throw new Error("checkpoint bundle ancestry verification requires both endpoints");
  }
  if (input.required_ancestor !== undefined) {
    subject(input.required_ancestor, "checkpoint required ancestor");
    subject(input.required_descendant!, "checkpoint required descendant");
  }
  const scratch = mkdtempSync(join(tmpdir(), "openthrottle-kernel-bundle-"));
  const repository = join(scratch, "verify.git");
  const bundle = join(scratch, "checkpoint.bundle");
  try {
    writeFileSync(bundle, input.bytes, { mode: 0o400 });
    git(scratch, ["init", "--quiet", "--bare", repository]);
    if (input.shallow_boundary !== undefined) {
      seedShallowBoundaries(repository, [input.shallow_boundary]);
    }
    const inspected = inspectBundleInRepository({
      repository,
      bundle,
      expected_commit: input.expected_commit,
      expected_tree: input.expected_tree,
      expected_parent: input.expected_parent,
      allowed_ref: input.allowed_ref,
    });
    if (
      input.shallow_boundary !== undefined &&
      input.expected_commit === input.shallow_boundary && inspected.parents.length !== 0
    ) {
      throw new Error("identity checkpoint bundle exposed parents beyond its sealed shallow boundary");
    }
    if (
      input.required_ancestor !== undefined &&
      (
        !hasCommit(repository, input.required_ancestor) ||
        !hasCommit(repository, input.required_descendant!) ||
        !isAncestor(repository, input.required_ancestor, input.required_descendant!)
      )
    ) throw new Error("checkpoint bundle does not prove its required exact ancestry");
    return inspected;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function syntheticCommit(
  repository: string,
  tree: string,
  parent: string | null,
  message: string,
): string {
  return git(repository, [
    "commit-tree", tree,
    ...(parent === null ? [] : ["-p", parent]),
    "-m", message,
  ], AUTHOR_ENV);
}

function recomputeMergeTree(repository: string, baseTree: string, currentTree: string, candidateTree: string): string {
  const base = syntheticCommit(repository, baseTree, null, "OpenThrottle integration merge base");
  const current = syntheticCommit(repository, currentTree, base, "OpenThrottle integration current");
  const candidate = syntheticCommit(repository, candidateTree, base, "OpenThrottle integration candidate");
  const output = git(repository, ["merge-tree", "--write-tree", current, candidate]);
  return subject(output.split(/\s+/)[0] ?? "", "recomputed integration tree");
}

/**
 * Recomputes a sandbox-authored integration from the sealed current and
 * candidate bundles before the result bytes may be promoted to BlobStore.
 */
export function inspectKernelIntegrationBundle(input: {
  bytes: Uint8Array;
  descriptor: SealedBundleDescriptor;
  checkpoint_base_subject: string;
  current_subject: string;
  candidate_bytes: Uint8Array;
  candidate_descriptor: SealedBundleDescriptor;
  candidate_input_subject: string;
  candidate_output_subject: string;
  current_ancestry: readonly KernelIntegrationAncestryBundle[];
}): KernelGitBundleDescriptor {
  for (const [value, label] of [
    [input.descriptor.commit, "integration output commit"],
    [input.descriptor.tree, "integration output tree"],
    [input.checkpoint_base_subject, "integration checkpoint base"],
    [input.current_subject, "integration current subject"],
    [input.candidate_descriptor.commit, "integration candidate commit"],
    [input.candidate_descriptor.tree, "integration candidate tree"],
    [input.candidate_input_subject, "integration candidate input"],
    [input.candidate_output_subject, "integration candidate output"],
  ] as const) subject(value, label);
  if (
    input.candidate_descriptor.commit !== input.candidate_output_subject ||
    !CHECKPOINT_REF.test(input.candidate_descriptor.ref) ||
    !INTEGRATION_REF.test(input.descriptor.ref)
  ) throw new Error("integration bundle changed its sealed candidate or ref identity");
  if (
    !Array.isArray(input.current_ancestry) ||
    input.current_ancestry.length > KERNEL_CHECKPOINT_ANCESTRY_MAX_ENTRIES
  ) throw new Error("integration current ancestry proof exceeds its bounded entry limit");

  const scratch = mkdtempSync(join(tmpdir(), "openthrottle-kernel-integration-bundle-"));
  const repository = join(scratch, "verify.git");
  const candidateBundle = join(scratch, "candidate.bundle");
  const outputBundle = join(scratch, "integration.bundle");
  try {
    writeFileSync(candidateBundle, input.candidate_bytes, { mode: 0o400 });
    writeFileSync(outputBundle, input.bytes, { mode: 0o400 });
    git(scratch, ["init", "--quiet", "--bare", repository]);
    seedShallowBoundaries(repository, [input.checkpoint_base_subject]);
    const candidate = inspectBundleInRepository({
      repository,
      bundle: candidateBundle,
      expected_commit: input.candidate_output_subject,
      expected_tree: input.candidate_descriptor.tree,
      expected_parent: input.candidate_output_subject === input.candidate_input_subject
        ? undefined
        : input.candidate_input_subject,
      allowed_ref: CHECKPOINT_REF,
    });
    if (candidate.ref !== input.candidate_descriptor.ref) {
      throw new Error("integration candidate bundle changed its exact sealed ref");
    }
    if (
      input.candidate_output_subject === input.candidate_input_subject &&
      input.candidate_output_subject === input.checkpoint_base_subject &&
      candidate.parents.length !== 0
    ) throw new Error("base identity integration candidate crossed its shallow boundary");
    if (!isAncestor(
      repository,
      input.checkpoint_base_subject,
      input.candidate_input_subject,
    )) throw new Error("integration candidate does not descend from its sealed checkpoint base");

    const ancestryRefs = new Set<string>();
    const ancestryCommits = new Set<string>();
    for (const edge of input.current_ancestry) {
      if (
        typeof edge.checkpoint_id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(edge.checkpoint_id)
      ) throw new Error("integration current ancestry proof has an invalid checkpoint ID");
      for (const [value, label] of [
        [edge.descriptor.commit, "current ancestry commit"],
        [edge.descriptor.tree, "current ancestry tree"],
        [edge.input_subject, "current ancestry input"],
        [edge.output_subject, "current ancestry output"],
      ] as const) subject(value, label);
      if (
        edge.descriptor.commit !== edge.output_subject ||
        !INTEGRATION_REF.test(edge.descriptor.ref)
      ) throw new Error("integration current ancestry proof contains a gap or invalid edge identity");
      if (
        ancestryRefs.has(edge.descriptor.ref) ||
        ancestryCommits.has(edge.descriptor.commit)
      ) throw new Error("integration current ancestry proof contains duplicate edge evidence");
      ancestryRefs.add(edge.descriptor.ref);
      ancestryCommits.add(edge.descriptor.commit);
    }
    const currentAncestryStarts = [...new Set(
      input.current_ancestry
        .filter((edge) => !ancestryCommits.has(edge.input_subject))
        .map((edge) => edge.input_subject),
    )];
    if (input.current_ancestry.length > 0 && currentAncestryStarts.length !== 1) {
      throw new Error("integration current ancestry proof must contain one connected start");
    }
    const currentAncestryStart = currentAncestryStarts[0];
    if (
      currentAncestryStart !== undefined &&
      currentAncestryStart !== input.candidate_input_subject &&
      currentAncestryStart !== input.checkpoint_base_subject
    ) {
      throw new Error(
        "integration current ancestry proof must start at the candidate input or checkpoint base",
      );
    }
    const currentAncestry = currentAncestryStart === undefined
      ? []
      : validateKernelCheckpointAncestryChain({
        entries: input.current_ancestry,
        start_subject: currentAncestryStart,
        end_subject: input.current_subject,
        label: "integration current ancestry proof",
      });
    for (const [index, edge] of currentAncestry.entries()) {
      const ancestryBundle = join(scratch, `current-ancestry-${index}.bundle`);
      writeFileSync(ancestryBundle, edge.bytes, { mode: 0o400 });
      const inspected = inspectBundleInRepository({
        repository,
        bundle: ancestryBundle,
        expected_commit: edge.output_subject,
        expected_tree: edge.descriptor.tree,
        expected_parent: edge.input_subject,
        allowed_ref: INTEGRATION_REF,
      });
      if (inspected.ref !== edge.descriptor.ref) {
        throw new Error("integration current ancestry bundle changed its exact sealed ref");
      }
    }
    const currentExists = hasCommit(repository, input.current_subject);
    const currentIsDirect =
      input.current_subject === input.candidate_output_subject ||
      input.current_subject === input.candidate_input_subject;
    const currentIsCandidateAncestor = !currentIsDirect && currentExists && isAncestor(
      repository,
      input.current_subject,
      input.candidate_input_subject,
    );
    const candidateInputIsCurrentAncestor = !currentIsDirect && currentExists && isAncestor(
      repository,
      input.candidate_input_subject,
      input.current_subject,
    );
    const currentIsDirectOrCandidateAncestor = currentIsDirect || currentIsCandidateAncestor;
    if (currentIsDirectOrCandidateAncestor && currentAncestry.length > 0) {
      throw new Error("integration current ancestry proof contains unnecessary extra edges");
    }
    if (!currentIsDirectOrCandidateAncestor && currentAncestry.length === 0) {
      throw new Error("integration stale current ancestry proof is missing");
    }
    if (!currentExists) {
      throw new Error("integration current ancestry proof did not materialize its sealed current subject");
    }
    if (!isAncestor(repository, input.checkpoint_base_subject, input.current_subject)) {
      throw new Error("integration current does not descend from its sealed checkpoint base");
    }
    if (
      currentAncestry.length > 0 &&
      candidateInputIsCurrentAncestor &&
      currentAncestryStart !== input.candidate_input_subject
    ) {
      throw new Error("integration current ancestry suffix must start at the candidate input");
    }
    if (
      currentAncestry.length > 0 &&
      !candidateInputIsCurrentAncestor &&
      currentAncestryStart !== input.checkpoint_base_subject
    ) {
      throw new Error("integration sibling current ancestry proof must start at the checkpoint base");
    }

    seedShallowBoundaries(repository, [
      input.checkpoint_base_subject,
      input.current_subject,
    ]);
    const output = inspectBundleInRepository({
      repository,
      bundle: outputBundle,
      expected_commit: input.descriptor.commit,
      expected_tree: input.descriptor.tree,
      expected_parent: input.current_subject,
      allowed_ref: INTEGRATION_REF,
    });
    if (output.ref !== input.descriptor.ref) {
      throw new Error("integration output bundle changed its exact sealed ref");
    }
    const currentTree = git(repository, ["rev-parse", `${input.current_subject}^{tree}`]);
    let expectedTree: string;
    let expectedCommit: string;
    if (input.candidate_output_subject === input.current_subject) {
      expectedTree = currentTree;
      expectedCommit = syntheticCommit(
        repository,
        expectedTree,
        input.current_subject,
        "OpenThrottle integrated checkpoint",
      );
    } else if (input.candidate_input_subject === input.current_subject) {
      expectedTree = candidate.tree;
      expectedCommit = syntheticCommit(
        repository,
        expectedTree,
        input.current_subject,
        "OpenThrottle integrated checkpoint",
      );
    } else if (currentIsCandidateAncestor) {
      expectedTree = candidate.tree;
      expectedCommit = syntheticCommit(
        repository,
        expectedTree,
        input.current_subject,
        "OpenThrottle integrated checkpoint",
      );
    } else {
      // The output bundle is shallow at current_subject, so it intentionally
      // cannot re-prove ancestry behind that safe parent. Recompute the exact
      // three-tree merge from the sealed current and candidate trees. A
      // candidate-input suffix retains that exact merge base; divergent unit
      // branches meet only at the stable checkpoint base.
      const mergeBaseSubject = candidateInputIsCurrentAncestor
        ? input.candidate_input_subject
        : input.checkpoint_base_subject;
      const baseTree = git(repository, ["rev-parse", `${mergeBaseSubject}^{tree}`]);
      expectedTree = recomputeMergeTree(repository, baseTree, currentTree, candidate.tree);
      expectedCommit = syntheticCommit(
        repository,
        expectedTree,
        input.current_subject,
        "OpenThrottle integrated checkpoint",
      );
    }
    if (output.tree !== expectedTree || output.commit !== expectedCommit) {
      throw new Error("integration output does not match the recomputed sealed current and candidate");
    }
    return output;
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
