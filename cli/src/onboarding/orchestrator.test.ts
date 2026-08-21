import { describe, expect, it } from "vitest";
import type {
  AdapterContext,
  HostingSetupAdapter,
  ProviderEvidence,
  ProviderPlan,
  ReleaseManifest,
  ProviderPendingEvidence,
  RuntimeDeploymentFragment,
  RuntimeSetupAdapter,
  SupervisorDeploymentBundle,
} from "./contracts.js";
import { SetupOrchestrator } from "./orchestrator.js";
import { createProviderCatalogs } from "./provider-catalog.js";
import type { OnboardingProfile, ProfileStore } from "./profile-store.js";

const release: ReleaseManifest = {
  schema: "openthrottle.release-manifest/v1",
  cliVersion: "2.0.0",
  releaseId: "v2.0.0",
  supervisorImage: `ghcr.io/acme/supervisor@sha256:${"a".repeat(64)}`,
  sandboxImage: `ghcr.io/acme/sandbox@sha256:${"b".repeat(64)}`,
  runtime: { release: "sandbox-v2", descriptorDigest: `sha256:${"c".repeat(64)}` },
  recommendedResources: { cpu: 2, memoryMb: 4096, diskGb: 20 },
};

function evidence(status: ProviderEvidence["status"], owner: ProviderEvidence["owner"], summary: string): ProviderEvidence {
  return { status, owner, summary, observedAt: "2026-07-28T00:00:00.000Z" };
}

