import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

const originalEnv = { ...process.env };
const configKeys = [
  "PORT", "DATABASE_PATH", "SUPERVISOR_URL", "OT_STATUS_TOKEN", "OT_DEPLOY_TOKEN",
  "LINEAR_WEBHOOK_SECRET", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET", "GITHUB_TOKEN", "GITHUB_READ_TOKEN",
  "DAYTONA_API_KEY", "DAYTONA_SNAPSHOT", "DAYTONA_SANDBOX_MIN_FREE_MIB",
  "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_AUTH_JSON",
  "KIMI_CODE_API_KEY", "TASK_TIMEOUT", "WEBHOOK_MAX_AGE_SECONDS", "OT_BLOB_STORE_PATH",
  "OT_BLOB_STORE_ID", "OT_EPOCH_RELEASE_ID", "OT_RELEASE_ROOT",
  "OT_EPOCH_BOOTSTRAP_CHECKSUM",
  "OT_GENERATED_DEFINITION_ROOT", "OT_KERNEL_WORKER_ID", "OT_KERNEL_WORKER_INTERVAL_MS",
  "OT_KERNEL_LEASE_SECONDS", "OT_KERNEL_CYCLE_LIMIT",
  // Retired variables are cleared so they cannot influence a clean-epoch test.
  "OT_INSTALL_SECRET", "DEFAULT_AGENT",
  "REVIEW_FANOUT_CONCURRENCY", "PIPELINE_CATALOG_PATH", "SANDBOX_RUNTIME_RELEASE",
];

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

function setRequiredEnv(): void {
  for (const name of configKeys) delete process.env[name];
  Object.assign(process.env, {
    SUPERVISOR_URL: "https://openthrottle.test/",
    OT_STATUS_TOKEN: "status",
    OT_DEPLOY_TOKEN: "deploy",
    LINEAR_WEBHOOK_SECRET: "linear-webhook",
    LINEAR_CLIENT_ID: "linear-client-id",
    LINEAR_CLIENT_SECRET: "linear-client-secret",
    GITHUB_WEBHOOK_SECRET: "github-webhook",
    GITHUB_TOKEN: "github-token",
    GITHUB_READ_TOKEN: "github-read-token",
    DAYTONA_API_KEY: "daytona",
    CLAUDE_CODE_OAUTH_TOKEN: "claude",
    CODEX_AUTH_JSON: "{}",
    KIMI_CODE_API_KEY: "kimi",
    OT_EPOCH_BOOTSTRAP_CHECKSUM: "b".repeat(64),
  });
}

