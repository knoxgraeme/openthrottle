import { join, resolve } from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!/^-?\d+$/.test(raw.trim()) || !Number.isSafeInteger(value)) {
    throw new Error(`Env var ${name} must be an integer, got: ${raw}`);
  }
  return value;
}

function requireRange(name: string, value: number, min: number, max = Number.MAX_SAFE_INTEGER): void {
  if (value < min || value > max) {
    throw new Error(`Env var ${name} must be between ${min} and ${max}, got: ${value}`);
  }
}

export interface Config {
  port: number;
  databasePath: string;
  supervisorUrl: string;
  statusToken: string;
  deployToken: string;
  linearWebhookSecret: string | undefined;
  githubWebhookSecret: string;
  githubToken: string;
  githubReadToken: string;
  daytonaApiKey: string;
  daytonaSnapshot: string;
  claudeCodeOauthToken: string | undefined;
  codexAuthJson: string | undefined;
  kimiCodeApiKey: string | undefined;
  taskTimeout: number;
  webhookMaxAgeSeconds: number;
  blobStorePath: string;
  blobStoreId: string;
  epochReleaseId: string;
  epochBootstrapChecksum: string;
  releaseRoot: string;
  generatedDefinitionRoot: string;
  kernelWorkerId: string;
  kernelWorkerIntervalMs: number;
  kernelLeaseSeconds: number;
  kernelCycleLimit: number;
}

export function loadConfig(): Config {
  const releaseRoot = resolve(optional("OT_RELEASE_ROOT", process.cwd()));
  const cfg: Config = {
    port: optionalInt("PORT", 8080),
    databasePath: optional("DATABASE_PATH", "/data/openthrottle-kernel-v1.sqlite"),
    supervisorUrl: required("SUPERVISOR_URL").replace(/\/+$/, ""),
    statusToken: required("OT_STATUS_TOKEN"),
    deployToken: required("OT_DEPLOY_TOKEN"),
    linearWebhookSecret: process.env.LINEAR_WEBHOOK_SECRET,
    githubWebhookSecret: required("GITHUB_WEBHOOK_SECRET"),
    githubToken: required("GITHUB_TOKEN"),
    githubReadToken: required("GITHUB_READ_TOKEN"),
    daytonaApiKey: required("DAYTONA_API_KEY"),
    daytonaSnapshot: optional("DAYTONA_SNAPSHOT", "openthrottle"),
    claudeCodeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    codexAuthJson: process.env.CODEX_AUTH_JSON,
    kimiCodeApiKey: process.env.KIMI_CODE_API_KEY,
    taskTimeout: optionalInt("TASK_TIMEOUT", 7_200),
    webhookMaxAgeSeconds: optionalInt("WEBHOOK_MAX_AGE_SECONDS", 60),
    blobStorePath: resolve(optional("OT_BLOB_STORE_PATH", "/data/openthrottle-kernel-v1-blobs")),
    blobStoreId: optional("OT_BLOB_STORE_ID", "openthrottle-execution-kernel-v1"),
    epochReleaseId: optional("OT_EPOCH_RELEASE_ID", "openthrottle-execution-kernel/v1"),
    epochBootstrapChecksum: required("OT_EPOCH_BOOTSTRAP_CHECKSUM"),
    releaseRoot,
    generatedDefinitionRoot: resolve(optional(
      "OT_GENERATED_DEFINITION_ROOT",
      join(releaseRoot, "contracts/generated"),
    )),
    kernelWorkerId: optional("OT_KERNEL_WORKER_ID", "supervisor-primary"),
    kernelWorkerIntervalMs: optionalInt("OT_KERNEL_WORKER_INTERVAL_MS", 1_000),
    kernelLeaseSeconds: optionalInt("OT_KERNEL_LEASE_SECONDS", 120),
    kernelCycleLimit: optionalInt("OT_KERNEL_CYCLE_LIMIT", 16),
  };

  for (const [credential, engine] of [
    [cfg.claudeCodeOauthToken, "claude"],
    [cfg.codexAuthJson, "codex"],
    [cfg.kimiCodeApiKey, "opencode"],
  ] as const) {
    if (!credential) console.warn(`[config] model credential is not set — ${engine} will not be usable`);
  }
  if (!cfg.linearWebhookSecret) {
    console.warn("[config] LINEAR_WEBHOOK_SECRET is not set — Linear control webhooks are disabled");
  }

  requireRange("PORT", cfg.port, 1, 65_535);
  requireRange("TASK_TIMEOUT", cfg.taskTimeout, 1, 86_400);
  requireRange("WEBHOOK_MAX_AGE_SECONDS", cfg.webhookMaxAgeSeconds, 1);
  requireRange("OT_KERNEL_WORKER_INTERVAL_MS", cfg.kernelWorkerIntervalMs, 100, 60_000);
  requireRange("OT_KERNEL_LEASE_SECONDS", cfg.kernelLeaseSeconds, 30, 3_600);
  requireRange("OT_KERNEL_CYCLE_LIMIT", cfg.kernelCycleLimit, 1, 100);
  for (const [name, value] of [
    ["OT_BLOB_STORE_ID", cfg.blobStoreId],
    ["OT_EPOCH_RELEASE_ID", cfg.epochReleaseId],
    ["OT_KERNEL_WORKER_ID", cfg.kernelWorkerId],
  ] as const) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) {
      throw new Error(`${name} has an invalid format: ${value}`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(cfg.epochBootstrapChecksum)) {
    throw new Error("OT_EPOCH_BOOTSTRAP_CHECKSUM must be a lowercase SHA-256 digest");
  }
  if (cfg.deployToken === cfg.statusToken) {
    throw new Error("OT_DEPLOY_TOKEN must be distinct from OT_STATUS_TOKEN");
  }
  try {
    const url = new URL(cfg.supervisorUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported protocol");
  } catch {
    throw new Error(`SUPERVISOR_URL must be an absolute HTTP(S) URL, got: ${cfg.supervisorUrl}`);
  }
  return cfg;
}
