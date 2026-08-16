import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type {
  HostingEnsureResult,
  HostingSetupAdapter,
  ProviderEvidence,
  ProviderPendingEvidence,
  ProviderPlan,
  ReleaseManifest,
  RuntimeEnsureResult,
  RuntimeSetupAdapter,
  SupervisorDeploymentBundle,
} from "./onboarding/contracts.js";
import { createProviderCatalogs } from "./onboarding/provider-catalog.js";
import {
  createProfile,
  FileProfileStore,
  withResources,
  type OnboardingProfile,
  type ProfileStore,
} from "./onboarding/profile-store.js";
import type { DefaultCatalogDeps } from "./onboarding/providers/index.js";
import type { ReleaseManifestLoadResult } from "./onboarding/release-manifest.js";
import { LocalFileSecretStore } from "./onboarding/secret-store.js";
import {
  LocalSupervisorAccessStore,
  type SupervisorAccess,
  type SupervisorAccessStore,
} from "./onboarding/supervisor-access-store.js";
import setup, {
  fallbackSecretLines,
  LOCAL_SECRET_KEYS,
  parseSetupArgs,
  renderLegacyChecklist,
  SUPERVISOR_SECRET_CHECKLIST,
  type SetupCommandOptions,
  type SetupPromptApi,
} from "./setup.js";

const release: ReleaseManifest = {
  schema: "openthrottle.release-manifest/v1",
  cliVersion: "2.0.0",
  releaseId: "v2.0.0",
  supervisorImage: `ghcr.io/acme/supervisor@sha256:${"a".repeat(64)}`,
  sandboxImage: `ghcr.io/acme/sandbox@sha256:${"b".repeat(64)}`,
  runtime: { release: "sandbox-v2", descriptorDigest: `sha256:${"c".repeat(64)}` },
  recommendedResources: { cpu: 2, memoryMb: 4096, diskGb: 20 },
};

const pinnedManifest = (): ReleaseManifestLoadResult => ({ status: "pinned", manifest: release, source: "test" });

function evidence(
  status: ProviderEvidence["status"],
  owner: ProviderEvidence["owner"],
  summary: string,
  extra: Partial<ProviderEvidence> = {}
): ProviderEvidence {
  return { status, owner, summary, observedAt: "2026-08-14T00:00:00.000Z", ...extra };
}

class MemoryProfileStore implements ProfileStore {
  profile?: OnboardingProfile;

  async load(): Promise<OnboardingProfile | undefined> {
    return this.profile;
  }

  async save(profile: OnboardingProfile): Promise<void> {
    this.profile = profile;
  }
}

class MemorySecretStore {
  values = new Map<string, string>();

  async get(profileName: string, key: string): Promise<string | undefined> {
    return this.values.get(`${profileName}:${key}`);
  }

  async set(profileName: string, key: string, value: string): Promise<void> {
    this.values.set(`${profileName}:${key}`, value);
  }

  pathFor(profileName: string): string {
    return `/home/test/.openthrottle/secrets/${profileName}.json`;
  }
}

class MemorySupervisorAccessStore implements SupervisorAccessStore {
  values = new Map<string, SupervisorAccess>();

  async load(profileName: string): Promise<SupervisorAccess | undefined> {
    return this.values.get(profileName);
  }

  async save(profileName: string, access: SupervisorAccess): Promise<void> {
    this.values.set(profileName, access);
  }

  pathFor(profileName: string): string {
    return `/home/test/.openthrottle/supervisor-access/${profileName}.json`;
  }
}

class FakeRuntime implements RuntimeSetupAdapter {
  readonly id = "daytona";
  preflightCalls = 0;
  inspectCalls = 0;
  planCalls = 0;
  ensureCalls = 0;
  preflightResult: ProviderEvidence = evidence("ready", "runtime_provider", "runtime authenticated");
  inspectResult: RuntimeEnsureResult | ProviderPendingEvidence = evidence(
    "needs_action",
    "runtime_provider",
    "snapshot missing"
  ) as ProviderPendingEvidence;
  ensureResult: RuntimeEnsureResult = {
    evidence: evidence("ready", "runtime_provider", "snapshot ready", {
      resourceRef: "daytona:snapshot/openthrottle-test-snap",
    }),
    fragment: {
      providerId: "daytona",
      configuration: { snapshot: "openthrottle-test-snap" },
      secrets: { DAYTONA_API_KEY: { owner: "operator", name: "daytona_api_key" } },
    },
  };

