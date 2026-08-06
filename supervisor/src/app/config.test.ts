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
    "DAYTONA_SNAPSHOT",
    "DEFAULT_AGENT",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_AUTH_JSON",
    "KIMI_CODE_API_KEY",
    "TASK_TIMEOUT",
    "ORPHAN_GRACE_MINUTES",
    "WEBHOOK_MAX_AGE_SECONDS",
    "ALLOW_LINEAR_MERGE",
    "SANDBOX_EVENT_POLL_INTERVAL_MS",
    "PIPELINE_CATALOG_PATH",
    "SANDBOX_RUNTIME_RELEASE",
    "SANDBOX_RUNTIME_DESCRIPTOR_PATH",
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
    GITHUB_READ_TOKEN: "github-read-token",
    DAYTONA_API_KEY: "daytona",
    CLAUDE_CODE_OAUTH_TOKEN: "claude",
    CODEX_AUTH_JSON: "{}",
    KIMI_CODE_API_KEY: "kimi",
  });
}

describe("loadConfig", () => {
  it("loads safe coordinator defaults", () => {
    setRequiredEnv();
    process.env.ALLOW_LINEAR_MERGE = "true";

    expect(loadConfig()).toMatchObject({
      supervisorUrl: "https://openthrottle.test",
      port: 8080,
      taskTimeout: 7200,
      allowLinearMerge: true,
      defaultAgent: "codex",
      githubReadToken: "github-read-token",
      kimiCodeApiKey: "kimi",
      sandboxEventPollIntervalMs: 5_000,
      sandboxRuntimeRelease: "openthrottle-snapshot/v9",
    });
  });

  it("validates explicit runtime settings", () => {
    setRequiredEnv();
    process.env.PIPELINE_CATALOG_PATH = "/opt/catalog.yaml";
    process.env.SANDBOX_RUNTIME_RELEASE = "snapshot/2026-07-22";
    process.env.SANDBOX_RUNTIME_DESCRIPTOR_PATH = "/opt/runtime.json";
    expect(loadConfig()).toMatchObject({
      pipelineCatalogPath: "/opt/catalog.yaml",
      sandboxRuntimeRelease: "snapshot/2026-07-22",
      sandboxRuntimeDescriptorPath: "/opt/runtime.json",
    });
    process.env.SANDBOX_RUNTIME_RELEASE = "unsafe release";
    expect(() => loadConfig()).toThrow(/SANDBOX_RUNTIME_RELEASE/);
  });

  it("rejects malformed integers", () => {
    setRequiredEnv();
    process.env.PORT = "8080junk";
    expect(() => loadConfig()).toThrow("PORT must be an integer");
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
