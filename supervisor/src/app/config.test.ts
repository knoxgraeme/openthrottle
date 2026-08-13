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
    "RUNTIME_RESOURCE_RETENTION_MINUTES",
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
    OT_DEPLOY_TOKEN: "deploy",
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
      deployToken: "deploy",
      port: 8080,
      taskTimeout: 7200,
      allowLinearMerge: true,
      defaultAgent: "codex",
      githubReadToken: "github-read-token",
      kimiCodeApiKey: "kimi",
      sandboxEventPollIntervalMs: 5_000,
      sandboxRuntimeRelease: "openthrottle-snapshot/v12",
      runtimeResourceRetentionMinutes: 60,
      runOutcomeRetentionDays: 180,
    });
  });

  it("boots without Linear configuration while preserving GitHub readiness requirements", () => {
    setRequiredEnv();
    delete process.env.LINEAR_WEBHOOK_SECRET;
    delete process.env.LINEAR_CLIENT_ID;
    delete process.env.LINEAR_CLIENT_SECRET;

    expect(loadConfig()).toMatchObject({
      linearWebhookSecret: undefined,
      linearClientId: undefined,
      linearClientSecret: undefined,
      githubWebhookSecret: "github-webhook",
      githubToken: "github-token",
      githubReadToken: "github-read-token",
    });

    delete process.env.GITHUB_TOKEN;
    expect(() => loadConfig()).toThrow("Missing required env var: GITHUB_TOKEN");
  });

  it("requires a dedicated deployment token separate from operator status auth", () => {
    setRequiredEnv();
    delete process.env.OT_DEPLOY_TOKEN;
    expect(() => loadConfig()).toThrow("Missing required env var: OT_DEPLOY_TOKEN");

    process.env.OT_DEPLOY_TOKEN = "deploy-token";
    process.env.OT_STATUS_TOKEN = "status-token";
    expect(loadConfig()).toMatchObject({
      deployToken: "deploy-token",
      statusToken: "status-token",
    });

    process.env.OT_STATUS_TOKEN = "deploy-token";
    expect(() => loadConfig()).toThrow("OT_DEPLOY_TOKEN must be distinct");
  });

  it("loads and validates the runtime resource retention window", () => {
    setRequiredEnv();
    process.env.RUNTIME_RESOURCE_RETENTION_MINUTES = "15";
    expect(loadConfig().runtimeResourceRetentionMinutes).toBe(15);

    process.env.RUNTIME_RESOURCE_RETENTION_MINUTES = "0";
    expect(loadConfig().runtimeResourceRetentionMinutes).toBe(0);

    process.env.RUNTIME_RESOURCE_RETENTION_MINUTES = "-1";
    expect(() => loadConfig()).toThrow(
      "RUNTIME_RESOURCE_RETENTION_MINUTES must be between 0"
    );
  });

  it("rejects an out-of-range run outcome retention window", () => {
    setRequiredEnv();
    process.env.RUN_OUTCOME_RETENTION_DAYS = "0";
    expect(() => loadConfig()).toThrow("RUN_OUTCOME_RETENTION_DAYS must be between 1");
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

  it("caps the supervisor hard task timeout at the authored graph maximum", () => {
    setRequiredEnv();
    process.env.TASK_TIMEOUT = "86400";
    expect(loadConfig().taskTimeout).toBe(86_400);

    process.env.TASK_TIMEOUT = "86401";
    expect(() => loadConfig()).toThrow("TASK_TIMEOUT must be between 1 and 86400");
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
