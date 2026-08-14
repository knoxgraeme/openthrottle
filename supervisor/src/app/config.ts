// Env parsing per docs/SPEC.md "Supervisor env" list.
// Fail fast (throw at boot) for vars the supervisor cannot function without.
// Agent subscription credentials are checked against the selected agent before
// provisioning so one unavailable agent does not prevent the supervisor booting.

import type { Agent } from "../pipeline/types.js";
import { fileURLToPath } from "node:url";

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
  const trimmed = v.trim();
  const n = Number(trimmed);
  if (!/^-?\d+$/.test(trimmed) || !Number.isSafeInteger(n)) {
    throw new Error(`Env var ${name} must be an integer, got: ${v}`);
  }
  return n;
}

function requireRange(name: string, value: number, min: number, max = Number.MAX_SAFE_INTEGER): void {
  if (value < min || value > max) {
    throw new Error(`Env var ${name} must be between ${min} and ${max}, got: ${value}`);
  }
}

function optionalBool(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`Env var ${name} must be a boolean, got: ${value}`);
}

function optionalAgent(name: string, fallback: Agent): Agent {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "claude" || value === "codex" || value === "opencode") return value;
  throw new Error(`Env var ${name} must be claude, codex, or opencode, got: ${value}`);
}

export interface Config {
  port: number;
  databasePath: string;
  supervisorUrl: string;
  statusToken: string;
  deployToken: string;
  installSecret: string;

  linearWebhookSecret: string | undefined;
  linearClientId: string | undefined;
  linearClientSecret: string | undefined;

  githubWebhookSecret: string;
  githubToken: string;
  githubReadToken: string;

  daytonaApiKey: string;
  daytonaSnapshot: string;
  // Optional so Config literals elsewhere (tests) stay valid; admission
  // preflight applies the 10/8 GiB defaults when they are absent.
  daytonaTotalMemoryGib?: number;
  daytonaSandboxMemoryGib?: number;

  defaultAgent: Agent;
  claudeCodeOauthToken: string | undefined;
  codexAuthJson: string | undefined;
  kimiCodeApiKey: string | undefined;

  taskTimeout: number;
  orphanGraceMinutes: number;
  runtimeResourceRetentionMinutes: number;
  runOutcomeRetentionDays: number;
  webhookMaxAgeSeconds: number;
  allowLinearMerge: boolean;
  sandboxEventPollIntervalMs: number;
  stallTimeoutSeconds: number;
  pipelineCatalogPath: string;
  sandboxRuntimeRelease: string;
  sandboxRuntimeDescriptorPath: string;
}