describe("loadConfig", () => {
  it("loads only the fresh-kernel settings and defaults", () => {
    setRequiredEnv();

    const config = loadConfig();
    expect(config).toMatchObject({
      supervisorUrl: "https://openthrottle.test",
      deployToken: "deploy",
      port: 8080,
      taskTimeout: 7_200,
      webhookMaxAgeSeconds: 60,
      linearWebhookSecret: "linear-webhook",
      linearClientId: "linear-client-id",
      linearClientSecret: "linear-client-secret",
      githubReadToken: "github-read-token",
      daytonaSnapshot: "openthrottle",
      daytonaSandboxMinFreeMiB: 2_048,
      databasePath: "/data/openthrottle-kernel-v1.sqlite",
      blobStorePath: "/data/openthrottle-kernel-v1-blobs",
      kernelWorkerIntervalMs: 1_000,
      kernelLeaseSeconds: 120,
      kernelCycleLimit: 16,
      epochBootstrapChecksum: "b".repeat(64),
    });
    for (const retired of [
      "installSecret", "defaultAgent",
      "reviewFanoutConcurrency", "pipelineCatalogPath", "sandboxRuntimeRelease",
    ]) {
      expect(config).not.toHaveProperty(retired);
    }
  });

  it("allows GitHub-only control while retaining required GitHub authority", () => {
    setRequiredEnv();
    delete process.env.LINEAR_WEBHOOK_SECRET;
    delete process.env.LINEAR_CLIENT_ID;
    delete process.env.LINEAR_CLIENT_SECRET;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadConfig()).toMatchObject({
      linearWebhookSecret: undefined,
      linearClientId: undefined,
      linearClientSecret: undefined,
    });

    delete process.env.GITHUB_TOKEN;
    expect(() => loadConfig()).toThrow("Missing required env var: GITHUB_TOKEN");
  });

  it.each([
    ["LINEAR_WEBHOOK_SECRET", ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"]],
    ["LINEAR_CLIENT_ID", ["LINEAR_WEBHOOK_SECRET", "LINEAR_CLIENT_SECRET"]],
    ["LINEAR_CLIENT_SECRET", ["LINEAR_WEBHOOK_SECRET", "LINEAR_CLIENT_ID"]],
  ] as const)("rejects partial Linear control configuration when only %s is set", (present, missing) => {
    setRequiredEnv();
    for (const name of ["LINEAR_WEBHOOK_SECRET", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"] as const) {
      if (name !== present) delete process.env[name];
    }

    expect(() => loadConfig()).toThrow(
      `Linear control requires LINEAR_WEBHOOK_SECRET, LINEAR_CLIENT_ID, and LINEAR_CLIENT_SECRET together (missing: ${missing.join(", ")})`
    );
  });

  it("requires distinct operator and deployment credentials", () => {
    setRequiredEnv();
    delete process.env.OT_DEPLOY_TOKEN;
    expect(() => loadConfig()).toThrow("Missing required env var: OT_DEPLOY_TOKEN");

    process.env.OT_DEPLOY_TOKEN = "status";
    expect(() => loadConfig()).toThrow("OT_DEPLOY_TOKEN must be distinct from OT_STATUS_TOKEN");
  });

  it("rejects malformed and out-of-range numeric settings", () => {
    setRequiredEnv();
    process.env.PORT = "8080junk";
    expect(() => loadConfig()).toThrow("PORT must be an integer");

    process.env.PORT = "8080";
    process.env.TASK_TIMEOUT = "86401";
    expect(() => loadConfig()).toThrow("TASK_TIMEOUT must be between 1 and 86400");

    process.env.TASK_TIMEOUT = "7200";
    process.env.OT_KERNEL_LEASE_SECONDS = "29";
    expect(() => loadConfig()).toThrow("OT_KERNEL_LEASE_SECONDS must be between 30");
  });

  it.each([
    ["1", 1],
    ["4096", 4_096],
  ])("accepts positive DAYTONA_SANDBOX_MIN_FREE_MIB=%s", (raw, expected) => {
    setRequiredEnv();
    process.env.DAYTONA_SANDBOX_MIN_FREE_MIB = raw;
    expect(loadConfig().daytonaSandboxMinFreeMiB).toBe(expected);
  });

  it("uses the disk reserve default for a blank override", () => {
    setRequiredEnv();
    process.env.DAYTONA_SANDBOX_MIN_FREE_MIB = "   ";
    expect(loadConfig().daytonaSandboxMinFreeMiB).toBe(2_048);
  });

  it.each(["0", "-1", "1.5", "many"])(
    "rejects invalid DAYTONA_SANDBOX_MIN_FREE_MIB=%s",
    (raw) => {
      setRequiredEnv();
      process.env.DAYTONA_SANDBOX_MIN_FREE_MIB = raw;
      expect(() => loadConfig()).toThrow(/DAYTONA_SANDBOX_MIN_FREE_MIB/);
    },
  );

  it("validates stable kernel identities and the public URL", () => {
    setRequiredEnv();
    process.env.OT_BLOB_STORE_ID = "unsafe value";
    expect(() => loadConfig()).toThrow("OT_BLOB_STORE_ID has an invalid format");

    process.env.OT_BLOB_STORE_ID = "kernel-v1";
    process.env.OT_EPOCH_BOOTSTRAP_CHECKSUM = "B".repeat(64);
    expect(() => loadConfig()).toThrow("OT_EPOCH_BOOTSTRAP_CHECKSUM must be a lowercase SHA-256 digest");

    process.env.OT_EPOCH_BOOTSTRAP_CHECKSUM = "b".repeat(64);
    process.env.SUPERVISOR_URL = "relative/path";
    expect(() => loadConfig()).toThrow("SUPERVISOR_URL must be an absolute HTTP(S) URL");
  });

  it("requires the exact offline-bootstrap checksum", () => {
    setRequiredEnv();
    delete process.env.OT_EPOCH_BOOTSTRAP_CHECKSUM;

    expect(() => loadConfig()).toThrow("Missing required env var: OT_EPOCH_BOOTSTRAP_CHECKSUM");
  });
});
