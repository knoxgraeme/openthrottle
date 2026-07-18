// Env parsing per docs/SPEC.md "Supervisor env" list.
// Fail fast (throw at boot) for vars the supervisor cannot function without.
// Vars that only matter once a sandbox is created (agent auth) are checked
// leniently (warn, don't crash) since a deployment may only use one agent.

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v || v.trim() === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Env var ${name} must be an integer, got: ${v}`);
  }
  return n;
}

export interface Config {
  port: number;
  databasePath: string;

  linearWebhookSecret: string;
  linearClientId: string;
  linearClientSecret: string;
  linearMcpApiKey: string;

  githubWebhookSecret: string;
  githubToken: string;
  githubRepo: string;

  daytonaApiKey: string;
  daytonaSnapshot: string;

  claudeCodeOauthToken: string | undefined;
  anthropicApiKey: string | undefined;
  codexApiKey: string | undefined;
  codexAuthJson: string | undefined;

  baseBranch: string;
  maxTurns: number;
  taskTimeout: number;
  devPort: number;
  sweepMaxAgeDays: number;
}

export function loadConfig(): Config {
  const cfg: Config = {
    port: optionalInt("PORT", 8080),
    databasePath: optional("DATABASE_PATH", "/data/openthrottle.db"),

    linearWebhookSecret: required("LINEAR_WEBHOOK_SECRET"),
    linearClientId: required("LINEAR_CLIENT_ID"),
    linearClientSecret: required("LINEAR_CLIENT_SECRET"),
    linearMcpApiKey: required("LINEAR_MCP_API_KEY"),

    githubWebhookSecret: required("GITHUB_WEBHOOK_SECRET"),
    githubToken: required("GITHUB_TOKEN"),
    githubRepo: required("GITHUB_REPO"),

    daytonaApiKey: required("DAYTONA_API_KEY"),
    daytonaSnapshot: optional("DAYTONA_SNAPSHOT", "openthrottle"),

    claudeCodeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    codexApiKey: process.env.CODEX_API_KEY,
    codexAuthJson: process.env.CODEX_AUTH_JSON,

    baseBranch: optional("BASE_BRANCH", "main"),
    maxTurns: optionalInt("MAX_TURNS", 200),
    taskTimeout: optionalInt("TASK_TIMEOUT", 7200),
    devPort: optionalInt("DEV_PORT", 3000),
    sweepMaxAgeDays: optionalInt("SWEEP_MAX_AGE_DAYS", 14),
  };

  if (!cfg.claudeCodeOauthToken && !cfg.anthropicApiKey) {
    console.warn(
      "[config] Neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY set — claude agent will not be usable"
    );
  }
  if (!cfg.codexApiKey && !cfg.codexAuthJson) {
    console.warn(
      "[config] Neither CODEX_API_KEY nor CODEX_AUTH_JSON set — codex agent will not be usable"
    );
  }
  if (!/^[^/]+\/[^/]+$/.test(cfg.githubRepo)) {
    throw new Error(`GITHUB_REPO must be "owner/name", got: ${cfg.githubRepo}`);
  }

  return cfg;
}