export function loadConfig(): Config {
  const cfg: Config = {
    port: optionalInt("PORT", 8080),
    databasePath: optional("DATABASE_PATH", "/data/openthrottle.db"),
    supervisorUrl: required("SUPERVISOR_URL").replace(/\/+$/, ""),
    statusToken: required("OT_STATUS_TOKEN"),
    deployToken: required("OT_DEPLOY_TOKEN"),
    installSecret: required("OT_INSTALL_SECRET"),

    linearWebhookSecret: process.env.LINEAR_WEBHOOK_SECRET,
    linearClientId: process.env.LINEAR_CLIENT_ID,
    linearClientSecret: process.env.LINEAR_CLIENT_SECRET,

    githubWebhookSecret: required("GITHUB_WEBHOOK_SECRET"),
    githubToken: required("GITHUB_TOKEN"),
    githubReadToken: required("GITHUB_READ_TOKEN"),

    daytonaApiKey: required("DAYTONA_API_KEY"),
    daytonaSnapshot: optional("DAYTONA_SNAPSHOT", "openthrottle"),
    daytonaTotalMemoryGib: optionalInt("DAYTONA_TOTAL_MEMORY_GIB", 10),
    daytonaSandboxMemoryGib: optionalInt("DAYTONA_SANDBOX_MEMORY_GIB", 8),

    defaultAgent: optionalAgent("DEFAULT_AGENT", "codex"),
    claudeCodeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    codexAuthJson: process.env.CODEX_AUTH_JSON,
    kimiCodeApiKey: process.env.KIMI_CODE_API_KEY,

    taskTimeout: optionalInt("TASK_TIMEOUT", 7200),
    orphanGraceMinutes: optionalInt("ORPHAN_GRACE_MINUTES", 5),
    runtimeResourceRetentionMinutes: optionalInt("RUNTIME_RESOURCE_RETENTION_MINUTES", 60),
    runOutcomeRetentionDays: optionalInt("RUN_OUTCOME_RETENTION_DAYS", 180),
    webhookMaxAgeSeconds: optionalInt("WEBHOOK_MAX_AGE_SECONDS", 60),
    allowLinearMerge: optionalBool("ALLOW_LINEAR_MERGE", false),
    sandboxEventPollIntervalMs: optionalInt("SANDBOX_EVENT_POLL_INTERVAL_MS", 5_000),
    stallTimeoutSeconds: optionalInt("STALL_TIMEOUT_SECONDS", 900),
    pipelineCatalogPath: optional(
      "PIPELINE_CATALOG_PATH",
      fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url))
    ),
    sandboxRuntimeRelease: optional("SANDBOX_RUNTIME_RELEASE", "openthrottle-snapshot/v13"),
    sandboxRuntimeDescriptorPath: optional(
      "SANDBOX_RUNTIME_DESCRIPTOR_PATH",
      fileURLToPath(new URL("../../pipelines/runtime-capabilities-v1.json", import.meta.url))
    ),
  };

  if (!cfg.claudeCodeOauthToken) {
    console.warn(
      "[config] CLAUDE_CODE_OAUTH_TOKEN is not set — claude agent will not be usable"
    );
  }
  if (!cfg.codexAuthJson) {
    console.warn(
      "[config] CODEX_AUTH_JSON is not set — codex agent will not be usable"
    );
  }
  if (!cfg.kimiCodeApiKey) {
    console.warn(
      "[config] KIMI_CODE_API_KEY is not set — opencode agent will not be usable"
    );
  }
  if (!cfg.linearWebhookSecret || !cfg.linearClientId || !cfg.linearClientSecret) {
    console.warn(
      "[config] LINEAR_* is incomplete — Linear control webhooks and installation will be unavailable"
    );
  }
  requireRange("PORT", cfg.port, 1, 65_535);
  requireRange("TASK_TIMEOUT", cfg.taskTimeout, 1, 86_400);
  requireRange("ORPHAN_GRACE_MINUTES", cfg.orphanGraceMinutes, 0);
  requireRange("RUNTIME_RESOURCE_RETENTION_MINUTES", cfg.runtimeResourceRetentionMinutes, 0);
  requireRange("RUN_OUTCOME_RETENTION_DAYS", cfg.runOutcomeRetentionDays, 1);
  requireRange("WEBHOOK_MAX_AGE_SECONDS", cfg.webhookMaxAgeSeconds, 1);
  requireRange("SANDBOX_EVENT_POLL_INTERVAL_MS", cfg.sandboxEventPollIntervalMs, 1_000);
  requireRange("DAYTONA_TOTAL_MEMORY_GIB", cfg.daytonaTotalMemoryGib!, 1);
  requireRange("DAYTONA_SANDBOX_MEMORY_GIB", cfg.daytonaSandboxMemoryGib!, 1);
  requireRange("STALL_TIMEOUT_SECONDS", cfg.stallTimeoutSeconds, 60);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(cfg.sandboxRuntimeRelease)) {
    throw new Error(`SANDBOX_RUNTIME_RELEASE has an invalid format: ${cfg.sandboxRuntimeRelease}`);
  }
  if (cfg.deployToken === cfg.statusToken || cfg.deployToken === cfg.installSecret) {
    throw new Error("OT_DEPLOY_TOKEN must be distinct from OT_STATUS_TOKEN and OT_INSTALL_SECRET");
  }
  if (cfg.statusToken === cfg.installSecret) {
    throw new Error("OT_STATUS_TOKEN must be distinct from OT_INSTALL_SECRET");
  }
  try {
    const url = new URL(cfg.supervisorUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported protocol");
  } catch {
    throw new Error(`SUPERVISOR_URL must be an absolute HTTP(S) URL, got: ${cfg.supervisorUrl}`);
  }

  return cfg;
}
