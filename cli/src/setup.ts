import * as p from "@clack/prompts";
import { getErrorMessage, readEnv } from "./util.js";

const SUPERVISOR_ENV_VARS: Array<{ name: string; hint: string }> = [
  { name: "SUPERVISOR_URL", hint: "public HTTPS base URL" },
  { name: "OT_STATUS_TOKEN", hint: "random operator bearer token" },
  { name: "OT_INSTALL_SECRET", hint: "random bearer token for /oauth/install" },
  { name: "DATABASE_PATH", hint: "default: /data/openthrottle.db" },
  { name: "LINEAR_WEBHOOK_SECRET", hint: "Linear webhook signing secret" },
  { name: "LINEAR_CLIENT_ID", hint: "Linear OAuth agent app" },
  { name: "LINEAR_CLIENT_SECRET", hint: "Linear OAuth agent app" },
  { name: "GITHUB_WEBHOOK_SECRET", hint: "shared GitHub webhook signing secret" },
  { name: "GITHUB_TOKEN", hint: "fine-grained PAT with target-repository access" },
  { name: "GITHUB_REPO", hint: "fallback owner/name for legacy unmapped teams" },
  { name: "GITHUB_REPO_MAPPINGS", hint: "optional legacy team-to-repo JSON fallback" },
  { name: "DAYTONA_API_KEY", hint: "Daytona API key" },
  { name: "DAYTONA_SNAPSHOT", hint: "default: openthrottle" },
  { name: "DEFAULT_AGENT", hint: "codex, claude, or opencode; default: codex" },
  { name: "CLAUDE_CODE_OAUTH_TOKEN", hint: "Claude subscription setup token" },
  { name: "CODEX_AUTH_JSON", hint: "raw ~/.codex/auth.json for Codex subscription login" },
  { name: "KIMI_CODE_API_KEY", hint: "Kimi Code Console subscription API key for OpenCode, not Kimi Open Platform billing" },
  { name: "BASE_BRANCH", hint: "legacy fallback; default: main" },
  { name: "MAX_TURNS", hint: "default: 200" },
  { name: "TASK_TIMEOUT", hint: "seconds; default: 7200" },
  { name: "CALLBACK_GRACE_SECONDS", hint: "default: 120" },
  { name: "SANDBOX_EVENT_POLL_INTERVAL_MS", hint: "default: 5000" },
  { name: "DEV_PORT", hint: "default: 3000" },
  { name: "SWEEP_MAX_AGE_DAYS", hint: "default: 14" },
  { name: "ORPHAN_GRACE_MINUTES", hint: "default: 5" },
  { name: "WEBHOOK_MAX_AGE_SECONDS", hint: "default: 60" },
  { name: "REVIEW_MAX_ROUNDS", hint: "default: 3" },
  { name: "REVIEW_NUDGE_COMMENT", hint: "optional PR comment posted after a feedback fix, e.g. @codex review; empty relies on review-on-push" },
  { name: "ALLOW_LINEAR_MERGE", hint: "default: false" },
];

export async function verifySnapshot(snapshotName: string): Promise<boolean> {
  const apiKey = readEnv("DAYTONA_API_KEY");
  if (!apiKey) {
    p.log.warn(`DAYTONA_API_KEY is not set, so snapshot "${snapshotName}" could not be verified.`);
    return false;
  }
  const { Daytona } = await import("@daytona/sdk");
  const snapshot = await new Daytona({ apiKey }).snapshot.get(snapshotName);
  p.log.success(`Snapshot "${snapshot.name}" found (${snapshot.state}).`);
  return String(snapshot.state).toLowerCase() === "active";
}

export default async function setup(): Promise<void> {
  p.intro("openthrottle setup");
  const snapshotName = readEnv("DAYTONA_SNAPSHOT") ?? "openthrottle";
  try {
    if (!(await verifySnapshot(snapshotName))) {
      p.log.warn(
        `Create or activate it from the OpenThrottle repository:\n  daytona snapshot create ${snapshotName} --dockerfile sandbox/Dockerfile --context .`
      );
    }
  } catch (error) {
    p.log.error(`Snapshot verification failed: ${getErrorMessage(error)}`);
  }
  console.log("\nOne-time Fly supervisor secrets:\n");
  for (const { name, hint } of SUPERVISOR_ENV_VARS) {
    console.log(`  fly secrets set ${name}="<value>"   # ${hint}`);
  }
  p.outro(
    "Deploy the supervisor, install its Linear OAuth app, then run `openthrottle init` in each target repository."
  );
}
