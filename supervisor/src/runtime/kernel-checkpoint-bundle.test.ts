import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectKernelCheckpointBundle,
  inspectKernelIntegrationBundle,
} from "./kernel-checkpoint-bundle.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "ot-kernel-bundle-test-"));
  directories.push(root);
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  execFileSync("git", ["config", "user.name", "Test"], { cwd: work });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: work });
  return work;
}

function git(work: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: work, encoding: "utf8" }).trim();
}

function commit(work: string, contents: string, message: string): string {
  writeFileSync(join(work, "file.txt"), contents);
  execFileSync("git", ["add", "file.txt"], { cwd: work });
  execFileSync("git", ["commit", "-qm", message], { cwd: work });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
}

function bundle(work: string, ref: string, boundary: string, suffix = "checkpoint"): Uint8Array {
  const path = join(work, `${suffix}.bundle`);
  writeFileSync(join(work, ".git", "shallow"), `${boundary}\n`);
  execFileSync("git", ["bundle", "create", path, ref], { cwd: work });
  return readFileSync(path);
}

const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "OpenThrottle Executor",
  GIT_AUTHOR_EMAIL: "executor@openthrottle.local",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "OpenThrottle Executor",
  GIT_COMMITTER_EMAIL: "executor@openthrottle.local",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

function commitTree(work: string, tree: string, parents: readonly string[]): string {
  return execFileSync("git", [
    "commit-tree", tree,
    ...parents.flatMap((parent) => ["-p", parent]),
    "-m", "OpenThrottle integrated checkpoint",
  ], { cwd: work, encoding: "utf8", env: { ...process.env, ...AUTHOR_ENV } }).trim();
}

function staleIntegrationFixture(linkCount = 1) {
  const work = repository();
  const base = commit(work, "base\n", "base");
  execFileSync("git", ["switch", "-q", "-c", "candidate"], { cwd: work });
  writeFileSync(join(work, "candidate.txt"), "candidate\n");
  execFileSync("git", ["add", "candidate.txt"], { cwd: work });
  execFileSync("git", ["commit", "-qm", "candidate"], { cwd: work });
  const candidate = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: work, encoding: "utf8",
  }).trim();
  const candidateTree = execFileSync("git", ["rev-parse", `${candidate}^{tree}`], {
    cwd: work, encoding: "utf8",
  }).trim();
  execFileSync("git", ["switch", "-q", "main"], { cwd: work });
  const currentSubjects: string[] = [];
  const currentTrees: string[] = [];
  for (let index = 0; index < linkCount; index += 1) {
    const path = `current-${index + 1}.txt`;
    writeFileSync(join(work, path), `current ${index + 1}\n`);
    execFileSync("git", ["add", path], { cwd: work });
    execFileSync("git", ["commit", "-qm", `current ${index + 1}`], { cwd: work });
    currentSubjects.push(execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: work, encoding: "utf8",
    }).trim());
    currentTrees.push(execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: work, encoding: "utf8",
    }).trim());
  }
  const current = currentSubjects.at(-1)!;
  const currentTree = currentTrees.at(-1)!;
  const mergedTree = execFileSync("git", ["merge-tree", "--write-tree", current, candidate], {
    cwd: work, encoding: "utf8",
  }).trim().split(/\s+/)[0]!;
  const output = commitTree(work, mergedTree, [current]);
  const candidateRef = `refs/openthrottle/checkpoints/${"c".repeat(64)}`;
  const outputRef = `refs/openthrottle/integrations/${"d".repeat(64)}`;
  execFileSync("git", ["update-ref", candidateRef, candidate], { cwd: work });
  execFileSync("git", ["update-ref", outputRef, output], { cwd: work });
  const candidateBytes = bundle(work, candidateRef, base, "candidate");
  const currentAncestry = currentSubjects.map((subject, index) => {
    const ref = `refs/openthrottle/integrations/${String(index + 1).repeat(64)}`;
    execFileSync("git", ["update-ref", ref, subject], { cwd: work });
    return {
      checkpoint_id: `checkpoint-current-${index + 1}`,
      bytes: bundle(
        work,
        ref,
        index === 0 ? base : currentSubjects[index - 1]!,
        `current-${index + 1}`,
      ),
      descriptor: { ref, commit: subject, tree: currentTrees[index]! },
      input_subject: index === 0 ? base : currentSubjects[index - 1]!,
      output_subject: subject,
    };
  });
  const outputBytes = bundle(work, outputRef, current, "integration");
  return {
    work, base, current, currentTree, candidate, candidateTree, candidateRef,
    output, mergedTree, outputRef, candidateBytes, currentAncestry, outputBytes,
  };
}