function pendingEvidence(
  status: ProviderPendingEvidence["status"],
  owner: ProviderEvidence["owner"],
  summary: string
): ProviderPendingEvidence {
  return { status, owner, summary, observedAt: "2026-07-28T00:00:00.000Z" };
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

class FakeRuntime implements RuntimeSetupAdapter {
  readonly id: string;
  ensureCalls = 0;
  planCalls = 0;
  preflightEvidence = evidence("ready", "runtime_provider", "runtime logged in");
  inspectResult: ProviderPendingEvidence | { evidence: ProviderEvidence; fragment: RuntimeDeploymentFragment } = pendingEvidence(
    "needs_action",
    "runtime_provider",
    "snapshot missing"
  );

  constructor(id = "fake-runtime") {
    this.id = id;
  }

  async preflight(): Promise<ProviderEvidence> {
    return this.preflightEvidence;
  }

  async inspect(): Promise<ProviderPendingEvidence | { evidence: ProviderEvidence; fragment: RuntimeDeploymentFragment }> {
    return this.inspectResult;
  }

  async plan(): Promise<ProviderPlan> {
    this.planCalls += 1;
    return { mutations: [`create snapshot for ${this.id}`], billable: false, externallyVisible: false };
  }

  async ensure(): Promise<{ evidence: ProviderEvidence; fragment: RuntimeDeploymentFragment }> {
    this.ensureCalls += 1;
    return {
      evidence: evidence("ready", "runtime_provider", "snapshot ready"),
      fragment: {
        providerId: this.id,
        configuration: { snapshot: `${this.id}-snapshot` },
        secrets: { DAYTONA_API_KEY: { owner: "provisioning", name: "daytona_api_key" } },
      },
    };
  }
}

class FakeHosting implements HostingSetupAdapter {
  readonly id: string;
  ensureCalls = 0;
  planCalls = 0;
  bundles: SupervisorDeploymentBundle[] = [];
  inspectResult: ProviderPendingEvidence | { evidence: ProviderEvidence; supervisorUrl?: string } = pendingEvidence(
    "needs_action",
    "hosting_provider",
    "app missing"
  );

  constructor(id = "fake-host") {
    this.id = id;
  }

  async preflight(): Promise<ProviderEvidence> {
    return evidence("ready", "hosting_provider", "hosting logged in");
  }

  async inspect(): Promise<ProviderPendingEvidence | { evidence: ProviderEvidence; supervisorUrl?: string }> {
    return this.inspectResult;
  }

  async plan(_context: AdapterContext, bundle: SupervisorDeploymentBundle): Promise<ProviderPlan> {
    this.planCalls += 1;
    this.bundles.push(bundle);
    return { mutations: [`create app for ${this.id}`], billable: true, externallyVisible: true };
  }

  async ensure(_context: AdapterContext, bundle: SupervisorDeploymentBundle): Promise<{ evidence: ProviderEvidence }> {
    this.ensureCalls += 1;
    this.bundles.push(bundle);
    return { evidence: evidence("ready", "hosting_provider", "app ready") };
  }
}

describe("setup orchestrator", () => {
  it("composes fake hosting and runtime adapters without provider-specific branching", async () => {
    const runtime = new FakeRuntime("fake-runtime-a");
    const hosting = new FakeHosting("fake-host-a");
    const store = new MemoryProfileStore();
    const orchestrator = new SetupOrchestrator({
      hostingProviderId: hosting.id,
      runtimeProviderId: runtime.id,
      release,
      catalogs: createProviderCatalogs({ hosting: [hosting], runtime: [runtime] }),
      profileStore: store,
      confirmMutations: async () => true,
      now: () => new Date("2026-07-28T00:00:00Z"),
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe("ready");
    expect(runtime.ensureCalls).toBe(1);
    expect(hosting.ensureCalls).toBe(1);
    expect(hosting.bundles.at(-1)?.release.supervisorImage).toBe(release.supervisorImage);
    expect(hosting.bundles.at(-1)?.runtime).toMatchObject({
      providerId: "fake-runtime-a",
      configuration: { snapshot: "fake-runtime-a-snapshot" },
    });
    expect(Object.keys(hosting.bundles.at(-1)?.secrets ?? {}).sort()).toEqual([
      "DAYTONA_API_KEY",
      "GITHUB_READ_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_WEBHOOK_SECRET",
      "LINEAR_WEBHOOK_SECRET",
      "OT_DEPLOY_TOKEN",
      "OT_STATUS_TOKEN",
    ]);
    expect(hosting.bundles.at(-1)?.secrets.OT_DEPLOY_TOKEN).toEqual({ owner: "provisioning", name: "deploy_token" });
    expect(hosting.bundles.at(-1)?.secrets.GITHUB_TOKEN).toEqual({ owner: "operator", name: "github_token" });
    expect(hosting.bundles.at(-1)?.secrets.GITHUB_READ_TOKEN).toEqual({ owner: "operator", name: "github_read_token" });
    expect(hosting.bundles.at(-1)?.secrets.DAYTONA_API_KEY).toEqual({ owner: "operator", name: "daytona_api_key" });
    expect(JSON.stringify(store.profile)).not.toContain("daytona_api_key");
    expect(JSON.stringify(store.profile)).not.toContain("deploy_token");
    expect(JSON.stringify(store.profile)).not.toContain("github_token");
    expect(JSON.stringify(store.profile)).not.toContain("github_read_token");
    expect(JSON.stringify(store.profile)).not.toContain("linear_webhook_secret");
    expect(JSON.stringify(store.profile)).not.toContain("github_webhook_secret");
  });

  it("reuses matching live evidence on resume and does not repeat ensure operations", async () => {
    const runtime = new FakeRuntime();
    const hosting = new FakeHosting();
    runtime.inspectResult = await runtime.ensure();
    hosting.inspectResult = { evidence: evidence("ready", "hosting_provider", "app already ready") };
    const orchestrator = new SetupOrchestrator({
      hostingProviderId: hosting.id,
      runtimeProviderId: runtime.id,
      release,
      catalogs: createProviderCatalogs({ hosting: [hosting], runtime: [runtime] }),
      profileStore: new MemoryProfileStore(),
      confirmMutations: async () => true,
      now: () => new Date("2026-07-28T00:00:00Z"),
    });
    runtime.ensureCalls = 0;

    const result = await orchestrator.run();

    expect(result.outcome).toBe("ready");
    expect(runtime.ensureCalls).toBe(0);
    expect(hosting.ensureCalls).toBe(0);
    expect(result.plannedMutations).toEqual([]);
  });

  it("replans hosting with the ensured runtime bundle and checkpoints runtime first", async () => {
    const runtime = new FakeRuntime();
    const hosting = new FakeHosting();
    hosting.inspectResult = { evidence: evidence("ready", "hosting_provider", "app already ready") };
    const store = new MemoryProfileStore();
    const snapshots: OnboardingProfile[] = [];
    store.save = async (profile: OnboardingProfile) => {
      snapshots.push(structuredClone(profile));
      store.profile = profile;
    };

    const result = await new SetupOrchestrator({
      hostingProviderId: hosting.id,
      runtimeProviderId: runtime.id,
      release,
      catalogs: createProviderCatalogs({ hosting: [hosting], runtime: [runtime] }),
      profileStore: store,
      confirmMutations: async () => true,
      now: () => new Date("2026-07-28T00:00:00Z"),
    }).run();

    expect(result.outcome).toBe("ready");
    expect(runtime.ensureCalls).toBe(1);
    expect(hosting.planCalls).toBe(1);
    expect(hosting.ensureCalls).toBe(1);
    expect(hosting.bundles.at(0)?.runtime.configuration).toEqual({ snapshot: "fake-runtime-snapshot" });
    expect(hosting.bundles.at(-1)?.runtime.configuration).toEqual({ snapshot: "fake-runtime-snapshot" });
    expect(snapshots[0]?.evidence.runtime?.summary).toBe("snapshot ready");
    expect(snapshots[0]?.evidence.hosting?.summary).toBeUndefined();
  });

  it("cancels before provider ensure calls when mutation approval is declined", async () => {
    const runtime = new FakeRuntime();
    const hosting = new FakeHosting();
    const result = await new SetupOrchestrator({
      hostingProviderId: hosting.id,
      runtimeProviderId: runtime.id,
      release,
      catalogs: createProviderCatalogs({ hosting: [hosting], runtime: [runtime] }),
      profileStore: new MemoryProfileStore(),
      confirmMutations: async () => false,
      now: () => new Date("2026-07-28T00:00:00Z"),
    }).run();

    expect(result.outcome).toBe("cancelled");
    expect(runtime.ensureCalls).toBe(0);
    expect(hosting.ensureCalls).toBe(0);
  });

  it("fails before adapter mutation on invalid release identity", async () => {
    const runtime = new FakeRuntime();
    const hosting = new FakeHosting();

    await expect(
      new SetupOrchestrator({
        hostingProviderId: hosting.id,
        runtimeProviderId: runtime.id,
        release: { ...release, supervisorImage: "ghcr.io/acme/supervisor:latest" },
        catalogs: createProviderCatalogs({ hosting: [hosting], runtime: [runtime] }),
        profileStore: new MemoryProfileStore(),
        confirmMutations: async () => true,
      }).run()
    ).rejects.toThrow("digest-pinned");
    expect(runtime.ensureCalls).toBe(0);
    expect(hosting.ensureCalls).toBe(0);
  });

  it("accepts a name-addressed runtime snapshot and rejects malformed snapshot names before mutation", async () => {
    const runtime = new FakeRuntime();
    const hosting = new FakeHosting();
    const catalogs = createProviderCatalogs({ hosting: [hosting], runtime: [runtime] });
    const options = {
      hostingProviderId: hosting.id,
      runtimeProviderId: runtime.id,
      catalogs,
      profileStore: new MemoryProfileStore(),
      confirmMutations: async () => true,
      now: () => new Date("2026-07-28T00:00:00Z"),
    };

    const named = await new SetupOrchestrator({
      ...options,
      release: { ...release, runtime: { ...release.runtime, snapshotName: "openthrottle-v13" } },
    }).run();
    expect(named.outcome).toBe("ready");

    runtime.ensureCalls = 0;
    hosting.ensureCalls = 0;
    await expect(
      new SetupOrchestrator({
        ...options,
        release: { ...release, runtime: { ...release.runtime, snapshotName: ".starts-with-dot" } },
      }).run()
    ).rejects.toThrow("snapshot name");
    expect(runtime.ensureCalls).toBe(0);
    expect(hosting.ensureCalls).toBe(0);
  });

  it("demotes stale local checkpoints when live evidence no longer matches", async () => {
    const runtime = new FakeRuntime();
    runtime.inspectResult = pendingEvidence("needs_action", "runtime_provider", "snapshot drifted");
    const hosting = new FakeHosting();
    const store = new MemoryProfileStore();
    store.profile = {
      schema: "openthrottle.profile/v1",
      name: "default",
      providers: { hosting: hosting.id, runtime: runtime.id },
      release: { releaseId: release.releaseId, cliVersion: release.cliVersion },
      resources: {},
      evidence: { runtime: evidence("ready", "runtime_provider", "old snapshot") },
      updatedAt: "2026-07-28T00:00:00.000Z",
    };

    const result = await new SetupOrchestrator({
      hostingProviderId: hosting.id,
      runtimeProviderId: runtime.id,
      release,
      catalogs: createProviderCatalogs({ hosting: [hosting], runtime: [runtime] }),
      profileStore: store,
      confirmMutations: async () => true,
      now: () => new Date("2026-07-28T00:00:01Z"),
    }).run();

    expect(result.outcome).toBe("ready");
    expect(result.evidence.runtime?.summary).toBe("snapshot ready");
    expect(store.profile?.evidence.runtime?.summary).toBe("snapshot ready");
  });
});
