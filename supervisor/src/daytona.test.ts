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
    const setAutostopInterval = vi.fn(async () => undefined);
    const execute = vi.fn(async () => undefined);
    const sandbox = {
      state: "started",
      autoStopInterval: 5,
      setAutostopInterval,
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
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CODEX_AUTH_JSON",
        "KIMI_CODE_API_KEY",
        "OT_GIT_AUTHOR_NAME",
        "OT_GIT_AUTHOR_EMAIL",
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
    expect(setAutostopInterval).toHaveBeenCalledWith(60);
    expect(setAutostopInterval.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[0]
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

  it("waits for activation to settle before reporting a concurrent setup failure", async () => {
    let releaseActivation!: () => void;
    const activationReleased = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    let markActivationStarted!: () => void;
    const activationStarted = new Promise<void>((resolve) => {
      markActivationStarted = resolve;
    });
    const executeSessionCommand = vi.fn();
    const sandbox = {
      state: "started",
      autoStopInterval: 5,
      setAutostopInterval: vi.fn(async () => {
        markActivationStarted();
        await activationReleased;
      }),
      updateEnv: vi.fn(async () => {
        throw new Error("environment update failed");
      }),
      fs: {
        uploadFile: vi.fn(),
        setFilePermissions: vi.fn(),
      },
      process: {
        createSession: vi.fn(),
        executeSessionCommand,
      },
    } as unknown as Sandbox;

    const task = startTask(sandbox, {
      env: baseEnv,
      linearContext: "# OT-1",
      taskTimeoutSeconds: 60,
    });
    let rejected = false;
    void task.catch(() => {
      rejected = true;
    });
    await activationStarted;
    await Promise.resolve();
    expect(rejected).toBe(false);

    releaseActivation();
    await expect(task).rejects.toThrow("environment update failed");
    expect(executeSessionCommand).not.toHaveBeenCalled();
  });
});
