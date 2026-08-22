import { spawnSync } from "node:child_process";
import type { Sandbox } from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  DAYTONA_REPOSITORY_ROOT,
  materializeDaytonaRepositorySource,
} from "./kernel-repository-source.js";

const REPOSITORY_STAGING = "/var/lib/openthrottle/repository-source/repo.part";
const REPOSITORY_PARENT = "/var/lib/openthrottle/repository-source";
const SUBJECT = "c".repeat(40);
const URL = "https://github.com/owner/repository.git";
const TOKEN = "github-read-token";

function repositorySandbox(initiallyReady: boolean) {
  let ready = initiallyReady;
  let cloned = false;
  const commands: string[] = [];
  const deleteFile = vi.fn().mockRejectedValue(new Error("404 not found"));
  const clone = vi.fn(async () => {
    cloned = true;
  });
  const executeCommand = vi.fn(async (command: string) => {
    commands.push(command);
    if (command.includes("install -d") && command.includes(REPOSITORY_PARENT)) {
      return { exitCode: 0, result: "" };
    }
    if (command.includes(`mv -- '${REPOSITORY_STAGING}' '${DAYTONA_REPOSITORY_ROOT}'`)) {
      expect(cloned).toBe(true);
      ready = true;
      return { exitCode: 0, result: "" };
    }
    if (command.includes(`test -e '${DAYTONA_REPOSITORY_ROOT}' || exit 44`)) {
      return { exitCode: ready ? 0 : 44, result: "" };
    }
    throw new Error(`unexpected repository command: ${command}`);
  });
  const sandbox = {
    fs: { deleteFile },
    git: { clone },
    process: { executeCommand },
  } as unknown as Sandbox;
  return {
    sandbox,
    commands,
    clone,
    deleteFile,
    isReady: () => ready,
  };
}

function expectValidShell(commands: string[]): void {
  for (const command of commands) {
    const parsed = spawnSync("/bin/sh", ["-n", "-c", command], { encoding: "utf8" });
    expect(parsed.status, parsed.stderr).toBe(0);
  }
}

describe("Daytona repository source materialization", () => {
  it("clones, atomically publishes, and verifies an absent exact source", async () => {
    const fake = repositorySandbox(false);

    await materializeDaytonaRepositorySource({
      sandbox: fake.sandbox,
      repository: "owner/repository",
      base_branch: "main",
      subject: SUBJECT,
      github_read_token: TOKEN,
    });

    expect(fake.deleteFile).toHaveBeenCalledOnce();
    expect(fake.deleteFile).toHaveBeenCalledWith(REPOSITORY_STAGING, true);
    expect(fake.clone).toHaveBeenCalledWith(
      URL,
      REPOSITORY_STAGING,
      "main",
      SUBJECT,
      "x-access-token",
      TOKEN,
      false,
    );
    expect(fake.isReady()).toBe(true);
    expect(fake.commands.filter((command) =>
      command.includes(`test -e '${DAYTONA_REPOSITORY_ROOT}' || exit 44`),
    )).toHaveLength(2);
    expect(fake.commands.some((command) => command.includes(
      `stat -c '%U:%G:%a' '${REPOSITORY_PARENT}'`,
    ))).toBe(true);
    expect(fake.commands.some((command) => command.includes(
      `git -C '${REPOSITORY_STAGING}' remote get-url origin`,
    ))).toBe(true);
    expect(fake.commands.some((command) => command.includes(
      `git -C '${REPOSITORY_STAGING}' rev-parse '${SUBJECT}^{commit}'`,
    ))).toBe(true);
    expect(fake.commands.every((command) => !command.includes(TOKEN))).toBe(true);

    const findLines = fake.commands.flatMap((command) =>
      command.split("\n").filter((line) => line.includes("find -P")),
    );
    expect(findLines).not.toHaveLength(0);
    expect(findLines.every((line) => !/(?:^|\s)\((?:\s|$)/.test(line))).toBe(true);
    expectValidShell(fake.commands);
  });

  it("accepts an already-ready exact source without touching staging", async () => {
    const fake = repositorySandbox(true);

    await materializeDaytonaRepositorySource({
      sandbox: fake.sandbox,
      repository: "owner/repository",
      base_branch: "main",
      subject: SUBJECT,
      github_read_token: TOKEN,
    });

    expect(fake.clone).not.toHaveBeenCalled();
    expect(fake.deleteFile).not.toHaveBeenCalled();
    expect(fake.commands).toHaveLength(2);
    expect(fake.commands.every((command) => !command.includes(TOKEN))).toBe(true);
    expectValidShell(fake.commands);
  });
});