function unprovenCurrentFixture(kind: "divergent" | "orphan") {
  const work = repository();
  const source = commit(work, "source\n", "source");
  execFileSync("git", ["switch", "-q", "-c", "candidate"], { cwd: work });
  const candidateInput = commit(work, "candidate input\n", "candidate input");
  writeFileSync(join(work, "candidate.txt"), "candidate output\n");
  execFileSync("git", ["add", "candidate.txt"], { cwd: work });
  execFileSync("git", ["commit", "-qm", "candidate output"], { cwd: work });
  const candidate = git(work, ["rev-parse", "HEAD"]);
  const candidateTree = git(work, ["rev-parse", "HEAD^{tree}"]);
  const candidateInputTree = git(work, ["rev-parse", `${candidateInput}^{tree}`]);
  if (kind === "orphan") {
    execFileSync("git", ["switch", "-q", "--orphan", "current"], { cwd: work });
  } else {
    execFileSync("git", ["switch", "-q", "main"], { cwd: work });
  }
  const current = commit(work, `${kind} current\n`, `${kind} current`);
  const currentTree = git(work, ["rev-parse", "HEAD^{tree}"]);
  const syntheticBase = commitTree(work, candidateInputTree, []);
  const syntheticCurrent = commitTree(work, currentTree, [syntheticBase]);
  const syntheticCandidate = commitTree(work, candidateTree, [syntheticBase]);
  const mergedTree = git(work, ["merge-tree", "--write-tree", syntheticCurrent, syntheticCandidate])
    .split(/\s+/)[0]!;
  const output = commitTree(work, mergedTree, [current]);
  const candidateRef = `refs/openthrottle/checkpoints/${"7".repeat(64)}`;
  const outputRef = `refs/openthrottle/integrations/${"8".repeat(64)}`;
  execFileSync("git", ["update-ref", candidateRef, candidate], { cwd: work });
  execFileSync("git", ["update-ref", outputRef, output], { cwd: work });
  return {
    source,
    current,
    candidateInput,
    candidate,
    candidateTree,
    candidateRef,
    output,
    mergedTree,
    outputRef,
    candidateBytes: bundle(work, candidateRef, source, `${kind}-candidate`),
    outputBytes: bundle(work, outputRef, current, `${kind}-output`),
  };
}

