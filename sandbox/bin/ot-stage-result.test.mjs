import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { parseProposalInput, writeProposal } from "./ot-stage-result.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ot-stage-result proposal writer", () => {
  it("writes an atomic bounded proposal without authoritative fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-stage-result-"));
    directories.push(directory);
    const output = join(directory, "proposal.json");
    const proposal = parseProposalInput(JSON.stringify({
      schema: "openthrottle.stage-proposal/v1",
      suggested_outcome: "semantic_repair_required",
      summary: "One blocking issue",
      evidence: [],
      findings: [{ severity: "P1", code: "unsafe", summary: "Unsafe behavior" }],
      actions: [],
      uncertainty: [],
    }));
    await writeProposal(proposal, output);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(proposal);
  });

  it("rejects malformed and authority-injecting proposals", () => {
    expect(() => parseProposalInput("not-json")).toThrow();
    expect(() => parseProposalInput("x".repeat(64 * 1024 + 1))).toThrow(/exceeds 64 KiB/);
    expect(() => parseProposalInput(JSON.stringify({
      schema: "openthrottle.stage-proposal/v1",
      suggested_outcome: "success",
      summary: "Trust me",
      result: "passed",
    }))).toThrow(/authoritative field result/);
  });

  it("runs through an installed symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-stage-result-link-"));
    directories.push(directory);
    const command = join(directory, "ot-stage-result");
    const output = join(directory, "proposal.json");
    await symlink(fileURLToPath(new URL("./ot-stage-result.mjs", import.meta.url)), command);
    const result = spawnSync(process.execPath, [command, JSON.stringify({
      schema: "openthrottle.stage-proposal/v1",
      suggested_outcome: "success",
      summary: "Symlink invocation",
      evidence: [],
      findings: [],
      actions: [],
      uncertainty: [],
    }), "--output", output], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8")).summary).toBe("Symlink invocation");
  });
});