  makeReady(): void {
    this.inspectResult = this.ensureResult;
  }

  async preflight(): Promise<ProviderEvidence> {
    this.preflightCalls += 1;
    return this.preflightResult;
  }

  async inspect(): Promise<RuntimeEnsureResult | ProviderPendingEvidence> {
    this.inspectCalls += 1;
    return this.inspectResult;
  }

  async plan(): Promise<ProviderPlan> {
    this.planCalls += 1;
    return { mutations: ["create Daytona snapshot openthrottle-test-snap"], billable: false, externallyVisible: false };
  }

  async ensure(): Promise<RuntimeEnsureResult> {
    this.ensureCalls += 1;
    this.inspectResult = this.ensureResult;
    return this.ensureResult;
  }
}

class FakeHosting implements HostingSetupAdapter {
  readonly id = "fly";
  preflightCalls = 0;
  inspectCalls = 0;
  planCalls = 0;
  ensureCalls = 0;
  preflightResult: ProviderEvidence = evidence("ready", "hosting_provider", "flyctl authenticated");
  inspectResult: HostingEnsureResult | ProviderPendingEvidence = evidence(
    "needs_action",
    "hosting_provider",
    "app missing"
  ) as ProviderPendingEvidence;
  ensureResult: HostingEnsureResult = {
    evidence: evidence("ready", "hosting_provider", "app ready", { resourceRef: "fly:app/openthrottle-supervisor" }),
    supervisorUrl: "https://openthrottle-supervisor.fly.dev",
  };

  makeReady(): void {
    this.inspectResult = this.ensureResult;
  }

  async preflight(): Promise<ProviderEvidence> {
    this.preflightCalls += 1;
    return this.preflightResult;
  }

  async inspect(): Promise<HostingEnsureResult | ProviderPendingEvidence> {
    this.inspectCalls += 1;
    return this.inspectResult;
  }

  async plan(_context: unknown, _bundle: SupervisorDeploymentBundle): Promise<ProviderPlan> {
    this.planCalls += 1;
    return {
      mutations: ["flyctl apps create openthrottle-supervisor --org personal"],
      billable: true,
      externallyVisible: true,
    };
  }

  async ensure(_context: unknown, _bundle: SupervisorDeploymentBundle): Promise<HostingEnsureResult> {
    this.ensureCalls += 1;
    this.inspectResult = this.ensureResult;
    return this.ensureResult;
  }
}

const CANCEL = Symbol("clack cancel");

function recordingPrompts(confirmResult: boolean | symbol = true) {
  const output: string[] = [];
  const confirms: string[] = [];
  const prompts: SetupPromptApi = {
    intro: (message) => output.push(message),
    outro: (message) => output.push(message),
    log: {
      info: (message) => output.push(message),
      warn: (message) => output.push(message),
      error: (message) => output.push(message),
      success: (message) => output.push(message),
    },
    confirm: async ({ message }) => {
      confirms.push(message);
      return confirmResult;
    },
    isCancel: (value): value is symbol => value === CANCEL,
  };
  return { output, confirms, prompts };
}

interface Harness {
  runtime: FakeRuntime;
  hosting: FakeHosting;
  profileStore: ProfileStore;
  secretStore: MemorySecretStore;
  supervisorAccessStore: MemorySupervisorAccessStore;
  catalogDeps: DefaultCatalogDeps[];
  options: SetupCommandOptions;
  output: string[];
  confirms: string[];
}

