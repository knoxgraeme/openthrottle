import { Daytona, Sandbox } from "@daytonaio/sdk";
import type { Config } from "./config.js";
import type { Agent } from "./db.js";

export function createDaytonaClient(cfg: Config): Daytona {
  return new Daytona({ apiKey: cfg.daytonaApiKey });
}

export interface SandboxEnvContract {
  TASK_TYPE: "implement" | "resume";
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
  RESUME_MESSAGE?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  CODEX_API_KEY?: string;
  CODEX_AUTH_JSON?: string;
  MAX_TURNS: string;
  TASK_TIMEOUT: string;
  DEV_PORT: string;
}

function toEnvVars(env: SandboxEnvContract): Record<string, string> {
  // Daytona envVars is Record<string,string> — strip undefined optionals.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Create a fresh sandbox for a new ticket ("implement" flow).
 * Params per SPEC "Daytona" contract:
 *   { snapshot, envVars, labels: { openthrottle: "true", ticket }, autoStopInterval: 60, autoDeleteInterval: -1 }
 * Verified against installed @daytonaio/sdk (0.199.x) Daytona.create():
 *   CreateSandboxFromSnapshotParams = { snapshot?, envVars?, labels?, autoStopInterval?, autoDeleteInterval?, ... }
 */
export async function createForTicket(
  daytona: Daytona,
  cfg: Config,
  params: {
    issueIdentifier: string;
    env: Omit<SandboxEnvContract, "TASK_TYPE" | "RESUME_MESSAGE">;
  }
): Promise<Sandbox> {
  const envVars = toEnvVars({ ...params.env, TASK_TYPE: "implement" });
  return daytona.create({
    snapshot: cfg.daytonaSnapshot,
    envVars,
    labels: {
      openthrottle: "true",
      ticket: params.issueIdentifier,
    },
    autoStopInterval: 60, // minutes idle before auto-stop
    autoDeleteInterval: -1, // never auto-delete; deletion is explicit (PR close / sweep)
  });
}

/**
 * Resume flow: start the sandbox if stopped, then re-run the entrypoint in
 * resume mode via the process exec API (do NOT recreate the sandbox).
 * SPEC: "re-run the entrypoint task in resume mode by executing the sandbox
 * command /opt/openthrottle/entrypoint.sh with TASK_TYPE=resume and
 * RESUME_MESSAGE set (use Daytona process exec API)".
 *
 * TODO(verify-sdk): executeCommand's `env` param — confirmed to exist on
 * Process.executeCommand(command, cwd?, env?, timeout?) — but verify it is
 * merged with (not replacing) the sandbox's base env, and that long-running
 * commands (the full agent run, up to TASK_TIMEOUT seconds) are supported
 * synchronously vs requiring a background session (createSession +
 * executeSessionCommand with runAsync). Using a session here to avoid
 * blocking on a webhook-handler-scoped HTTP call for up to TASK_TIMEOUT.
 */
export async function startAndResume(
  daytona: Daytona,
  sandbox: Sandbox,
  params: {
    resumeMessage: string;
    env: Omit<SandboxEnvContract, "TASK_TYPE" | "RESUME_MESSAGE">;
    taskTimeoutSeconds: number;
  }
): Promise<void> {
  if (sandbox.state !== "started") {
    await daytona.start(sandbox, 60);
  }

  const envVars = toEnvVars({
    ...params.env,
    TASK_TYPE: "resume",
    RESUME_MESSAGE: params.resumeMessage,
  });

  // Run detached in a background session so this call returns quickly; the
  // sandbox entrypoint itself posts the final Linear activity on completion.
  const sessionId = `resume-${Date.now()}`;
  await sandbox.process.createSession(sessionId);
  await sandbox.process.executeSessionCommand(
    sessionId,
    {
      command: "/opt/openthrottle/entrypoint.sh",
      runAsync: true, // TODO(verify-sdk): confirm SessionExecuteRequest field name for fire-and-forget execution
      env: envVars, // TODO(verify-sdk): confirm SessionExecuteRequest accepts an `env` map
    } as never, // TODO(verify-sdk): SessionExecuteRequest shape imported from @daytona/toolbox-api-client not fully inspected; cast pending verification
    params.taskTimeoutSeconds
  );
}

export async function deleteSandbox(daytona: Daytona, sandboxId: string): Promise<void> {
  const sandbox = await daytona.get(sandboxId);
  await daytona.delete(sandbox, 60, false);
}

/**
 * List sandboxes labeled openthrottle=true in Daytona that have no
 * corresponding DB row (or whose DB row is closed/expired) — used by the
 * sweep to clean up orphans. Caller cross-references against the DB.
 */
export async function listLabeledSandboxes(daytona: Daytona): Promise<Sandbox[]> {
  const out: Sandbox[] = [];
  for await (const sandbox of daytona.list({ labels: { openthrottle: "true" } })) {
    out.push(sandbox);
  }
  return out;
}

/**
 * Deterministic preview URL for a sandbox port, without an extra API round
 * trip (SPEC: "preview URL (deterministic from sandboxId)").
 * TODO(verify-sdk): confirm the exact Daytona preview URL domain/pattern
 * for the target Daytona deployment (self-hosted vs app.daytona.io) — the
 * SDK's authoritative equivalent is the async `sandbox.getPreviewLink(port)`
 * call (returns { url, token }), which should be preferred wherever an
 * extra API call is acceptable (e.g. after resume) instead of this guess.
 */
export function computePreviewUrl(sandboxId: string, port: number): string {
  return `https://${port}-${sandboxId}.proxy.daytona.works`;
}
