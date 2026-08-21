import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AdapterContext,
  HostingEnsureResult,
  ProviderEvidence,
  ProviderPendingEvidence,
  ReleaseManifest,
  SupervisorDeploymentBundle,
} from "../../contracts.js";
import { validateProfile } from "../../profile-store.js";
import { LocalFileSecretStore } from "../../secret-store.js";
import { FlyctlCommandError, FlyctlNotFoundError, type FlyctlResult, type FlyctlRunner } from "./flyctl.js";
import { createFlyHostingAdapter, createProfileSecretsPort, type FlySecretsPort } from "./hosting-adapter.js";

const release: ReleaseManifest = {
  schema: "openthrottle.release-manifest/v1",
  cliVersion: "2.0.0",
  releaseId: "v2.0.0",
  supervisorImage: `ghcr.io/acme/supervisor@sha256:${"a".repeat(64)}`,
  sandboxImage: `ghcr.io/acme/sandbox@sha256:${"b".repeat(64)}`,
  runtime: { release: "sandbox-v2", descriptorDigest: `sha256:${"c".repeat(64)}` },
  recommendedResources: { cpu: 2, memoryMb: 4096, diskGb: 20 },
};

const context: AdapterContext = {
  profileName: "default",
  release,
  now: () => new Date("2026-08-14T00:00:00.000Z"),
};

const bundle: SupervisorDeploymentBundle = {
  release,
  runtime: {
    providerId: "daytona",
    configuration: { snapshot: "openthrottle-ce-abc1234" },
    secrets: {},
  },
  secrets: {
    OT_STATUS_TOKEN: { owner: "cli", name: "status_token" },
    OT_DEPLOY_TOKEN: { owner: "provisioning", name: "deploy_token" },
    LINEAR_WEBHOOK_SECRET: { owner: "provisioning", name: "linear_webhook_secret" },
    GITHUB_WEBHOOK_SECRET: { owner: "provisioning", name: "github_webhook_secret" },
    GITHUB_TOKEN: { owner: "operator", name: "github_token" },
    GITHUB_READ_TOKEN: { owner: "operator", name: "github_read_token" },
    DAYTONA_API_KEY: { owner: "operator", name: "daytona_api_key" },
  },
};

const APP = "openthrottle-supervisor";
const OPERATOR_NAMES = ["DAYTONA_API_KEY", "GITHUB_READ_TOKEN", "GITHUB_TOKEN"];
const ALL_SECRET_NAMES = [
  ...OPERATOR_NAMES,
  "DAYTONA_SNAPSHOT",
  "GITHUB_WEBHOOK_SECRET",
  "LINEAR_WEBHOOK_SECRET",
  "OT_DEPLOY_TOKEN",
  "OT_STATUS_TOKEN",
  "SUPERVISOR_URL",
];
const RELEASE_MACHINE_IMAGE = `registry.fly.io/${APP}@sha256:${"a".repeat(64)}`;

class FakeFly {
  apps: string[] = [];
  volumes: string[] = [];
  secrets: string[] = [];
  machines: { state: string; image?: string }[] = [];
  calls: string[][] = [];
  fetches: string[] = [];
  failures = new Map<string, { code: number; stderr: string }>();
  healthzStatus = 200;
  authenticated = true;
  binaryMissing = false;
  deployConfig?: string;

  readonly runner: FlyctlRunner = {
    run: async (args: string[]): Promise<FlyctlResult> => this.run(args),
  };