function harness(overrides: Partial<SetupCommandOptions> = {}, confirmResult: boolean | symbol = true): Harness {
  const runtime = new FakeRuntime();
  const hosting = new FakeHosting();
  const profileStore = new MemoryProfileStore();
  const secretStore = new MemorySecretStore();
  const supervisorAccessStore = new MemorySupervisorAccessStore();
  secretStore.values.set("default:status_token", "operator-token");
  const catalogDeps: DefaultCatalogDeps[] = [];
  const { output, confirms, prompts } = recordingPrompts(confirmResult);
  const options: SetupCommandOptions = {
    loadManifest: pinnedManifest,
    profileStore,
    secretStore,
    supervisorAccessStore,
    env: {},
    prompts,
    now: () => new Date("2026-08-14T00:00:00.000Z"),
    createCatalogs: (deps) => {
      catalogDeps.push(deps);
      return createProviderCatalogs({ hosting: [hosting], runtime: [runtime] });
    },
    ...overrides,
  };
  return {
    runtime,
    hosting,
    profileStore,
    secretStore,
    supervisorAccessStore,
    catalogDeps,
    options,
    output,
    confirms,
  };
}

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openthrottle-setup-test-"));
  directories.push(directory);
  return directory;
}

let logged: string[];
let logSpy: MockInstance;
let errorSpy: MockInstance;

