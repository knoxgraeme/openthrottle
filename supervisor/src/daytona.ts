import type { Daytona, Sandbox } from "@daytona/sdk";
import type { Config } from "./config.js";
import type { Agent, TaskType } from "./db.js";

export interface SandboxEnvContract {
  TASK_TYPE: TaskType;
  AGENT: Agent;
  GITHUB_REPO: string;
  GITHUB_TOKEN: string;
  BASE_BRANCH: string;
  BRANCH_NAME: string;
  LINEAR_SESSION_ID: string;
  LINEAR_ISSUE_ID: string;
  LINEAR_ISSUE_IDENTIFIER: string;
  LINEAR_ACCESS_TOKEN: string;
  LINEAR_MCP_API_KEY: string;
  SUPERVISOR_URL: string;
  RUN_ID: string;
  RUN_CALLBACK_TOKEN: string;
  RESUME_MESSAGE?: string;
  PR_NUMBER?: string;
  REVIEW_ROUND?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  CODEX_API_KEY?: string;
  CODEX_AUTH_JSON?: string;
  MAX_TURNS: string;
  TASK_TIMEOUT: string;
  DEV_PORT: string;
}

export function toEnvVars(env: SandboxEnvContract): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

export async function createForTicket(
  daytona: Daytona,
  cfg: Config,
  params: { issueIdentifier: string; env: SandboxEnvContract }
): Promise<Sandbox> {
  return daytona.create({
    snapshot: cfg.daytonaSnapshot,
    envVars: toEnvVars(params.env),
    labels: {
      openthrottle: "true",
      ticket: params.issueIdentifier,
    },
    public: false,
    autoStopInterval: 60,
    autoDeleteInterval: -1,
  });
}

export async function findSandboxForTicket(
  daytona: Daytona,
  issueIdentifier: string
): Promise<Sandbox | undefined> {
  for await (const sandbox of daytona.list({
    labels: { openthrottle: "true", ticket: issueIdentifier },
  })) {
    return sandbox;
  }
  return undefined;
}

export async function startTask(
  sandbox: Sandbox,
  params: {
    env: SandboxEnvContract;
    taskTimeoutSeconds: number;
  }
): Promise<void> {
  if (sandbox.state !== "started") await sandbox.start(60);
  const envVars = toEnvVars(params.env);
  const optionalNames = ["RESUME_MESSAGE", "PR_NUMBER", "REVIEW_ROUND"] as const;
  await sandbox.updateEnv(envVars, {
    unset: optionalNames.filter((name) => params.env[name] === undefined),
  });

  const sessionId = `${params.env.TASK_TYPE}-${params.env.RUN_ID}`;
  await sandbox.process.createSession(sessionId);
  await sandbox.process.executeSessionCommand(
    sessionId,
    {
      command: "/opt/openthrottle/entrypoint.sh",
      runAsync: true,
      suppressInputEcho: true,
    },
    params.taskTimeoutSeconds
  );
}

export async function stopSandbox(daytona: Daytona, sandboxId: string): Promise<void> {
  const sandbox = await daytona.get(sandboxId);
  await sandbox.stop(60, true);
}

export async function deleteSandbox(daytona: Daytona, sandboxId: string): Promise<void> {
  const sandbox = await daytona.get(sandboxId);
  await sandbox.delete(60, false);
}

export async function getSignedPreviewUrl(
  daytona: Daytona,
  sandboxId: string,
  port: number
): Promise<string> {
  const sandbox = await daytona.get(sandboxId);
  if (sandbox.state !== "started") await sandbox.start(60);
  const preview = await sandbox.getSignedPreviewUrl(port, 5 * 60);
  return preview.url;
}

export async function getSandboxLogs(daytona: Daytona, sandboxId: string): Promise<string> {
  const sandbox = await daytona.get(sandboxId);
  if (sandbox.state !== "started") await sandbox.start(60);
  const logs = await sandbox.process.getEntrypointLogs();
  return logs.output ?? [logs.stdout, logs.stderr].filter(Boolean).join("\n");
}

export async function listLabeledSandboxes(daytona: Daytona): Promise<Sandbox[]> {
  const sandboxes: Sandbox[] = [];
  for await (const sandbox of daytona.list({ labels: { openthrottle: "true" } })) {
    sandboxes.push(sandbox);
  }
  return sandboxes;
}