  readonly fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
    this.fetches.push(String(url));
    return new Response("ok", { status: this.healthzStatus });
  }) as typeof fetch;

  makeReady(): void {
    this.apps = [APP];
    this.volumes = ["openthrottle_data"];
    this.secrets = [...ALL_SECRET_NAMES];
    this.machines = [{ state: "started", image: RELEASE_MACHINE_IMAGE }];
  }

  private ok(payload: unknown): FlyctlResult {
    return { stdout: JSON.stringify(payload), stderr: "", code: 0 };
  }

  private async run(args: string[]): Promise<FlyctlResult> {
    this.calls.push([...args]);
    if (this.binaryMissing) throw new FlyctlNotFoundError();
    const key = args[0] === "auth" ? "auth whoami" : args[0] === "deploy" ? "deploy" : `${args[0]} ${args[1]}`;
    const failure = this.failures.get(key);
    if (failure) return { stdout: "", stderr: failure.stderr, code: failure.code };
    switch (key) {
      case "version --json":
        return this.ok({ Name: "flyctl", Version: "0.3.100" });
      case "auth whoami":
        if (!this.authenticated) {
          return { stdout: "", stderr: "Error: No access token available. Please login with 'flyctl auth login'", code: 1 };
        }
        return this.ok({ email: "ops@example.com" });
      case "apps list":
        return this.ok(this.apps.map((name) => ({ Name: name })));
      case "apps create": {
        const name = args[2] ?? "";
        if (this.apps.includes(name)) {
          return { stdout: "", stderr: "Error: Name has already been taken", code: 1 };
        }
        this.apps.push(name);
        return this.ok({});
      }
      case "volumes list":
        return this.ok(this.volumes.map((name) => ({ name, state: "created" })));
      case "volumes create":
        this.volumes.push(args[2] ?? "");
        return this.ok({});
      case "secrets list":
        return this.ok(this.secrets.map((name) => ({ Name: name, Digest: "digest" })));
      case "secrets set":
        for (const arg of args) {
          const separator = arg.indexOf("=");
          if (separator > 0) {
            const name = arg.slice(0, separator);
            if (!this.secrets.includes(name)) this.secrets.push(name);
          }
        }
        return this.ok({});
      case "machines list":
        return this.ok(this.machines.map((machine) => ({ state: machine.state, config: { image: machine.image } })));
      case "deploy": {
        const configIndex = args.indexOf("--config");
        const imageIndex = args.indexOf("--image");
        this.deployConfig = readFileSync(args[configIndex + 1] ?? "", "utf8");
        this.machines = [{ state: "started", image: args[imageIndex + 1] ?? "" }];
        return this.ok({});
      }
      default:
        throw new Error(`unexpected flyctl invocation: ${key}`);
    }
  }
}

class FakeSecretsPort implements FlySecretsPort {
  values = new Map<string, string>();
  generated: string[] = [];
  getCalls: string[] = [];

  get(name: string): string | undefined {
    this.getCalls.push(name);
    return this.values.get(name);
  }

  generate(name: string): string {
    this.generated.push(name);
    const value = `generated-${name}-secret-value`;
    this.values.set(name, value);
    return value;
  }
}

function createHarness(overrides: Partial<Parameters<typeof createFlyHostingAdapter>[0]> = {}) {
  const fly = new FakeFly();
  const port = new FakeSecretsPort();
  const logs: string[] = [];
  const adapter = createFlyHostingAdapter({
    runner: fly.runner,
    fetchImpl: fly.fetchImpl,
    secrets: port,
    log: (message) => logs.push(message),
    ...overrides,
  });
  return { fly, port, logs, adapter };
}

function asPending(result: HostingEnsureResult | ProviderPendingEvidence): ProviderPendingEvidence {
  if ("evidence" in result) throw new Error("expected pending evidence, got an ensure result");
  return result;
}

function asReady(result: HostingEnsureResult | ProviderPendingEvidence): HostingEnsureResult {
  if (!("evidence" in result)) throw new Error("expected an ensure result, got pending evidence");
  return result;
}

function expectValidEvidence(evidence: ProviderEvidence): void {
  // profile-store's evidence validator is private; validating a profile that
  // embeds the evidence exercises the same code path.
  expect(() =>
    validateProfile({
      schema: "openthrottle.profile/v1",
      name: "default",
      providers: { hosting: "fly", runtime: "daytona" },
      resources: {},
      evidence: { hosting: evidence },
      updatedAt: "2026-08-14T00:00:00.000Z",
    })
  ).not.toThrow();
}

const mutationCalls = (fly: FakeFly) =>
  fly.calls.filter((args) => args[0] === "deploy" || args[1] === "create" || (args[0] === "secrets" && args[1] === "set"));

