// Env parsing per docs/SPEC.md "Supervisor env" list.
// Fail fast (throw at boot) for vars the supervisor cannot function without.
// Agent subscription credentials are checked against the selected agent before
// provisioning so one unavailable agent does not prevent the supervisor booting.

import type { Agent } from "./db.js";
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

const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isSafeBranchName(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
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
  const value = process.env[name]?.trim().toLowerCase() ?? fallback;
  if (value === "claude" || value === "codex" || value === "opencode") return value;
  throw new Error(`Env var ${name} must be claude, codex, or opencode, got: ${value}`);
}

function optionalRepoMap(name: string): Record<string, string> {
  const value = process.env[name]?.trim();
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Env var ${name} must be valid JSON: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Env var ${name} must be a JSON object`);
  }
  const result: Record<string, string> = {};
  for (const [key, repo] of Object.entries(parsed)) {
    if (typeof repo !== "string" || !GITHUB_REPO_PATTERN.test(repo)) {
      throw new Error(`Env var ${name}.${key} must be an "owner/name" repository`);
    }
    result[key] = repo;
  }
  return result;
}

function optionalRepoList(name: string): string[] {
  const value = process.env[name]?.trim();
  if (!value) return [];
  const repositories = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const invalid = repositories.find((repository) => !GITHUB_REPO_PATTERN.test(repository));
  if (invalid) throw new Error(`Env var ${name} contains invalid repository: ${invalid}`);
  return [...new Set(repositories.map((repository) => repository.toLowerCase()))].sort();
}

export interface Config {
  port: number;
  databasePath: string;
  supervisorUrl: string;
  statusToken: string;
  installSecret: string;

  linearWebhookSecret: string;
  linearClientId: string;
  linearClientSecret: string;

  githubWebhookSecret: string;
  githubToken: string;
  githubRepo: string;
  githubRepoMappings: Record<string, string>;
  githubRepoLabelMappings: Record<string, string>;
  gitAuthorName?: string;
  gitAuthorEmail?: string;

  daytonaApiKey: string;
  daytonaSnapshot: string;

  defaultAgent: Agent;
  claudeCodeOauthToken: string | undefined;
  codexAuthJson: string | undefined;
  kimiCodeApiKey: string | undefined;

  baseBranch: string;
  maxTurns: number;
  taskTimeout: number;
  callbackGraceSeconds: number;
  devPort: number;
  sweepMaxAgeDays: number;
  orphanGraceMinutes: number;
  webhookMaxAgeSeconds: number;
  reviewMaxRounds: number;
  reviewNudgeComment: string;
  allowLinearMerge: boolean;
  sandboxEventPollIntervalMs: number;
  stallTimeoutSeconds: number;
  pipelineAdmissionEnabled: boolean;
  pipelineAdmissionRepositories?: string[];
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
    installSecret: required("OT_INSTALL_SECRET"),

    linearWebhookSecret: required("LINEAR_WEBHOOK_SECRET"),
    linearClientId: required("LINEAR_CLIENT_ID"),
    linearClientSecret: required("LINEAR_CLIENT_SECRET"),

    githubWebhookSecret: required("GITHUB_WEBHOOK_SECRET"),
    githubToken: required("GITHUB_TOKEN"),
    githubRepo: required("GITHUB_REPO"),
    githubRepoMappings: optionalRepoMap("GITHUB_REPO_MAPPINGS"),
    githubRepoLabelMappings: optionalRepoMap("GITHUB_REPO_LABEL_MAPPINGS"),
    gitAuthorName: process.env.OT_GIT_AUTHOR_NAME,
    gitAuthorEmail: process.env.OT_GIT_AUTHOR_EMAIL,

    daytonaApiKey: required("DAYTONA_API_KEY"),
    daytonaSnapshot: optional("DAYTONA_SNAPSHOT", "openthrottle"),

    defaultAgent: optionalAgent("DEFAULT_AGENT", "codex"),
    claudeCodeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    codexAuthJson: process.env.CODEX_AUTH_JSON,
    kimiCodeApiKey: process.env.KIMI_CODE_API_KEY,

    baseBranch: optional("BASE_BRANCH", "main"),
    maxTurns: optionalInt("MAX_TURNS", 200),
    taskTimeout: optionalInt("TASK_TIMEOUT", 7200),
    callbackGraceSeconds: optionalInt("CALLBACK_GRACE_SECONDS", 120),
    devPort: optionalInt("DEV_PORT", 3000),
    sweepMaxAgeDays: optionalInt("SWEEP_MAX_AGE_DAYS", 14),
    orphanGraceMinutes: optionalInt("ORPHAN_GRACE_MINUTES", 5),
    webhookMaxAgeSeconds: optionalInt("WEBHOOK_MAX_AGE_SECONDS", 60),
    reviewMaxRounds: optionalInt("REVIEW_MAX_ROUNDS", 3),
    reviewNudgeComment: optional("REVIEW_NUDGE_COMMENT", ""),
    allowLinearMerge: optionalBool("ALLOW_LINEAR_MERGE", false),
    sandboxEventPollIntervalMs: optionalInt("SANDBOX_EVENT_POLL_INTERVAL_MS", 5_000),
    stallTimeoutSeconds: optionalInt("STALL_TIMEOUT_SECONDS", 900),
    pipelineAdmissionEnabled: optionalBool("PIPELINE_COORDINATOR_ENABLED", false),
    pipelineAdmissionRepositories: optionalRepoList("PIPELINE_COORDINATOR_REPOSITORIES"),
    pipelineCatalogPath: optional(
      "PIPELINE_CATALOG_PATH",
      fileURLToPath(new URL("../pipelines/catalog.yaml", import.meta.url))
    ),
    sandboxRuntimeRelease: optional("SANDBOX_RUNTIME_RELEASE", "openthrottle-snapshot/v1"),
    sandboxRuntimeDescriptorPath: optional(
      "SANDBOX_RUNTIME_DESCRIPTOR_PATH",
      fileURLToPath(new URL("../pipelines/runtime-capabilities-v1.json", import.meta.url))
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
  if (!GITHUB_REPO_PATTERN.test(cfg.githubRepo)) {
    throw new Error(`GITHUB_REPO must be "owner/name", got: ${cfg.githubRepo}`);
  }
  if (!isSafeBranchName(cfg.baseBranch)) {
    throw new Error(`BASE_BRANCH must be a safe Git branch name, got: ${cfg.baseBranch}`);
  }
  requireRange("PORT", cfg.port, 1, 65_535);
  requireRange("DEV_PORT", cfg.devPort, 1, 65_535);
  requireRange("MAX_TURNS", cfg.maxTurns, 1);
  requireRange("TASK_TIMEOUT", cfg.taskTimeout, 1);
  requireRange("CALLBACK_GRACE_SECONDS", cfg.callbackGraceSeconds, 0);
  requireRange("SWEEP_MAX_AGE_DAYS", cfg.sweepMaxAgeDays, 1);
  requireRange("ORPHAN_GRACE_MINUTES", cfg.orphanGraceMinutes, 0);
  requireRange("WEBHOOK_MAX_AGE_SECONDS", cfg.webhookMaxAgeSeconds, 1);
  requireRange("REVIEW_MAX_ROUNDS", cfg.reviewMaxRounds, 1);
  requireRange("SANDBOX_EVENT_POLL_INTERVAL_MS", cfg.sandboxEventPollIntervalMs, 1_000);
  requireRange("STALL_TIMEOUT_SECONDS", cfg.stallTimeoutSeconds, 60);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(cfg.sandboxRuntimeRelease)) {
    throw new Error(`SANDBOX_RUNTIME_RELEASE has an invalid format: ${cfg.sandboxRuntimeRelease}`);
  }
  try {
    const url = new URL(cfg.supervisorUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported protocol");
  } catch {
    throw new Error(`SUPERVISOR_URL must be an absolute HTTP(S) URL, got: ${cfg.supervisorUrl}`);
  }

  return cfg;
}
