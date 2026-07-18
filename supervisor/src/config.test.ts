import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

function setRequiredEnv(): void {
  for (const name of [
    "PORT",
    "DATABASE_PATH",
    "GITHUB_REPO_MAPPINGS",
    "DAYTONA_SNAPSHOT",
    "DEFAULT_AGENT",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_AUTH_JSON",
    "BASE_BRANCH",
    "MAX_TURNS",
    "TASK_TIMEOUT",
    "CALLBACK_GRACE_SECONDS",
    "DEV_PORT",
    "SWEEP_MAX_AGE_DAYS",
    "ORPHAN_GRACE_MINUTES",
    "WEBHOOK_MAX_AGE_SECONDS",
    "REVIEW_MAX_ROUNDS",
    "ALLOW_LINEAR_MERGE",
    "SANDBOX_EVENT_POLL_INTERVAL_MS",
  ]) {
    delete process.env[name];
  }
  Object.assign(process.env, {
    SUPERVISOR_URL: "https://openthrottle.test/",
    OT_STATUS_TOKEN: "status",
    OT_INSTALL_SECRET: "install",
    LINEAR_WEBHOOK_SECRET: "linear-webhook",
    LINEAR_CLIENT_ID: "linear-client",
    LINEAR_CLIENT_SECRET: "linear-client-secret",
    GITHUB_WEBHOOK_SECRET: "github-webhook",
    GITHUB_TOKEN: "github-token",
    GITHUB_REPO: "owner/repo",
    DAYTONA_API_KEY: "daytona",
    CLAUDE_CODE_OAUTH_TOKEN: "claude",
    CODEX_AUTH_JSON: "{}",
  });
}

describe("loadConfig", () => {
  it("loads safe defaults and repo mappings", () => {
    setRequiredEnv();
    process.env.GITHUB_REPO_MAPPINGS = JSON.stringify({ OT: "other/project" });
    process.env.ALLOW_LINEAR_MERGE = "true";

    expect(loadConfig()).toMatchObject({
      supervisorUrl: "https://openthrottle.test",
      githubRepo: "owner/repo",
      githubRepoMappings: { OT: "other/project" },
      baseBranch: "main",
      port: 8080,
      taskTimeout: 7200,
      allowLinearMerge: true,
      defaultAgent: "codex",
      sandboxEventPollIntervalMs: 5_000,
    });
  });

  it("rejects malformed integers, unsafe repos, and unsafe branch names", () => {
    setRequiredEnv();
    process.env.PORT = "8080junk";
    expect(() => loadConfig()).toThrow("PORT must be an integer");

    process.env.PORT = "8080";
    process.env.GITHUB_REPO = "owner/repo'";
    expect(() => loadConfig()).toThrow('GITHUB_REPO must be "owner/name"');

    process.env.GITHUB_REPO = "owner/repo";
    process.env.BASE_BRANCH = "main; unsafe";
    expect(() => loadConfig()).toThrow("BASE_BRANCH must be a safe Git branch name");
  });

  it("rejects out-of-range lifecycle limits", () => {
    setRequiredEnv();
    process.env.TASK_TIMEOUT = "0";
    expect(() => loadConfig()).toThrow("TASK_TIMEOUT must be between 1");
  });

  it("rejects an invalid default agent", () => {
    setRequiredEnv();
    process.env.DEFAULT_AGENT = "other";
    expect(() => loadConfig()).toThrow("DEFAULT_AGENT must be claude or codex");
  });
});