describe("fly hosting adapter preflight", () => {
  it("reports a missing flyctl binary as operator needs_action with install instructions", async () => {
    const { fly, adapter } = createHarness();
    fly.binaryMissing = true;
    const evidence = await adapter.preflight(context);
    expect(evidence.status).toBe("needs_action");
    expect(evidence.owner).toBe("operator");
    expect(evidence.recoveryAction).toContain("Install flyctl");
    expectValidEvidence(evidence);
  });

  it("reports an unauthenticated flyctl with the auth login recovery", async () => {
    const { fly, adapter } = createHarness();
    fly.authenticated = false;
    const evidence = await adapter.preflight(context);
    expect(evidence.status).toBe("needs_action");
    expect(evidence.owner).toBe("operator");
    expect(evidence.recoveryAction).toContain("flyctl auth login");
    expect(evidence.recoveryAction).toContain("FLY_API_TOKEN");
    expectValidEvidence(evidence);
  });

  it("summarizes version and account when ready", async () => {
    const { adapter } = createHarness();
    const evidence = await adapter.preflight(context);
    expect(evidence.status).toBe("ready");
    expect(evidence.summary).toContain("0.3.100");
    expect(evidence.summary).toContain("ops@example.com");
    expectValidEvidence(evidence);
  });

  it("builds its default runner from the provided environment", async () => {
    const port = new FakeSecretsPort();
    const adapter = createFlyHostingAdapter({ env: { PATH: "/nonexistent-openthrottle-path" }, secrets: port });
    const evidence = await adapter.preflight(context);
    expect(evidence.status).toBe("needs_action");
    expect(evidence.owner).toBe("operator");
    expect(evidence.summary).toContain("flyctl was not found");
  });
});

describe("fly hosting adapter inspect", () => {
  it("reports a missing app with the exact create recovery", async () => {
    const { adapter } = createHarness();
    const evidence = asPending(await adapter.inspect(context));
    expect(evidence.status).toBe("needs_action");
    expect(evidence.owner).toBe("hosting_provider");
    expect(evidence.summary).toContain(`app ${APP}: missing`);
    expect(evidence.recoveryAction).toBe(`flyctl apps create ${APP} --org personal`);
    expectValidEvidence(evidence);
  });

  it("reports a missing data volume with the exact create recovery", async () => {
    const { fly, adapter } = createHarness();
    fly.makeReady();
    fly.volumes = [];
    const evidence = asPending(await adapter.inspect(context));
    expect(evidence.status).toBe("needs_action");
    expect(evidence.summary).toContain("volume openthrottle_data: missing");
    expect(evidence.recoveryAction).toBe(`flyctl volumes create openthrottle_data --app ${APP} --region sjc --size 1`);
  });

  it("attributes missing provisioning secret names to the cli", async () => {
    const { fly, adapter } = createHarness();
    fly.makeReady();
    fly.secrets = fly.secrets.filter((name) => name !== "OT_DEPLOY_TOKEN" && name !== "LINEAR_WEBHOOK_SECRET");
    const evidence = asPending(await adapter.inspect(context));
    expect(evidence.status).toBe("needs_action");
    expect(evidence.owner).toBe("cli");
    expect(evidence.summary).toContain("missing: LINEAR_WEBHOOK_SECRET, OT_DEPLOY_TOKEN");
    expect(evidence.recoveryAction).toBe("openthrottle setup");
  });

  it("attributes missing operator secret names with the exact secrets set line", async () => {
    const { fly, adapter } = createHarness();
    fly.makeReady();
    fly.secrets = fly.secrets.filter((name) => !OPERATOR_NAMES.includes(name));
    const evidence = asPending(await adapter.inspect(context));
    expect(evidence.status).toBe("needs_action");
    expect(evidence.owner).toBe("operator");
    expect(evidence.recoveryAction).toBe(
      `flyctl secrets set --app ${APP} DAYTONA_API_KEY=... GITHUB_READ_TOKEN=... GITHUB_TOKEN=...`
    );
    expectValidEvidence(evidence);
  });

  it("reports a stale deployed image against this release's digest", async () => {
    const { fly, adapter } = createHarness();
    fly.makeReady();
    fly.machines = [{ state: "started", image: `registry.fly.io/${APP}@sha256:${"f".repeat(64)}` }];
    const evidence = asPending(await adapter.inspect(context));
    expect(evidence.status).toBe("needs_action");
    expect(evidence.summary).toContain("deployed image is not this release");
    expect(evidence.recoveryAction).toBe(`flyctl deploy --app ${APP} --image ${release.supervisorImage}`);

    fly.machines = [{ state: "stopped", image: RELEASE_MACHINE_IMAGE }];
    const stopped = asPending(await adapter.inspect(context));
    expect(stopped.summary).toContain("no started machine");
    expect(stopped.recoveryAction).toBe(`flyctl deploy --app ${APP} --image ${release.supervisorImage}`);
  });

  it("reports a failing healthz probe as supervisor-owned", async () => {
    const { fly, adapter } = createHarness();
    fly.makeReady();
    fly.healthzStatus = 503;
    const evidence = asPending(await adapter.inspect(context));
    expect(evidence.status).toBe("needs_action");
    expect(evidence.owner).toBe("supervisor");
    expect(evidence.summary).toContain("healthz: failing");
    expect(evidence.recoveryAction).toBe(`flyctl logs --app ${APP}`);
    expect(fly.fetches).toEqual([`https://${APP}.fly.dev/healthz`]);
  });

  it("returns the supervisor URL with composite ready evidence when every tier passes", async () => {
    const { fly, adapter } = createHarness();
    fly.makeReady();
    const result = asReady(await adapter.inspect(context));
    expect(result.supervisorUrl).toBe(`https://${APP}.fly.dev`);
    expect(result.evidence.status).toBe("ready");
    expect(result.evidence.releaseId).toBe(release.releaseId);
    expect(result.evidence.summary).toContain(`app ${APP}: ok`);
    expect(result.evidence.summary).toContain("secrets: 9/9 set");
    expect(result.evidence.summary).toContain("release image: active");
    expect(result.evidence.summary).toContain("healthz: ok");
    expectValidEvidence(result.evidence);
  });

  it("degrades flyctl command failures into error evidence", async () => {
    const { fly, adapter } = createHarness();
    fly.makeReady();
    fly.failures.set("volumes list", { code: 1, stderr: "api unavailable" });
    const evidence = asPending(await adapter.inspect(context));
    expect(evidence.status).toBe("error");
    expect(evidence.owner).toBe("hosting_provider");
    expectValidEvidence(evidence);
  });

  it("honors custom app, org, and region options and rejects unsafe names", async () => {
    const { adapter } = createHarness({ app: "my-sup", org: "acme", region: "fra" });
    const evidence = asPending(await adapter.inspect(context));
    expect(evidence.recoveryAction).toBe("flyctl apps create my-sup --org acme");
    expect(() => createFlyHostingAdapter({ secrets: new FakeSecretsPort(), app: "Bad App!" })).toThrow("app name");
    expect(() => createFlyHostingAdapter({ secrets: new FakeSecretsPort(), region: "sjc; rm" })).toThrow("region");
  });
});