beforeEach(() => {
  logged = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.exitCode = 0;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function allOutput(h: { output: string[] }): string {
  return [...h.output, ...logged].join("\n");
}

describe("setup argument parsing", () => {
  it("parses the documented flags and rejects unknown ones", () => {
    expect(parseSetupArgs([])).toEqual({ profile: "default", check: false, yes: false, legacyChecklist: false });
    expect(parseSetupArgs(["--profile", "staging", "--check", "--yes", "--legacy-checklist"])).toEqual({
      profile: "staging",
      check: true,
      yes: true,
      legacyChecklist: true,
    });
    expect(() => parseSetupArgs(["--profile"])).toThrow(/--profile requires/);
    expect(() => parseSetupArgs(["--bogus"])).toThrow(/Unknown setup option/);
  });

  it("exits 1 on an unknown flag without starting the guided flow", async () => {
    const h = harness();
    await setup(["--bogus"], h.options);
    expect(process.exitCode).toBe(1);
    expect(h.catalogDeps).toHaveLength(0);
    expect(allOutput(h)).toContain("Unknown setup option: --bogus");
  });
});

describe("setup --legacy-checklist", () => {
  it("prints the corrected checklist from the single source-of-truth table and exits 0", async () => {
    const h = harness();
    await setup(["--legacy-checklist"], h.options);

    const text = logged.join("\n");
    // Corrected v1: OT_DEPLOY_TOKEN present; deploy-owned fly.toml [env] values absent.
    expect(text).toContain('fly secrets set OT_DEPLOY_TOKEN="<value>"');
    expect(text).not.toContain("fly secrets set DATABASE_PATH");
    expect(text).not.toContain("fly secrets set PORT");
    for (const name of [
      "SUPERVISOR_URL",
      "OT_STATUS_TOKEN",
      "OT_INSTALL_SECRET",
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_TOKEN",
      "GITHUB_READ_TOKEN",
      "DAYTONA_API_KEY",
      "DAYTONA_SNAPSHOT",
    ]) {
      expect(text).toContain(`fly secrets set ${name}="<value>"`);
    }
    expect(text).toMatch(/SUPERVISOR_URL.*derivable/);
    expect(text).toMatch(/DAYTONA_SNAPSHOT.*derivable/);
    expect(text).toMatch(/GITHUB_TOKEN.*operator-owned/);
    expect(text).toMatch(/OT_STATUS_TOKEN.*generatable/);
    expect(process.exitCode ?? 0).toBe(0);
    // The checklist never enters the guided flow.
    expect(h.catalogDeps).toHaveLength(0);
    expect(renderLegacyChecklist().join("\n")).toBe(text);
  });

  it("keeps the checklist table itself free of deploy-owned env vars", () => {
    const names = SUPERVISOR_SECRET_CHECKLIST.map((entry) => entry.name);
    expect(names).toContain("OT_DEPLOY_TOKEN");
    expect(names).not.toContain("DATABASE_PATH");
    expect(names).not.toContain("PORT");
  });
});

describe("setup release manifest gate", () => {
  it("exits 1 with OT_RELEASE_MANIFEST guidance when the build is unpinned", async () => {
    const h = harness({
      loadManifest: () => ({ status: "unpinned", reason: "no release manifest is bundled with this install" }),
    });
    await setup([], h.options);

    expect(process.exitCode).toBe(1);
    expect(allOutput(h)).toContain("no pinned release");
    expect(allOutput(h)).toContain("OT_RELEASE_MANIFEST");
    expect(h.catalogDeps).toHaveLength(0);
  });

  it("exits 1 when the manifest loader reports an invalid manifest", async () => {
    const h = harness({
      loadManifest: () => {
        throw new Error("release manifest cliVersion 1.0.0 does not match installed CLI version 2.0.0");
      },
    });
    await setup([], h.options);

    expect(process.exitCode).toBe(1);
    expect(allOutput(h)).toContain("does not match installed CLI version");
  });
});

describe("setup --check", () => {
  it("renders the evidence table read-only and exits 0 when everything is ready", async () => {
    const h = harness();
    h.runtime.makeReady();
    h.hosting.makeReady();
    await setup(["--check"], h.options);

    expect(process.exitCode ?? 0).toBe(0);
    expect(h.runtime.preflightCalls).toBe(1);
    expect(h.hosting.preflightCalls).toBe(1);
    expect(h.runtime.inspectCalls).toBe(1);
    expect(h.hosting.inspectCalls).toBe(1);
    // Read-only guarantee: the mutate path is never entered.
    expect(h.runtime.planCalls).toBe(0);
    expect(h.runtime.ensureCalls).toBe(0);
    expect(h.hosting.planCalls).toBe(0);
    expect(h.hosting.ensureCalls).toBe(0);
    const table = logged.join("\n");
    expect(table).toContain("key");
    expect(table).toContain("status");
    expect(table).toContain("owner");
    expect(table).toContain("runtimePreflight");
    expect(table).toContain("daytona:snapshot/openthrottle-test-snap");
    expect(allOutput(h)).toContain("read-only");
  });

  it("exits 1 with recovery actions and the fly secrets fallback when not ready", async () => {
    const h = harness();
    h.runtime.preflightResult = evidence("needs_action", "operator", "DAYTONA_API_KEY is not set", {
      recoveryAction: "Export DAYTONA_API_KEY (create an API key at https://app.daytona.io) and re-run setup.",
    });
    await setup(["--check"], h.options);

    expect(process.exitCode).toBe(1);
    expect(h.runtime.planCalls).toBe(0);
    expect(h.runtime.ensureCalls).toBe(0);
    expect(h.hosting.planCalls).toBe(0);
    expect(h.hosting.ensureCalls).toBe(0);
    const text = allOutput(h);
    expect(text).toContain("Export DAYTONA_API_KEY");
    expect(text).toContain('fly secrets set DAYTONA_API_KEY="<value>"');
  });
});

describe("setup full run", () => {
  it("provisions through the real orchestrator, renders evidence, and persists resource pins", async () => {
    const h = harness();
    await setup([], h.options);

    expect(process.exitCode ?? 0).toBe(0);
    expect(h.runtime.ensureCalls).toBe(1);
    expect(h.hosting.ensureCalls).toBe(1);
    expect(h.confirms.length).toBeGreaterThan(0);

    const text = allOutput(h);
    expect(text).toContain("Supervisor ready at https://openthrottle-supervisor.fly.dev");
    expect(text).toContain("/oauth/install");
    expect(text).toContain("openthrottle init");
    expect(text).toContain(h.secretStore.pathFor("default"));
    expect(text).toContain(h.supervisorAccessStore.pathFor("default"));
    const table = logged.join("\n");
    expect(table).toContain("hosting");
    expect(table).toContain("ready");

    const saved = await h.profileStore.load("default");
    expect(saved?.resources).toMatchObject({
      fly_app: "openthrottle-supervisor",
      fly_org: "personal",
      fly_region: "sjc",
      daytona_snapshot: "openthrottle-test-snap",
    });
    expect(saved).not.toHaveProperty("supervisor");
    expect(h.secretStore.values.has("default:supervisor_url")).toBe(false);
    expect(h.supervisorAccessStore.values.get("default")).toEqual({
      supervisorUrl: "https://openthrottle-supervisor.fly.dev",
      statusToken: "operator-token",
    });
    // Documented defaults reached the adapters through the catalog deps.
    expect(h.catalogDeps[0]?.hosting).toEqual({ app: "openthrottle-supervisor", org: "personal", region: "sjc" });
  });

  it("prefers profile resource pins over env overrides over defaults", async () => {
    const envOnly = harness({ env: { OT_FLY_APP: "custom-app ", OT_FLY_REGION: "ams" } });
    await setup([], envOnly.options);
    expect(envOnly.catalogDeps[0]?.hosting).toEqual({ app: "custom-app", org: "personal", region: "ams" });
    expect(allOutput(envOnly)).toContain("https://custom-app.fly.dev");
    expect((await envOnly.profileStore.load("default"))?.resources.fly_app).toBe("custom-app");

    process.exitCode = 0;
    const pinnedStore = new MemoryProfileStore();
    await pinnedStore.save(
      withResources(createProfile({ hostingProvider: "fly", runtimeProvider: "daytona" }), { fly_app: "pinned-app" })
    );
    const pinned = harness({ env: { OT_FLY_APP: "custom-app" }, profileStore: pinnedStore });
    await setup([], pinned.options);
    expect(pinned.catalogDeps[0]?.hosting).toEqual({ app: "pinned-app", org: "personal", region: "sjc" });
  });

  it("renders needs_action recovery plus the exact manual fly secrets fallback lines", async () => {
    const h = harness();
    h.hosting.ensureResult = {
      evidence: evidence(
        "needs_action",
        "operator",
        "secrets: 8/10 set (missing: DAYTONA_API_KEY, GITHUB_TOKEN)",
        { recoveryAction: "flyctl secrets set --app openthrottle-supervisor DAYTONA_API_KEY=... GITHUB_TOKEN=..." }
      ),
    };
    await setup(["--yes"], h.options);

    expect(process.exitCode).toBe(1);
    const text = allOutput(h);
    expect(text).toContain("flyctl secrets set --app openthrottle-supervisor DAYTONA_API_KEY=... GITHUB_TOKEN=...");
    expect(text).toContain('fly secrets set DAYTONA_API_KEY="<value>"');
    expect(text).toContain('fly secrets set GITHUB_TOKEN="<value>"');
    expect(text).not.toContain('fly secrets set GITHUB_READ_TOKEN="<value>"');
  });

  it("auto-approves mutations with --yes and never prompts", async () => {
    const h = harness({}, CANCEL);
    await setup(["--yes"], h.options);

    expect(process.exitCode ?? 0).toBe(0);
    expect(h.confirms).toHaveLength(0);
    expect(h.runtime.ensureCalls).toBe(1);
    expect(h.hosting.ensureCalls).toBe(1);
    expect(allOutput(h)).toContain("--yes supplied");
  });

  it("treats a declined prompt as cancelled with exit 0 and no mutations", async () => {
    const declined = harness({}, false);
    await setup([], declined.options);
    expect(process.exitCode ?? 0).toBe(0);
    expect(declined.runtime.ensureCalls).toBe(0);
    expect(declined.hosting.ensureCalls).toBe(0);
    expect(allOutput(declined)).toContain("cancelled");

    const cancelled = harness({}, CANCEL);
    await setup([], cancelled.options);
    expect(process.exitCode ?? 0).toBe(0);
    expect(cancelled.runtime.ensureCalls).toBe(0);
    expect(cancelled.hosting.ensureCalls).toBe(0);
    expect(allOutput(cancelled)).toContain("cancelled");
  });

  it("exits 1 when the orchestrator throws", async () => {
    const brokenStore = new MemoryProfileStore();
    brokenStore.load = async () => {
      throw new Error("profile store is corrupt");
    };
    const h = harness({ profileStore: brokenStore });
    await setup([], h.options);

    expect(process.exitCode).toBe(1);
    expect(allOutput(h)).toContain("profile store is corrupt");
  });

  it("keeps generated supervisor secrets out of the onboarding profile", async () => {
    const secretRoot = temporaryDirectory();
    const accessRoot = temporaryDirectory();
    const profileRoot = temporaryDirectory();
    const secretStore = new LocalFileSecretStore({ root: secretRoot, allowedKeys: LOCAL_SECRET_KEYS, env: {} });
    const supervisorAccessStore = new LocalSupervisorAccessStore(accessRoot);
    await secretStore.set("default", "status_token", "SENTINEL_STATUS_TOKEN_VALUE");
    await secretStore.set("default", "install_secret", "SENTINEL_INSTALL_SECRET_VALUE");
    const secretPath = secretStore.pathFor("default");
    const originalSecretDocument = readFileSync(secretPath, "utf8");
    const profileStore = new FileProfileStore(profileRoot);
    const h = harness({ secretStore, supervisorAccessStore, profileStore });
    await setup(["--yes"], h.options);

    expect(process.exitCode ?? 0).toBe(0);
    const text = allOutput(h);
    expect(text).not.toContain("SENTINEL_STATUS_TOKEN_VALUE");
    expect(text).not.toContain("SENTINEL_INSTALL_SECRET_VALUE");
    expect(text).toContain(secretPath);
    const profileJson = readFileSync(join(profileRoot, "default.json"), "utf8");
    expect(profileJson).not.toContain("SENTINEL_STATUS_TOKEN_VALUE");
    expect(profileJson).not.toContain("SENTINEL_INSTALL_SECRET_VALUE");
    expect(profileJson).toContain("daytona_snapshot");
    expect(readFileSync(secretPath, "utf8")).toBe(originalSecretDocument);
    expect(originalSecretDocument).not.toContain("supervisor_url");
    await expect(supervisorAccessStore.load("default")).resolves.toEqual({
      supervisorUrl: "https://openthrottle-supervisor.fly.dev",
      statusToken: "SENTINEL_STATUS_TOKEN_VALUE",
    });
  });

  it("persists resource pins before reporting a missing local status token", async () => {
    const h = harness();
    h.secretStore.values.delete("default:status_token");

    await setup([], h.options);

    expect(process.exitCode).toBe(1);
    expect(allOutput(h)).toContain("without a local supervisor status token");
    expect((await h.profileStore.load("default"))?.resources).toMatchObject({
      fly_app: "openthrottle-supervisor",
      fly_org: "personal",
      fly_region: "sjc",
      daytona_snapshot: "openthrottle-test-snap",
    });
    expect(h.secretStore.values.has("default:supervisor_url")).toBe(false);
    expect(h.supervisorAccessStore.values.has("default")).toBe(false);
  });

  it("prints matching init guidance for a named setup profile", async () => {
    const h = harness();
    h.secretStore.values.set("prod:status_token", "prod-token");

    await setup(["--profile", "prod"], h.options);

    expect(allOutput(h)).toContain("openthrottle init --profile prod");
    expect(h.supervisorAccessStore.values.get("prod")).toMatchObject({
      statusToken: "prod-token",
    });
  });
});

describe("setup fallback line derivation", () => {
  it("maps only operator-owned checklist names found in non-ready evidence", () => {
    const lines = fallbackSecretLines({
      hosting: evidence("needs_action", "operator", "missing: GITHUB_READ_TOKEN", {
        recoveryAction: "flyctl secrets set --app x GITHUB_READ_TOKEN=...",
      }),
      runtime: evidence("ready", "runtime_provider", "mentions DAYTONA_API_KEY but is ready"),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('fly secrets set GITHUB_READ_TOKEN="<value>"');
  });
});