describe("kernel checkpoint bundle inspection", () => {
  it("verifies the bundle with isolated no-background Git configuration", () => {
    const work = repository();
    const parent = commit(work, "base\n", "base");
    const output = commit(work, "changed\n", "changed");
    const tree = execFileSync("git", ["rev-parse", `${output}^{tree}`], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    const ref = `refs/openthrottle/checkpoints/${"a".repeat(64)}`;
    execFileSync("git", ["update-ref", ref, output], { cwd: work });
    const bytes = bundle(work, ref, parent);

    const root = dirname(work);
    const capture = join(root, "git-environment.log");
    const wrapper = join(root, "git");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(wrapper, `#!/bin/sh
printf '%s\\n' "$GIT_CONFIG_COUNT|$GIT_CONFIG_KEY_0=$GIT_CONFIG_VALUE_0|$GIT_CONFIG_KEY_1=$GIT_CONFIG_VALUE_1|$GIT_CONFIG_KEY_2=$GIT_CONFIG_VALUE_2|$GIT_CONFIG_KEY_3=$GIT_CONFIG_VALUE_3" >> ${JSON.stringify(capture)}
exec ${JSON.stringify(realGit)} "$@"
`);
    chmodSync(wrapper, 0o700);
    const keys = [
      "PATH", "GIT_DIR", "GIT_OBJECT_DIRECTORY", "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
    ];
    const original = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${root}:${process.env.PATH ?? ""}`;
    process.env.GIT_DIR = join(work, ".git", "ambient-redirection");
    process.env.GIT_OBJECT_DIRECTORY = join(work, ".git", "ambient-objects");
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
    process.env.GIT_CONFIG_VALUE_0 = join(work, "ambient-hooks");
    try {
      expect(inspectKernelCheckpointBundle({
        bytes,
        expected_commit: output,
        expected_tree: tree,
        shallow_boundary: parent,
        expected_parent: parent,
        required_ancestor: parent,
        required_descendant: output,
        allowed_ref: /^refs\/openthrottle\/checkpoints\/[a-f0-9]{64}$/,
      })).toEqual({ ref, commit: output, tree, parents: [parent] });
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const expected = "4|maintenance.auto=false|gc.auto=0|gc.autodetach=false|core.fsmonitor=false";
    const invocations = readFileSync(capture, "utf8").trim().split("\n");
    expect(invocations).toEqual(expect.arrayContaining([expected]));
    expect(invocations.every((line) => line === expected)).toBe(true);
  });

  it("rejects a bundle whose advertised commit has the wrong parent", () => {
    const work = repository();
    const expectedParent = commit(work, "base\n", "base");
    execFileSync("git", ["checkout", "-q", "--orphan", "unrelated"], { cwd: work });
    execFileSync("git", ["rm", "-q", "-rf", "."], { cwd: work });
    commit(work, "unrelated\n", "unrelated");
    const output = commit(work, "changed\n", "changed");
    const tree = execFileSync("git", ["rev-parse", `${output}^{tree}`], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    const ref = `refs/openthrottle/checkpoints/${"b".repeat(64)}`;
    execFileSync("git", ["update-ref", ref, output], { cwd: work });

    expect(() => inspectKernelCheckpointBundle({
      bytes: bundle(work, ref, expectedParent),
      expected_commit: output,
      expected_tree: tree,
      shallow_boundary: expectedParent,
      expected_parent: expectedParent,
      allowed_ref: /^refs\/openthrottle\/checkpoints\/[a-f0-9]{64}$/,
    })).toThrow(/sole parent/i);
  });

  it("accepts an identity descriptor without requiring the commit to parent itself", () => {
    const work = repository();
    const input = commit(work, "base\n", "base");
    const tree = execFileSync("git", ["rev-parse", `${input}^{tree}`], {
      cwd: work, encoding: "utf8",
    }).trim();
    const ref = `refs/openthrottle/checkpoints/${"e".repeat(64)}`;
    execFileSync("git", ["update-ref", ref, input], { cwd: work });

    expect(inspectKernelCheckpointBundle({
      bytes: bundle(work, ref, input, "identity"),
      expected_commit: input,
      expected_tree: tree,
      shallow_boundary: input,
      allowed_ref: /^refs\/openthrottle\/checkpoints\/[a-f0-9]{64}$/,
    })).toEqual({ ref, commit: input, tree, parents: [] });
  });

  it("recomputes a stale linear integration from the sealed current and candidate", () => {
    const value = staleIntegrationFixture();
    expect(inspectKernelIntegrationBundle({
      bytes: value.outputBytes,
      descriptor: { ref: value.outputRef, commit: value.output, tree: value.mergedTree },
      checkpoint_base_subject: value.base,
      current_subject: value.current,
      candidate_bytes: value.candidateBytes,
      candidate_descriptor: {
        ref: value.candidateRef,
        commit: value.candidate,
        tree: value.candidateTree,
      },
      candidate_input_subject: value.base,
      candidate_output_subject: value.candidate,
      current_ancestry: value.currentAncestry,
    })).toMatchObject({ commit: value.output, tree: value.mergedTree, parents: [value.current] });
  });

  it("requires a fresh compact commit when the candidate directly descends from current", () => {
    const work = repository();
    const current = commit(work, "base\n", "base");
    const candidate = commit(work, "candidate\n", "private candidate");
    const candidateTree = git(work, ["rev-parse", `${candidate}^{tree}`]);
    const output = commitTree(work, candidateTree, [current]);
    const candidateRef = `refs/openthrottle/checkpoints/${"2".repeat(64)}`;
    const outputRef = `refs/openthrottle/integrations/${"3".repeat(64)}`;
    execFileSync("git", ["update-ref", candidateRef, candidate], { cwd: work });
    execFileSync("git", ["update-ref", outputRef, output], { cwd: work });

    expect(inspectKernelIntegrationBundle({
      bytes: bundle(work, outputRef, current, "direct-output"),
      descriptor: { ref: outputRef, commit: output, tree: candidateTree },
      checkpoint_base_subject: current,
      current_subject: current,
      candidate_bytes: bundle(work, candidateRef, current, "direct-candidate"),
      candidate_descriptor: { ref: candidateRef, commit: candidate, tree: candidateTree },
      candidate_input_subject: current,
      candidate_output_subject: candidate,
      current_ancestry: [],
    })).toEqual({ ref: outputRef, commit: output, tree: candidateTree, parents: [current] });
  });

  it("recomputes a stale integration through an exact two-link current ancestry proof", () => {
    const value = staleIntegrationFixture(2);
    expect(inspectKernelIntegrationBundle({
      bytes: value.outputBytes,
      descriptor: { ref: value.outputRef, commit: value.output, tree: value.mergedTree },
      checkpoint_base_subject: value.base,
      current_subject: value.current,
      candidate_bytes: value.candidateBytes,
      candidate_descriptor: {
        ref: value.candidateRef,
        commit: value.candidate,
        tree: value.candidateTree,
      },
      candidate_input_subject: value.base,
      candidate_output_subject: value.candidate,
      current_ancestry: value.currentAncestry,
    })).toMatchObject({ commit: value.output, tree: value.mergedTree, parents: [value.current] });
  });

  it("accepts a later-run identity candidate with its real ancestry intact", () => {
    const work = repository();
    const base = commit(work, "base\n", "base");
    const current = commit(work, "current\n", "current");
    const currentTree = execFileSync("git", ["rev-parse", `${current}^{tree}`], {
      cwd: work, encoding: "utf8",
    }).trim();
    const output = commitTree(work, currentTree, [current]);
    const candidateRef = `refs/openthrottle/checkpoints/${"8".repeat(64)}`;
    const outputRef = `refs/openthrottle/integrations/${"9".repeat(64)}`;
    execFileSync("git", ["update-ref", candidateRef, current], { cwd: work });
    execFileSync("git", ["update-ref", outputRef, output], { cwd: work });
    const candidateBytes = bundle(work, candidateRef, base, "later-identity");
    const outputBytes = bundle(work, outputRef, current, "later-identity-integration");

    expect(inspectKernelIntegrationBundle({
      bytes: outputBytes,
      descriptor: { ref: outputRef, commit: output, tree: currentTree },
      checkpoint_base_subject: base,
      current_subject: current,
      candidate_bytes: candidateBytes,
      candidate_descriptor: { ref: candidateRef, commit: current, tree: currentTree },
      candidate_input_subject: current,
      candidate_output_subject: current,
      current_ancestry: [],
    })).toEqual({ ref: outputRef, commit: output, tree: currentTree, parents: [current] });
  });

  it("accepts an empty proof when current is already an ancestor of the candidate input", () => {
    const work = repository();
    const base = commit(work, "base\n", "base");
    const current = commit(work, "current\n", "current");
    const candidateInput = commit(work, "candidate input\n", "candidate input");
    writeFileSync(join(work, "candidate.txt"), "candidate output\n");
    execFileSync("git", ["add", "candidate.txt"], { cwd: work });
    execFileSync("git", ["commit", "-qm", "candidate output"], { cwd: work });
    const candidate = git(work, ["rev-parse", "HEAD"]);
    const candidateTree = git(work, ["rev-parse", "HEAD^{tree}"]);
    const output = commitTree(work, candidateTree, [current]);
    const candidateRef = `refs/openthrottle/checkpoints/${"4".repeat(64)}`;
    const outputRef = `refs/openthrottle/integrations/${"5".repeat(64)}`;
    execFileSync("git", ["update-ref", candidateRef, candidate], { cwd: work });
    execFileSync("git", ["update-ref", outputRef, output], { cwd: work });
    const candidateBytes = bundle(work, candidateRef, base, "ancestor-candidate");
    const outputBytes = bundle(work, outputRef, current, "ancestor-output");

    expect(inspectKernelIntegrationBundle({
      bytes: outputBytes,
      descriptor: { ref: outputRef, commit: output, tree: candidateTree },
      checkpoint_base_subject: base,
      current_subject: current,
      candidate_bytes: candidateBytes,
      candidate_descriptor: { ref: candidateRef, commit: candidate, tree: candidateTree },
      candidate_input_subject: candidateInput,
      candidate_output_subject: candidate,
      current_ancestry: [],
    })).toEqual({ ref: outputRef, commit: output, tree: candidateTree, parents: [current] });
  });

  it.each([
    ["missing", (_value: ReturnType<typeof staleIntegrationFixture>) => []],
    ["gapped", (value: ReturnType<typeof staleIntegrationFixture>) => value.currentAncestry.slice(0, 1)],
    ["corrupt", (value: ReturnType<typeof staleIntegrationFixture>) => [{
      ...value.currentAncestry[0]!,
      bytes: Buffer.from("not a Git bundle"),
    }, ...value.currentAncestry.slice(1)]],
  ])("rejects a %s stale current ancestry proof", (_label, proof) => {
    const value = staleIntegrationFixture(2);
    expect(() => inspectKernelIntegrationBundle({
      bytes: value.outputBytes,
      descriptor: { ref: value.outputRef, commit: value.output, tree: value.mergedTree },
      checkpoint_base_subject: value.base,
      current_subject: value.current,
      candidate_bytes: value.candidateBytes,
      candidate_descriptor: {
        ref: value.candidateRef,
        commit: value.candidate,
        tree: value.candidateTree,
      },
      candidate_input_subject: value.base,
      candidate_output_subject: value.candidate,
      current_ancestry: proof(value),
    })).toThrow(/ancestry|bundle/i);
  });

  it.each(["divergent", "orphan"] as const)(
    "rejects a recomputable integration whose current is %s without an exact edge chain",
    (kind) => {
      const value = unprovenCurrentFixture(kind);
      expect(() => inspectKernelIntegrationBundle({
        bytes: value.outputBytes,
        descriptor: { ref: value.outputRef, commit: value.output, tree: value.mergedTree },
        checkpoint_base_subject: value.source,
        current_subject: value.current,
        candidate_bytes: value.candidateBytes,
        candidate_descriptor: {
          ref: value.candidateRef,
          commit: value.candidate,
          tree: value.candidateTree,
        },
        candidate_input_subject: value.candidateInput,
        candidate_output_subject: value.candidate,
        current_ancestry: [],
      })).toThrow(/ancestry/i);
    },
  );

  it.each(["arbitrary tree", "extra parent"])("rejects a forged integration with %s", (forgery) => {
    const value = staleIntegrationFixture();
    const forgedTree = forgery === "arbitrary tree"
      ? execFileSync("git", ["rev-parse", `${value.current}^{tree}`], {
        cwd: value.work, encoding: "utf8",
      }).trim()
      : value.mergedTree;
    const forged = commitTree(
      value.work,
      forgedTree,
      forgery === "extra parent" ? [value.current, value.candidate] : [value.current],
    );
    const ref = `refs/openthrottle/integrations/${"f".repeat(64)}`;
    execFileSync("git", ["update-ref", ref, forged], { cwd: value.work });
    const forgedBytes = bundle(value.work, ref, value.base, "forged");

    expect(() => inspectKernelIntegrationBundle({
      bytes: forgedBytes,
      descriptor: { ref, commit: forged, tree: forgedTree },
      checkpoint_base_subject: value.base,
      current_subject: value.current,
      candidate_bytes: value.candidateBytes,
      candidate_descriptor: {
        ref: value.candidateRef,
        commit: value.candidate,
        tree: value.candidateTree,
      },
      candidate_input_subject: value.base,
      candidate_output_subject: value.candidate,
      current_ancestry: value.currentAncestry,
    })).toThrow(/integration|sole parent/i);
  });
});