describe("fly hosting adapter plan", () => {
  it("plans every missing mutation in order for a fresh account", async () => {
    const { adapter, port } = createHarness();
    const plan = await adapter.plan(context, bundle);
    expect(plan.mutations).toEqual([
      `flyctl apps create ${APP} --org personal`,
      `flyctl volumes create openthrottle_data --app ${APP} --region sjc --size 1`,
      "set 6 supervisor secrets (names: DAYTONA_SNAPSHOT, GITHUB_WEBHOOK_SECRET, LINEAR_WEBHOOK_SECRET, OT_DEPLOY_TOKEN, OT_STATUS_TOKEN, SUPERVISOR_URL)",
      `flyctl deploy --app ${APP} --image ${release.supervisorImage}`,
    ]);
    expect(plan.billable).toBe(true);
    expect(plan.externallyVisible).toBe(true);
    expect(port.generated).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain("secret-value");
  });

  it("plans only a secrets mutation as neither billable nor externally visible", async () => {
    const { fly, adapter } = createHarness();
    fly.makeReady();
    fly.secrets = [...OPERATOR_NAMES];
    const plan = await adapter.plan(context, bundle);
    expect(plan.mutations).toEqual([
      "set 6 supervisor secrets (names: DAYTONA_SNAPSHOT, GITHUB_WEBHOOK_SECRET, LINEAR_WEBHOOK_SECRET, OT_DEPLOY_TOKEN, OT_STATUS_TOKEN, SUPERVISOR_URL)",
    ]);
    expect(plan.billable).toBe(false);
    expect(plan.externallyVisible).toBe(false);
  });

  it("classifies volume-only and deploy-only plans correctly", async () => {
    const volumeOnly = createHarness();
    volumeOnly.fly.makeReady();
    volumeOnly.fly.volumes = [];
    const volumePlan = await volumeOnly.adapter.plan(context, bundle);
    expect(volumePlan.mutations).toEqual([`flyctl volumes create openthrottle_data --app ${APP} --region sjc --size 1`]);
    expect(volumePlan.billable).toBe(true);
    expect(volumePlan.externallyVisible).toBe(false);

    const deployOnly = createHarness();
    deployOnly.fly.makeReady();
    deployOnly.fly.machines = [];
    const deployPlan = await deployOnly.adapter.plan(context, bundle);
    expect(deployPlan.mutations).toEqual([`flyctl deploy --app ${APP} --image ${release.supervisorImage}`]);
    expect(deployPlan.billable).toBe(true);
    expect(deployPlan.externallyVisible).toBe(true);
  });
});

