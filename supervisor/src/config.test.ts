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
    "GITHUB_REPO_LABEL_MAPPINGS",
    "SPRITES_API_URL",
    "OT_PAYLOAD_TAR_PATH",
    "DEFAULT_AGENT",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_AUTH_JSON",
    "KIMI_CODE_API_KEY",
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
    SPRITE_TOKEN: "sprite-token",
    CLAUDE_CODE_OAUTH_TOKEN: "claude",
    CODEX_AUTH_JSON: "{}",
    KIMI_CODE_API_KEY: "kimi",
  });
}

describe("loadConfig", () => {
  it("loads safe defaults and repo mappings", () => {
    setRequiredEnv();
    process.env.GITHUB_REPO_MAPPINGS = JSON.stringify({ OT: "other/project" });
    process.env.GITHUB_REPO_LABEL_MAPPINGS = JSON.stringify({ "Repo/web-app": "owner/web-app" });
    process.env.ALLOW_LINEAR_MERGE = "true";

    expect(loadConfig()).toMatchObject({
      supervisorUrl: "https://openthrottle.test",
      githubRepo: "owner/repo",
      githubRepoMappings: { OT: "other/project" },
      githubRepoLabelMappings: { "Repo/web-app": "owner/web-app" },
      baseBranch: "main",
      port: 8080,
      taskTimeout: 7200,
      allowLinearMerge: true,
      defaultAgent: "codex",
      kimiCodeApiKey: "kimi",
      spriteToken: "sprite-token",
      spritesApiUrl: "https://api.sprites.dev",
      payloadTarPath: "/app/payload.tar.gz",
      reviewNudgeComment: "",
    });
  });

  it("requires SPRITE_TOKEN", () => {
    setRequiredEnv();
    delete process.env.SPRITE_TOKEN;
    expect(() => loadConfig()).toThrow("Missing required env var: SPRITE_TOKEN");
  });

  it("loads a configured review nudge comment", () => {
    setRequiredEnv();
    process.env.REVIEW_NUDGE_COMMENT = "@codex review";
    expect(loadConfig().reviewNudgeComment).toBe("@codex review");
  });

  it("rejects malformed integers, unsafe repos, and unsafe branch names", () => {
    setRequiredEnv();
    process.env.PORT = "8080junk";
    expect(() => loadConfig()).toThrow("PORT must be an integer");

    process.env.PORT = "8080";
    process.env.GITHUB_REPO = "owner/repo'";
    expect(() => loadConfig()).toThrow('GITHUB_REPO must be "owner/name"');

    process.env.GITHUB_REPO = "owner/repo";
    process.env.GITHUB_REPO_LABEL_MAPPINGS = JSON.stringify({ "Repo/web-app": "owner/repo'" });
    expect(() => loadConfig()).toThrow('GITHUB_REPO_LABEL_MAPPINGS.Repo/web-app must be an "owner/name"');

    process.env.GITHUB_REPO_LABEL_MAPPINGS = "";
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
    expect(() => loadConfig()).toThrow("DEFAULT_AGENT must be claude, codex, or opencode");
  });

  it("accepts opencode as the default agent", () => {
    setRequiredEnv();
    process.env.DEFAULT_AGENT = "opencode";
    expect(loadConfig().defaultAgent).toBe("opencode");
  });
});
