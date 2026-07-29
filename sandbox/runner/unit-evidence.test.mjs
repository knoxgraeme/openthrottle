import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveCandidateEvidence, bindCommandReceipt } from "./unit-evidence.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository() {
  const directory = mkdtempSync(join(tmpdir(), "ot-unit-evidence-"));
  directories.push(directory);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  writeFileSync(join(directory, "file.txt"), "initial\n");
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: directory });
  return directory;
}

describe("unit evidence", () => {
  it("derives candidate tree facts from Git instead of worker claims", () => {
    const repoDir = repository();
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    writeFileSync(join(repoDir, "file.txt"), "changed\n");
    writeFileSync(join(repoDir, "new.txt"), "new\n");

    const evidence = deriveCandidateEvidence({ repoDir, baseCommit });

    expect(evidence).toMatchObject({
      schema: "openthrottle.candidate-evidence/v1",
      base: baseCommit,
      pre: baseCommit,
      clean: false,
      changed_paths: ["file.txt", "new.txt"],
    });
    expect(evidence.diff_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds command receipts to command name, subject, and request fence", () => {
    const subject = "1".repeat(40);
    const requestHash = "2".repeat(64);
    const receipt = {
      type: "command_result",
      result: "success",
      subject: { post: subject },
      fence: { request_hash: requestHash },
      payload: { command: "test" },
    };

    expect(bindCommandReceipt({ receipt, commandName: "test", expectedSubject: subject, requestHash }))
      .toMatchObject({ command: "test", subject, result: "success" });
    expect(() => bindCommandReceipt({ receipt, commandName: "lint", expectedSubject: subject, requestHash }))
      .toThrow(/command mismatch/);
  });
});