describe("fly hosting adapter ensure", () => {
  it("bootstraps a fresh account with exact argv mutations in order", async () => {
    const { fly, port, logs, adapter } = createHarness();
    port.values.set("status_token", "PRESET_SENTINEL_STATUS");

    const result = await adapter.ensure(context, bundle);

    expect(mutationCalls(fly)).toEqual([
      ["apps", "create", APP, "--org", "personal"],
      ["volumes", "create", "openthrottle_data", "--app", APP, "--region", "sjc", "--size", "1", "--yes"],
      [
        "secrets",
        "set",
        "--app",
        APP,
        "--stage",
        "DAYTONA_SNAPSHOT=openthrottle-ce-abc1234",
        "GITHUB_WEBHOOK_SECRET=generated-github_webhook_secret-secret-value",
        "LINEAR_WEBHOOK_SECRET=generated-linear_webhook_secret-secret-value",
        "OT_DEPLOY_TOKEN=generated-deploy_token-secret-value",
        "OT_STATUS_TOKEN=PRESET_SENTINEL_STATUS",
        `SUPERVISOR_URL=https://${APP}.fly.dev`,
      ],
      [
        "deploy",
        "--app",
        APP,
        "--config",
        expect.stringMatching(/openthrottle-fly-.*fly\.toml$/) as unknown as string,
        "--image",
        release.supervisorImage,
      ],
    ]);

    // Generated secrets are minted through the port (persisted) and only for
    // absent cli/provisioning refs; operator refs are never generated.
    expect(port.generated).toEqual(["github_webhook_secret", "linear_webhook_secret", "deploy_token"]);
    expect(port.getCalls).toContain("status_token");
    for (const operatorRef of ["github_token", "github_read_token", "daytona_api_key"]) {
      expect(port.generated).not.toContain(operatorRef);
      expect(port.getCalls).not.toContain(operatorRef);
    }

    // The generated fly config mirrors supervisor/fly.toml.
    expect(fly.deployConfig).toContain(`app = "${APP}"`);
    expect(fly.deployConfig).toContain("internal_port = 8080");
    expect(fly.deployConfig).toContain('source = "openthrottle_data"');
    expect(fly.deployConfig).toContain('destination = "/data"');
    expect(fly.deployConfig).toContain('path = "/healthz"');

    // The temp config directory is always removed.
    const deployCall = fly.calls.find((args) => args[0] === "deploy");
    const configPath = deployCall?.[deployCall.indexOf("--config") + 1] ?? "";
    expect(existsSync(dirname(configPath))).toBe(false);

    // Operator secrets remain unset, so the post-mutation inspection reports
    // exactly that; healthz is not probed while secrets are missing.
    expect(result.supervisorUrl).toBeUndefined();
    expect(result.evidence.status).toBe("needs_action");
    expect(result.evidence.owner).toBe("operator");
    expect(result.evidence.recoveryAction).toBe(
      `flyctl secrets set --app ${APP} DAYTONA_API_KEY=... GITHUB_READ_TOKEN=... GITHUB_TOKEN=...`
    );
    expect(fly.fetches).toEqual([]);
    expectValidEvidence(result.evidence);

    // No secret value in evidence, mutation summaries, or logs.
    const surfaced = JSON.stringify(result) + JSON.stringify(logs);
    expect(surfaced).not.toContain("PRESET_SENTINEL_STATUS");
    expect(surfaced).not.toContain("secret-value");
  });

  it("converges to ready when operator secrets already exist", async () => {
    const { fly, adapter } = createHarness();
    fly.apps = [APP];
    fly.secrets = [...OPERATOR_NAMES];

    const result = await adapter.ensure(context, bundle);

    const mutations = mutationCalls(fly).map((args) => (args[0] === "deploy" ? "deploy" : `${args[0]} ${args[1]}`));
    expect(mutations).toEqual(["volumes create", "secrets set", "deploy"]);
    expect(result.evidence.status).toBe("ready");
    expect(result.supervisorUrl).toBe(`https://${APP}.fly.dev`);
    expect(fly.fetches).toEqual([`https://${APP}.fly.dev/healthz`]);
    expectValidEvidence(result.evidence);
  });

  it("performs no mutations when everything is already ready", async () => {
    const { fly, adapter } = createHarness();
    fly.makeReady();
    const result = await adapter.ensure(context, bundle);
    expect(mutationCalls(fly)).toEqual([]);
    expect(result.evidence.status).toBe("ready");
    expect(result.supervisorUrl).toBe(`https://${APP}.fly.dev`);
  });

  it("tolerates already-exists races on app and volume creation", async () => {
    const { fly, adapter } = createHarness();
    fly.secrets = [...OPERATOR_NAMES];
    fly.failures.set("apps create", { code: 1, stderr: "Error: Name has already been taken" });
    fly.failures.set("volumes create", { code: 1, stderr: "volume openthrottle_data already exists" });

    await expect(adapter.ensure(context, bundle)).resolves.toBeDefined();
    expect(fly.calls.some((args) => args[0] === "secrets" && args[1] === "set")).toBe(true);
  });

  it("applies secrets immediately (unstaged) when no deploy follows", async () => {
    const { fly, adapter } = createHarness();
    fly.makeReady();
    fly.secrets = [...OPERATOR_NAMES];

    const result = await adapter.ensure(context, bundle);

    const secretsCall = fly.calls.find((args) => args[0] === "secrets" && args[1] === "set");
    expect(secretsCall).toBeDefined();
    expect(secretsCall).not.toContain("--stage");
    expect(fly.calls.some((args) => args[0] === "deploy")).toBe(false);
    expect(result.evidence.status).toBe("ready");
  });

  it("never generates operator secrets and reports them after mutations", async () => {
    const { fly, port, adapter } = createHarness();
    fly.makeReady();
    fly.secrets = ALL_SECRET_NAMES.filter((name) => name !== "GITHUB_TOKEN");

    const result = await adapter.ensure(context, bundle);

    expect(port.generated).toEqual([]);
    expect(mutationCalls(fly)).toEqual([]);
    expect(result.supervisorUrl).toBeUndefined();
    expect(result.evidence.owner).toBe("operator");
    expect(result.evidence.recoveryAction).toBe(`flyctl secrets set --app ${APP} GITHUB_TOKEN=...`);
  });

  it("cleans up the generated fly config when the deploy fails", async () => {
    const { fly, adapter } = createHarness();
    fly.makeReady();
    fly.machines = [];
    fly.failures.set("deploy", { code: 1, stderr: "release failed" });

    const error = await adapter.ensure(context, bundle).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FlyctlCommandError);
    const deployCall = fly.calls.find((args) => args[0] === "deploy");
    expect(deployCall).toBeDefined();
    const configPath = deployCall?.[deployCall.indexOf("--config") + 1] ?? "";
    expect(configPath.endsWith("fly.toml")).toBe(true);
    expect(existsSync(dirname(configPath))).toBe(false);
  });

  it("redacts flyctl stderr from secrets set failures", async () => {
    const { fly, port, adapter } = createHarness();
    fly.makeReady();
    fly.secrets = [...OPERATOR_NAMES];
    port.values.set("status_token", "LEAKED_SENTINEL_VALUE");
    fly.failures.set("secrets set", { code: 1, stderr: "failed OT_STATUS_TOKEN=LEAKED_SENTINEL_VALUE" });

    const error = await adapter.ensure(context, bundle).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FlyctlCommandError);
    expect((error as Error).message).toBe("flyctl secrets set exited with code 1");
    expect((error as Error).message).not.toContain("LEAKED_SENTINEL_VALUE");
  });

  it("fails closed when the runtime fragment has no snapshot for DAYTONA_SNAPSHOT", async () => {
    const { fly, adapter } = createHarness();
    fly.makeReady();
    fly.secrets = [...OPERATOR_NAMES];
    const snapshotless: SupervisorDeploymentBundle = {
      ...bundle,
      runtime: { ...bundle.runtime, configuration: {} },
    };
    await expect(adapter.ensure(context, snapshotless)).rejects.toThrow("snapshot");
  });
});

describe("createProfileSecretsPort", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("generates crypto-random values through LocalFileSecretStore so later runs reuse them", async () => {
    const root = mkdtempSync(join(tmpdir(), "openthrottle-fly-port-test-"));
    directories.push(root);
    const store = new LocalFileSecretStore({ root, allowedKeys: ["status_token"], env: {} });
    const port = createProfileSecretsPort(store, "default");

    await expect(Promise.resolve(port.get("status_token"))).resolves.toBeUndefined();
    const generated = await port.generate("status_token");
    expect(generated).toMatch(/^[0-9a-f]{64}$/);

    // A fresh store over the same root observes the persisted value.
    const reopened = createProfileSecretsPort(
      new LocalFileSecretStore({ root, allowedKeys: ["status_token"], env: {} }),
      "default"
    );
    await expect(Promise.resolve(reopened.get("status_token"))).resolves.toBe(generated);
  });
});
