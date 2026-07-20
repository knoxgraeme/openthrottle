import * as p from "@clack/prompts";
import { getErrorMessage, readEnv } from "./util.js";

const DEFAULT_SPRITES_API_URL = "https://api.sprites.dev";

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
  { name: "SPRITE_TOKEN", hint: "org-scoped Fly Sprites API token" },
  { name: "SPRITES_API_URL", hint: "default: https://api.sprites.dev" },
  { name: "DEFAULT_AGENT", hint: "codex, claude, or opencode; default: codex" },
  { name: "CLAUDE_CODE_OAUTH_TOKEN", hint: "Claude subscription setup token" },
  { name: "CODEX_AUTH_JSON", hint: "raw ~/.codex/auth.json for Codex subscription login" },
  { name: "KIMI_CODE_API_KEY", hint: "Kimi Code Console subscription API key for OpenCode, not Kimi Open Platform billing" },
  { name: "BASE_BRANCH", hint: "legacy fallback; default: main" },
  { name: "MAX_TURNS", hint: "default: 200" },
  { name: "TASK_TIMEOUT", hint: "seconds; default: 7200" },
  { name: "CALLBACK_GRACE_SECONDS", hint: "default: 120" },
  { name: "DEV_PORT", hint: "default: 3000" },
  { name: "SWEEP_MAX_AGE_DAYS", hint: "default: 14" },
  { name: "ORPHAN_GRACE_MINUTES", hint: "default: 5" },
  { name: "WEBHOOK_MAX_AGE_SECONDS", hint: "default: 60" },
  { name: "REVIEW_MAX_ROUNDS", hint: "default: 3" },
  { name: "ALLOW_LINEAR_MERGE", hint: "default: false" },
];

/** Confirms SPRITE_TOKEN authenticates against the Fly Sprites API. No sandbox payload
 * check is needed here — the payload is baked into the supervisor's own Fly image, so it
 * cannot drift out of band the way a separately published Daytona snapshot could. */
async function verifySpriteToken(): Promise<boolean> {
  const token = readEnv("SPRITE_TOKEN");
  if (!token) {
    p.log.warn("SPRITE_TOKEN is not set, so Fly Sprites access could not be verified.");
    return false;
  }
  const baseUrl = (readEnv("SPRITES_API_URL") ?? DEFAULT_SPRITES_API_URL).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v1/sprites?max_results=1`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    p.log.warn(`Fly Sprites API rejected SPRITE_TOKEN (HTTP ${response.status}) at ${baseUrl}.`);
    return false;
  }
  p.log.success(`SPRITE_TOKEN verified against ${baseUrl}.`);
  return true;
}

export default async function setup(): Promise<void> {
  p.intro("openthrottle setup");
  try {
    if (!(await verifySpriteToken())) {
      p.log.warn(
        "Create an org-scoped Fly Sprites API token (https://sprites.dev) and set it as SPRITE_TOKEN before deploying the supervisor."
      );
    }
  } catch (error) {
    p.log.error(`SPRITE_TOKEN verification failed: ${getErrorMessage(error)}`);
  }
  console.log("\nOne-time Fly supervisor secrets:\n");
  for (const { name, hint } of SUPERVISOR_ENV_VARS) {
    console.log(`  fly secrets set ${name}="<value>"   # ${hint}`);
  }
  p.outro(
    "Deploy the supervisor, install its Linear OAuth app, then run `openthrottle init` in each target repository."
  );
}
