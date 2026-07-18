import type { Sandbox } from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";
import type { SandboxEnvContract } from "./daytona.js";
import { findSandboxForTicket, startTask, toEnvVars } from "./daytona.js";

const baseEnv: SandboxEnvContract = {
  TASK_TYPE: "resume",
  AGENT: "claude",
  GITHUB_REPO: "owner/repo",
  GITHUB_TOKEN: "github",
  BASE_BRANCH: "main",
  BRANCH_NAME: "ot/test",
  LINEAR_ISSUE_ID: "issue",
  LINEAR_ISSUE_IDENTIFIER: "OT-1",
  RUN_ID: "run",
  RUN_CALLBACK_TOKEN: "callback",
  MAX_TURNS: "200",
  TASK_TIMEOUT: "7200",
  DEV_PORT: "3000",
};

describe("Daytona task execution", () => {
  it("filters undefined env and clears optional values left by prior tasks", async () => {
    expect(toEnvVars({ ...baseEnv, RESUME_MESSAGE: undefined })).not.toHaveProperty(
      "RESUME_MESSAGE"
    );
    const updateEnv = vi.fn(async () => undefined);
    const uploadFile = vi.fn(async () => undefined);
    const setFilePermissions = vi.fn(async () => undefined);
    const execute = vi.fn(async () => undefined);
    const sandbox = {
      state: "started",
      updateEnv,
      fs: { uploadFile, setFilePermissions },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: execute,
      },
    } as unknown as Sandbox;

    await startTask(sandbox, {
      env: baseEnv,
      linearContext: "# OT-1\n\nApproved plan",
      taskTimeoutSeconds: 60,
    });

    expect(updateEnv).toHaveBeenCalledWith(expect.any(Object), {
      unset: [
        "RESUME_MESSAGE",
        "PR_NUMBER",
        "REVIEW_ROUND",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CODEX_AUTH_JSON",
        "LINEAR_ACCESS_TOKEN",
        "LINEAR_MCP_API_KEY",
        "ANTHROPIC_API_KEY",
        "CODEX_API_KEY",
      ],
    });
    expect(uploadFile).toHaveBeenCalledWith(
      Buffer.from("# OT-1\n\nApproved plan"),
      "/home/agent/.ot/linear-context.md"
    );
    expect(setFilePermissions).toHaveBeenCalledWith(
      "/home/agent/.ot/linear-context.md",
      { owner: "agent", group: "agent", mode: "600" }
    );
    expect(execute).toHaveBeenCalledWith(
      "resume-run",
      {
        command: "/opt/openthrottle/entrypoint.sh",
        runAsync: true,
        suppressInputEcho: true,
      },
      60
    );
  });

  it("recovers a sandbox by its durable ticket labels", async () => {
    const sandbox = { id: "sandbox-existing" } as Sandbox;
    const daytona = {
      list: vi.fn(() =>
        (async function* () {
          yield sandbox;
        })()
      ),
    };

    await expect(findSandboxForTicket(daytona as never, "OT-1")).resolves.toBe(sandbox);
    expect(daytona.list).toHaveBeenCalledWith({
      labels: { openthrottle: "true", ticket: "OT-1" },
    });
  });
});
