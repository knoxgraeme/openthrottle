import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface KernelGitBundleDescriptor {
  ref: string;
  commit: string;
  tree: string;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || "git command failed").slice(-1_000);
    throw new Error(`checkpoint bundle verification failed: ${detail}`);
  }
  return result.stdout.trim();
}

/** Verifies one self-contained Git bundle and returns its exact ref/commit/tree descriptor. */
export function inspectKernelCheckpointBundle(input: {
  bytes: Uint8Array;
  expected_commit: string;
  allowed_ref: RegExp;
}): KernelGitBundleDescriptor {
  const scratch = mkdtempSync(join(tmpdir(), "openthrottle-kernel-bundle-"));
  const repository = join(scratch, "verify.git");
  const bundle = join(scratch, "checkpoint.bundle");
  try {
    writeFileSync(bundle, input.bytes, { mode: 0o400 });
    git(scratch, ["init", "--quiet", "--bare", repository]);
    const heads = git(repository, ["bundle", "list-heads", bundle]).split("\n").filter(Boolean);
    if (heads.length !== 1) throw new Error("checkpoint bundle must advertise exactly one sealed ref");
    const [commit, ref, ...extra] = heads[0]!.trim().split(/\s+/);
    if (
      extra.length !== 0 || commit !== input.expected_commit || !ref || !input.allowed_ref.test(ref)
    ) throw new Error("checkpoint bundle does not advertise its exact sealed ref and commit");
    git(repository, ["bundle", "verify", bundle]);
    git(repository, ["fetch", "--quiet", "--no-tags", bundle, ref]);
    const tree = git(repository, ["rev-parse", `${commit}^{tree}`]);
    if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new Error("checkpoint bundle has an invalid Git tree");
    return { ref, commit, tree };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
