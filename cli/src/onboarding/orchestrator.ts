import type {
  AdapterContext,
  HostingEnsureResult,
  ProviderEvidence,
  ProviderPendingEvidence,
  ProviderPlan,
  ReleaseManifest,
  RuntimeDeploymentFragment,
  RuntimeEnsureResult,
  SupervisorDeploymentBundle,
} from "./contracts.js";
import { assertDigestPinnedImage, isReadyEvidence } from "./contracts.js";
import type { ProviderCatalogs } from "./provider-catalog.js";
import { createProfile, type OnboardingProfile, type ProfileStore } from "./profile-store.js";

export type SetupOutcome = "ready" | "needs_action" | "cancelled";

export interface SetupResult {
  outcome: SetupOutcome;
  profile: OnboardingProfile;
  evidence: Record<string, ProviderEvidence>;
  plannedMutations: string[];
  actions: string[];
}

export interface SetupOrchestratorOptions {
  profileName?: string;
  hostingProviderId: string;
  runtimeProviderId: string;
  release: ReleaseManifest;
  catalogs: ProviderCatalogs;
  profileStore: ProfileStore;
  confirmMutations(plan: { hosting: ProviderPlan; runtime: ProviderPlan }): Promise<boolean>;
  now?: () => Date;
}

export class SetupOrchestrator {
  private readonly now: () => Date;

