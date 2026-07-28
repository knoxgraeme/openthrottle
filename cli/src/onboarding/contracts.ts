export type ProviderId = string;

export type ReadinessStatus = "ready" | "needs_action" | "error";

export interface ProviderEvidence {
  status: ReadinessStatus;
  owner: "operator" | "hosting_provider" | "runtime_provider" | "supervisor" | "cli";
  summary: string;
  recoveryAction?: string;
  resourceRef?: string;
  releaseId?: string;
  observedAt: string;
}

export interface ProviderPendingEvidence extends ProviderEvidence {
  status: "needs_action" | "error";
}

export interface ReleaseManifest {
  schema: "openthrottle.release-manifest/v1";
  cliVersion: string;
  releaseId: string;
  supervisorImage: string;
  sandboxImage: string;
  runtime: {
    release: string;
    descriptorDigest: string;
  };
  recommendedResources: {
    cpu: number;
    memoryMb: number;
    diskGb: number;
  };
}

export interface SecretRef {
  owner: "cli" | "provisioning";
  name: string;
}

export interface RuntimeDeploymentFragment {
  providerId: ProviderId;
  configuration: Record<string, unknown>;
  secrets: Record<string, SecretRef>;
}

export interface SupervisorDeploymentBundle {
  release: ReleaseManifest;
  runtime: RuntimeDeploymentFragment;
  secrets: Record<string, SecretRef>;
}

export interface ProviderPlan {
  mutations: string[];
  billable: boolean;
  externallyVisible: boolean;
}

export interface AdapterContext {
  profileName: string;
  release: ReleaseManifest;
  now(): Date;
}

export interface RuntimeEnsureResult {
  evidence: ProviderEvidence;
  fragment: RuntimeDeploymentFragment;
}

export interface HostingEnsureResult {
  evidence: ProviderEvidence;
  supervisorUrl?: string;
}

export interface RuntimeSetupAdapter {
  readonly id: ProviderId;
  preflight(context: AdapterContext): Promise<ProviderEvidence>;
  inspect(context: AdapterContext): Promise<RuntimeEnsureResult | ProviderPendingEvidence>;
  plan(context: AdapterContext): Promise<ProviderPlan>;
  ensure(context: AdapterContext): Promise<RuntimeEnsureResult>;
}

export interface HostingSetupAdapter {
  readonly id: ProviderId;
  preflight(context: AdapterContext): Promise<ProviderEvidence>;
  inspect(context: AdapterContext): Promise<HostingEnsureResult | ProviderPendingEvidence>;
  plan(context: AdapterContext, bundle: SupervisorDeploymentBundle): Promise<ProviderPlan>;
  ensure(context: AdapterContext, bundle: SupervisorDeploymentBundle): Promise<HostingEnsureResult>;
}

export interface ProfileSecretStore {
  get(profileName: string, key: string): Promise<string | undefined>;
  set(profileName: string, key: string, value: string): Promise<void>;
}

export function isReadyEvidence(evidence: ProviderEvidence): boolean {
  return evidence.status === "ready";
}

export function assertProviderId(value: string, label = "provider ID"): void {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(value)) {
    throw new Error(`${label} must be a lowercase provider ID`);
  }
}

export function assertDigestPinnedImage(value: string, label: string): void {
  if (!/^[^@\s]+@sha256:[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} must be a digest-pinned image reference`);
  }
}