  constructor(private readonly options: SetupOrchestratorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async run(): Promise<SetupResult> {
    validateRelease(this.options.release);
    const profileName = this.options.profileName ?? "default";
    let profile =
      (await this.options.profileStore.load(profileName)) ??
      createProfile({
        name: profileName,
        hostingProvider: this.options.hostingProviderId,
        runtimeProvider: this.options.runtimeProviderId,
        now: this.now(),
      });
    if (profile.providers.hosting !== this.options.hostingProviderId) {
      throw new Error(`profile ${profileName} is bound to hosting provider ${profile.providers.hosting}`);
    }
    if (profile.providers.runtime !== this.options.runtimeProviderId) {
      throw new Error(`profile ${profileName} is bound to runtime provider ${profile.providers.runtime}`);
    }

    const context: AdapterContext = {
      profileName,
      release: this.options.release,
      now: this.now,
    };
    const hosting = this.options.catalogs.hosting.get(this.options.hostingProviderId);
    const runtime = this.options.catalogs.runtime.get(this.options.runtimeProviderId);
    const evidence: Record<string, ProviderEvidence> = {};

    const runtimePreflight = await runtime.preflight(context);
    evidence.runtimePreflight = runtimePreflight;
    if (!isReadyEvidence(runtimePreflight)) return this.finish("needs_action", profile, evidence, []);
    const hostingPreflight = await hosting.preflight(context);
    evidence.hostingPreflight = hostingPreflight;
    if (!isReadyEvidence(hostingPreflight)) return this.finish("needs_action", profile, evidence, []);

    let runtimeInspection = await runtime.inspect(context);
    let runtimeReady = isRuntimeEnsureResult(runtimeInspection) && isReadyEvidence(runtimeInspection.evidence);
    evidence.runtime = isRuntimeEnsureResult(runtimeInspection) ? runtimeInspection.evidence : runtimeInspection;
    if (!runtimeReady && evidence.runtime.status === "error") {
      return this.finish("needs_action", profile, evidence, [recoveryFor(evidence.runtime)]);
    }

    let runtimeEnsuredThisRun = false;
    let plannedMutations: string[] = [];
    if (!runtimeReady) {
      const runtimePlan = await runtime.plan(context);
      plannedMutations = [...plannedMutations, ...runtimePlan.mutations];
      const approved =
        runtimePlan.mutations.length === 0 ||
        (await this.options.confirmMutations({ hosting: emptyPlan(), runtime: runtimePlan }));
      if (!approved) return this.finish("cancelled", profile, evidence, plannedMutations);
      runtimeInspection = await runtime.ensure(context);
      runtimeReady = isReadyEvidence(runtimeInspection.evidence);
      runtimeEnsuredThisRun = runtimeReady;
      evidence.runtime = runtimeInspection.evidence;
      if (!runtimeReady) {
        return this.finish("needs_action", profile, evidence, [recoveryFor(runtimeInspection.evidence)], plannedMutations);
      }
      profile = withEvidence(profile, this.options.release, evidence, this.now());
      await this.options.profileStore.save(profile);
    }

    if (!isRuntimeEnsureResult(runtimeInspection)) {
      throw new Error("runtime inspection did not provide a deployment fragment");
    }
    const deploymentBundle = this.bundle(runtimeInspection.fragment);
    const hostingInspection = await hosting.inspect(context);
    const hostingReady = isHostingEnsureResult(hostingInspection) && isReadyEvidence(hostingInspection.evidence);
    evidence.hosting = isHostingEnsureResult(hostingInspection) ? hostingInspection.evidence : hostingInspection;
    if (!hostingReady && evidence.hosting.status === "error") {
      return this.finish("needs_action", profile, evidence, [recoveryFor(evidence.hosting)], plannedMutations);
    }

    if (!hostingReady || runtimeEnsuredThisRun) {
      const hostingPlan = await hosting.plan(context, deploymentBundle);
      plannedMutations = [...plannedMutations, ...hostingPlan.mutations];
      const approved =
        hostingPlan.mutations.length === 0 ||
        (await this.options.confirmMutations({ hosting: hostingPlan, runtime: emptyPlan() }));
      if (!approved) return this.finish("cancelled", profile, evidence, plannedMutations);
      const ensuredHosting = await hosting.ensure(context, deploymentBundle);
      evidence.hosting = ensuredHosting.evidence;
      if (!isReadyEvidence(ensuredHosting.evidence)) {
        return this.finish("needs_action", profile, evidence, [recoveryFor(ensuredHosting.evidence)], plannedMutations);
      }
      profile = withEvidence(profile, this.options.release, evidence, this.now());
      await this.options.profileStore.save(profile);
      return {
        outcome: "ready",
        profile,
        evidence,
        plannedMutations,
        actions: ["Continue with `openthrottle setup` if a human authorization gate remains."],
      };
    }

    profile = withEvidence(profile, this.options.release, evidence, this.now());
    await this.options.profileStore.save(profile);
    return { outcome: "ready", profile, evidence, plannedMutations: [], actions: [] };
  }

  private bundle(runtime: RuntimeDeploymentFragment): SupervisorDeploymentBundle {
    return {
      release: this.options.release,
      runtime,
      secrets: {
        OT_STATUS_TOKEN: { owner: "cli", name: "status_token" },
        OT_INSTALL_SECRET: { owner: "provisioning", name: "install_secret" },
        LINEAR_WEBHOOK_SECRET: { owner: "provisioning", name: "linear_webhook_secret" },
        GITHUB_WEBHOOK_SECRET: { owner: "provisioning", name: "github_webhook_secret" },
      },
    };
  }

  private async finish(
    outcome: SetupOutcome,
    profile: OnboardingProfile,
    evidence: Record<string, ProviderEvidence>,
    actions: string[],
    plannedMutations: string[] = []
  ): Promise<SetupResult> {
    const updated = withEvidence(profile, this.options.release, evidence, this.now());
    await this.options.profileStore.save(updated);
    return { outcome, profile: updated, evidence, plannedMutations, actions: actions.filter(Boolean) };
  }
}

function validateRelease(release: ReleaseManifest): void {
  if (release.schema !== "openthrottle.release-manifest/v1") throw new Error("unsupported release manifest schema");
  if (!release.releaseId || !release.cliVersion) throw new Error("release manifest identity is incomplete");
  assertDigestPinnedImage(release.supervisorImage, "supervisor image");
  assertDigestPinnedImage(release.sandboxImage, "sandbox image");
  if (!/^sha256:[a-f0-9]{64}$/i.test(release.runtime.descriptorDigest)) {
    throw new Error("runtime descriptor digest is invalid");
  }
  const resources = release.recommendedResources;
  if (resources.cpu <= 0 || resources.memoryMb <= 0 || resources.diskGb <= 0) {
    throw new Error("release manifest resources must be positive");
  }
}

function isRuntimeEnsureResult(value: RuntimeEnsureResult | ProviderPendingEvidence): value is RuntimeEnsureResult {
  return "fragment" in value;
}

function isHostingEnsureResult(value: HostingEnsureResult | ProviderPendingEvidence): value is HostingEnsureResult {
  return "evidence" in value;
}

function emptyPlan(): ProviderPlan {
  return { mutations: [], billable: false, externallyVisible: false };
}

function recoveryFor(evidence: ProviderEvidence): string {
  return evidence.recoveryAction ?? evidence.summary;
}

function withEvidence(
  profile: OnboardingProfile,
  release: ReleaseManifest,
  evidence: Record<string, ProviderEvidence>,
  now: Date
): OnboardingProfile {
  return {
    ...profile,
    release: { releaseId: release.releaseId, cliVersion: release.cliVersion },
    evidence: {
      ...profile.evidence,
      ...evidence,
    },
    updatedAt: now.toISOString(),
  };
}
