// Fly hosting adapter: implements the provider-neutral HostingSetupAdapter
// contract over flyctl. Everything Fly-flavored (command strings, fly.toml
// shape, app/volume defaults) stays inside this providers/fly subtree.
//
// Secret values never appear in evidence, plan mutation strings, log lines,
// or thrown errors — only secret NAMES do. flyctl itself never returns secret
// values (secrets list is names + digests only).

import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareCodeUnits } from "@openthrottle/contracts";
import type {
  AdapterContext,
  HostingEnsureResult,
  HostingSetupAdapter,
  ProfileSecretStore,
  ProviderEvidence,
  ProviderPendingEvidence,
  ProviderPlan,
  SecretRef,
  SupervisorDeploymentBundle,
} from "../../contracts.js";
import {
  createFlyctlRunner,
  FlyctlClient,
  FlyctlCommandError,
  FlyctlNotFoundError,
  FlyctlParseError,
  type FlyctlRunner,
} from "./flyctl.js";

export const DEFAULT_FLY_APP = "openthrottle-supervisor";
export const DEFAULT_FLY_ORG = "personal";
export const DEFAULT_FLY_REGION = "sjc";
export const FLY_VOLUME_NAME = "openthrottle_data";
export const FLY_INSTALL_RECOVERY = "Install flyctl: curl -L https://fly.io/install.sh | sh (see https://fly.io/docs/flyctl/install/)";

const HEALTHZ_TIMEOUT_MS = 10_000;

/**
 * Secret resolution port. Shaped to compose over the onboarding
 * ProfileSecretStore (LocalFileSecretStore): `get` looks a value up by its
 * SecretRef name (for example "status_token"), and `generate` must both mint a
 * crypto-random value AND persist it so a later run's `get` returns the same
 * value — otherwise resumed setups would rotate supervisor secrets on every
 * run. `createProfileSecretsPort` provides that composition.
 */
export interface FlySecretsPort {
  get(name: string): string | undefined | Promise<string | undefined>;
  generate(name: string): string | Promise<string>;
}

/** Binds a profile-scoped secret store into the adapter's secret port. */
export function createProfileSecretsPort(store: ProfileSecretStore, profileName: string): FlySecretsPort {
  return {
    get: (name) => store.get(profileName, name),
    generate: async (name) => {
      const value = randomBytes(32).toString("hex");
      await store.set(profileName, name, value);
      return value;
    },
  };
}

export interface FlyHostingAdapterOptions {
  runner?: FlyctlRunner;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  secrets: FlySecretsPort;
  app?: string;
  org?: string;
  region?: string;
  log?: (message: string) => void;
}

type SecretOwner = SecretRef["owner"] | "derived";

interface RequiredSecret {
  key: string;
  owner: SecretOwner;
  /** Store-facing name for cli/provisioning refs; absent for derived values. */
  refName?: string;
}

// Mirror of the orchestrator's SupervisorDeploymentBundle secrets map plus the
// two values this adapter derives itself (supervisor/src/app/config.ts is the
// env authority). inspect() has no bundle parameter, so it checks this static
// set; plan()/ensure() recompute the same list from the live bundle.
const REQUIRED_SUPERVISOR_SECRETS: readonly RequiredSecret[] = sortedByKey([
  { key: "OT_STATUS_TOKEN", owner: "cli", refName: "status_token" },
  { key: "OT_DEPLOY_TOKEN", owner: "provisioning", refName: "deploy_token" },
  { key: "LINEAR_WEBHOOK_SECRET", owner: "provisioning", refName: "linear_webhook_secret" },
  { key: "GITHUB_WEBHOOK_SECRET", owner: "provisioning", refName: "github_webhook_secret" },
  { key: "GITHUB_TOKEN", owner: "operator", refName: "github_token" },
  { key: "GITHUB_READ_TOKEN", owner: "operator", refName: "github_read_token" },
  { key: "DAYTONA_API_KEY", owner: "operator", refName: "daytona_api_key" },
  { key: "SUPERVISOR_URL", owner: "derived" },
  { key: "DAYTONA_SNAPSHOT", owner: "derived" },
]);

function sortedByKey(required: RequiredSecret[]): RequiredSecret[] {
  return required.sort((left, right) => compareCodeUnits(left.key, right.key));
}

function requiredSecretsFromBundle(bundle: SupervisorDeploymentBundle): RequiredSecret[] {
  const required: RequiredSecret[] = Object.entries(bundle.secrets).map(([key, ref]) => ({
    key,
    owner: ref.owner,
    refName: ref.name,
  }));
  required.push({ key: "SUPERVISOR_URL", owner: "derived" }, { key: "DAYTONA_SNAPSHOT", owner: "derived" });
  return sortedByKey(required);
}

interface FlyInspection {
  appExists: boolean;
  volumeExists: boolean;
  presentSecretCount: number;
  missingSecrets: RequiredSecret[];
  startedMachineCount: number;
  releaseImageActive: boolean;
  /** undefined when earlier tiers failed and the probe was skipped. */
  healthy?: boolean;
}

function imageDigest(image: string): string {
  const at = image.indexOf("@");
  return at >= 0 ? image.slice(at + 1) : image;
}

export function createFlyHostingAdapter(options: FlyHostingAdapterOptions): HostingSetupAdapter {
  const app = options.app ?? DEFAULT_FLY_APP;
  const org = options.org ?? DEFAULT_FLY_ORG;
  const region = options.region ?? DEFAULT_FLY_REGION;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(app)) {
    throw new Error("Fly app name must be 1-63 lowercase letters, numbers, and dashes");
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(org)) {
    throw new Error("Fly org slug contains unsupported characters");
  }
  if (!/^[a-z]{3}$/.test(region)) {
    throw new Error("Fly region must be a three-letter region code");
  }
  // Environment (including FLY_API_TOKEN) passes through to the default
  // runner; an injected runner owns its own environment.
  const runner = options.runner ?? createFlyctlRunner({ env: options.env });
  const client = new FlyctlClient(runner);
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {});
  const supervisorUrl = `https://${app}.fly.dev`;

  const appsCreateCommand = `flyctl apps create ${app} --org ${org}`;
  const volumesCreateCommand = `flyctl volumes create ${FLY_VOLUME_NAME} --app ${app} --region ${region} --size 1`;
  const deployCommand = (image: string) => `flyctl deploy --app ${app} --image ${image}`;

  function operatorRecovery(missing: RequiredSecret[]): string {
    const names = missing
      .filter((secret) => secret.owner === "operator")
      .map((secret) => `${secret.key}=...`)
      .join(" ");
    return `flyctl secrets set --app ${app} ${names}`;
  }

  async function checkHealthz(): Promise<boolean> {
    try {
      const response = await fetchImpl(`${supervisorUrl}/healthz`, {
        signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function inspectState(context: AdapterContext, required: readonly RequiredSecret[]): Promise<FlyInspection> {
    const apps = await client.appsList();
    if (!apps.some((entry) => entry.name === app)) {
      return {
        appExists: false,
        volumeExists: false,
        presentSecretCount: 0,
        missingSecrets: [...required],
        startedMachineCount: 0,
        releaseImageActive: false,
      };
    }
    const volumes = await client.volumesList(app);
    const volumeExists = volumes.some((volume) => volume.name === FLY_VOLUME_NAME);
    const secretNames = new Set((await client.secretsList(app)).map((secret) => secret.name));
    const missingSecrets = required.filter((secret) => !secretNames.has(secret.key));
    const machines = await client.machinesList(app);
    const digest = imageDigest(context.release.supervisorImage);
    const started = machines.filter((machine) => machine.state === "started");
    const releaseImageActive = started.some((machine) => (machine.image ?? "").includes(digest));
    const inspection: FlyInspection = {
      appExists: true,
      volumeExists,
      presentSecretCount: required.length - missingSecrets.length,
      missingSecrets,
      startedMachineCount: started.length,
      releaseImageActive,
    };
    if (volumeExists && missingSecrets.length === 0 && releaseImageActive) {
      inspection.healthy = await checkHealthz();
    }
    return inspection;
  }

  function evidenceFor(
    context: AdapterContext,
    required: readonly RequiredSecret[],
    inspection: FlyInspection
  ): { evidence: ProviderEvidence; ready: boolean } {
    const observedAt = context.now().toISOString();
    const parts: string[] = [`app ${app}: ${inspection.appExists ? "ok" : "missing"}`];
    let failure: Pick<ProviderEvidence, "owner" | "recoveryAction"> | undefined;
    if (!inspection.appExists) {
      failure = { owner: "hosting_provider", recoveryAction: appsCreateCommand };
    } else {
      parts.push(`volume ${FLY_VOLUME_NAME}: ${inspection.volumeExists ? "ok" : "missing"}`);
      const missing = inspection.missingSecrets;
      parts.push(
        missing.length === 0
          ? `secrets: ${inspection.presentSecretCount}/${required.length} set`
          : `secrets: ${inspection.presentSecretCount}/${required.length} set (missing: ${missing.map((secret) => secret.key).join(", ")})`
      );
      parts.push(
        inspection.releaseImageActive
          ? "release image: active"
          : inspection.startedMachineCount > 0
            ? "release image: deployed image is not this release"
            : "release image: no started machine"
      );
      parts.push(
        inspection.healthy === undefined ? "healthz: unchecked" : inspection.healthy ? "healthz: ok" : "healthz: failing"
      );
      if (!inspection.volumeExists) {
        failure = { owner: "hosting_provider", recoveryAction: volumesCreateCommand };
      } else if (missing.length > 0) {
        failure = missing.some((secret) => secret.owner === "operator")
          ? { owner: "operator", recoveryAction: operatorRecovery(missing) }
          : { owner: "cli", recoveryAction: "openthrottle setup" };
      } else if (!inspection.releaseImageActive) {
        failure = { owner: "hosting_provider", recoveryAction: deployCommand(context.release.supervisorImage) };
      } else if (!inspection.healthy) {
        failure = { owner: "supervisor", recoveryAction: `flyctl logs --app ${app}` };
      }
    }
    const summary = parts.join("; ").slice(0, 500);
    if (failure) {
      return {
        ready: false,
        evidence: {
          status: "needs_action",
          owner: failure.owner,
          summary,
          recoveryAction: failure.recoveryAction,
          resourceRef: `fly:app/${app}`,
          observedAt,
        },
      };
    }
    return {
      ready: true,
      evidence: {
        status: "ready",
        owner: "hosting_provider",
        summary,
        resourceRef: `fly:app/${app}`,
        releaseId: context.release.releaseId,
        observedAt,
      },
    };
  }

  function flyctlFailureEvidence(context: AdapterContext, error: unknown): ProviderPendingEvidence {
    const observedAt = context.now().toISOString();
    if (error instanceof FlyctlNotFoundError) {
      return {
        status: "needs_action",
        owner: "operator",
        summary: "flyctl was not found on PATH",
        recoveryAction: FLY_INSTALL_RECOVERY,
        observedAt,
      };
    }
    if (error instanceof FlyctlCommandError || error instanceof FlyctlParseError) {
      return {
        status: "error",
        owner: "hosting_provider",
        summary: error.message.slice(0, 500),
        recoveryAction: "re-run openthrottle setup once flyctl works against this account",
        observedAt,
      };
    }
    throw error;
  }

  async function resolveSecretValue(bundle: SupervisorDeploymentBundle, secret: RequiredSecret): Promise<string> {
    if (secret.owner === "derived") {
      if (secret.key === "SUPERVISOR_URL") return supervisorUrl;
      const snapshot = bundle.runtime.configuration.snapshot;
      if (typeof snapshot !== "string" || snapshot.trim() === "") {
        throw new Error("runtime deployment fragment does not declare a snapshot for DAYTONA_SNAPSHOT");
      }
      return snapshot;
    }
    const name = secret.refName ?? secret.key.toLowerCase();
    const existing = await options.secrets.get(name);
    if (existing !== undefined && existing !== "") return existing;
    const generated = await options.secrets.generate(name);
    if (typeof generated !== "string" || generated === "") {
      throw new Error(`secret port generated an empty value for ${secret.key}`);
    }
    return generated;
  }

  async function runMutation(args: string[], label: string, tolerateExisting: boolean): Promise<void> {
    const result = await runner.run(args);
    if (result.code === 0) return;
    if (tolerateExisting && /taken|already exists|already been/i.test(result.stderr)) {
      log(`fly: ${label} already exists`);
      return;
    }
    // secrets set argv carries values; never echo its stderr into the error.
    const detail = label === "secrets set" ? undefined : result.stderr.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new FlyctlCommandError(label, result.code, detail);
  }

  return {
    id: "fly",

    async preflight(context: AdapterContext): Promise<ProviderEvidence> {
      const observedAt = context.now().toISOString();
      let version: string;
      try {
        version = await client.version();
      } catch (error) {
        return flyctlFailureEvidence(context, error);
      }
      try {
        const account = await client.whoami();
        return {
          status: "ready",
          owner: "hosting_provider",
          summary: `flyctl ${version} authenticated as ${account}`,
          observedAt,
        };
      } catch (error) {
        if (error instanceof FlyctlCommandError) {
          return {
            status: "needs_action",
            owner: "operator",
            summary: `flyctl ${version} is installed but not authenticated`,
            recoveryAction: "flyctl auth login (or export FLY_API_TOKEN)",
            observedAt,
          };
        }
        return flyctlFailureEvidence(context, error);
      }
    },

    async inspect(context: AdapterContext): Promise<HostingEnsureResult | ProviderPendingEvidence> {
      let inspection: FlyInspection;
      try {
        inspection = await inspectState(context, REQUIRED_SUPERVISOR_SECRETS);
      } catch (error) {
        return flyctlFailureEvidence(context, error);
      }
      const { evidence, ready } = evidenceFor(context, REQUIRED_SUPERVISOR_SECRETS, inspection);
      if (ready) return { evidence, supervisorUrl };
      return evidence as ProviderPendingEvidence;
    },

    async plan(context: AdapterContext, bundle: SupervisorDeploymentBundle): Promise<ProviderPlan> {
      const required = requiredSecretsFromBundle(bundle);
      const inspection = await inspectState(context, required);
      const mutations: string[] = [];
      if (!inspection.appExists) mutations.push(appsCreateCommand);
      if (!inspection.volumeExists) mutations.push(volumesCreateCommand);
      const settable = inspection.missingSecrets.filter((secret) => secret.owner !== "operator");
      if (settable.length > 0) {
        mutations.push(
          `set ${settable.length} supervisor secrets (names: ${settable.map((secret) => secret.key).join(", ")})`
        );
      }
      const deployPlanned = !inspection.releaseImageActive;
      if (deployPlanned) mutations.push(deployCommand(bundle.release.supervisorImage));
      return {
        mutations,
        billable: !inspection.volumeExists || deployPlanned,
        externallyVisible: !inspection.appExists || deployPlanned,
      };
    },

    async ensure(context: AdapterContext, bundle: SupervisorDeploymentBundle): Promise<HostingEnsureResult> {
      const required = requiredSecretsFromBundle(bundle);

      // Execute only what is currently missing, re-reading live state so a
      // stale plan can never repeat a mutation.
      const apps = await client.appsList();
      if (!apps.some((entry) => entry.name === app)) {
        log(`fly: creating app ${app} in org ${org}`);
        await runMutation(["apps", "create", app, "--org", org], "apps create", true);
      }
      const volumes = await client.volumesList(app);
      if (!volumes.some((volume) => volume.name === FLY_VOLUME_NAME)) {
        log(`fly: creating volume ${FLY_VOLUME_NAME} in ${region}`);
        await runMutation(
          ["volumes", "create", FLY_VOLUME_NAME, "--app", app, "--region", region, "--size", "1", "--yes"],
          "volumes create",
          true
        );
      }

      const secretNames = new Set((await client.secretsList(app)).map((secret) => secret.name));
      const missing = required.filter((secret) => !secretNames.has(secret.key));
      const machines = await client.machinesList(app);
      const digest = imageDigest(bundle.release.supervisorImage);
      const deployNeeded = !machines.some(
        (machine) => machine.state === "started" && (machine.image ?? "").includes(digest)
      );

      // Operator-owned secrets are never generated; the post-mutation
      // inspection reports them with the exact recovery command instead.
      const settable = missing.filter((secret) => secret.owner !== "operator");
      if (settable.length > 0) {
        const pairs: string[] = [];
        for (const secret of settable) {
          pairs.push(`${secret.key}=${await resolveSecretValue(bundle, secret)}`);
        }
        // Values ride the argv: they are short tokens (32-byte generated hex /
        // operator API keys), orders of magnitude under ARG_MAX, so `secrets
        // import` over stdin is not needed. --stage defers the release when a
        // deploy immediately follows (mirrors deploy.yml); without a pending
        // deploy the set applies immediately.
        log(`fly: setting ${settable.length} supervisor secrets (names: ${settable.map((secret) => secret.key).join(", ")})`);
        await runMutation(
          ["secrets", "set", "--app", app, ...(deployNeeded ? ["--stage"] : []), ...pairs],
          "secrets set",
          false
        );
      }

      if (deployNeeded) {
        // The npm-published CLI does not ship supervisor/fly.toml, so render an
        // equivalent minimal config (port 8080, /data volume mount, healthz
        // check) into a private temp dir for this one deploy.
        const directory = await mkdtemp(join(tmpdir(), "openthrottle-fly-"));
        try {
          const configPath = join(directory, "fly.toml");
          await writeFile(configPath, renderFlyConfig(app, region), { mode: 0o600 });
          log(`fly: deploying ${bundle.release.supervisorImage}`);
          await runMutation(
            ["deploy", "--app", app, "--config", configPath, "--image", bundle.release.supervisorImage],
            "deploy",
            false
          );
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }

      const inspection = await inspectState(context, required);
      const { evidence, ready } = evidenceFor(context, required, inspection);
      return ready ? { evidence, supervisorUrl } : { evidence };
    },
  };
}

// Equivalent of supervisor/fly.toml for image-based deploys (no [build]
// section — the release manifest pins the image by digest).
function renderFlyConfig(app: string, region: string): string {
  return `# Generated by the openthrottle CLI Fly hosting adapter. Not persisted.
app = "${app}"
primary_region = "${region}"

[env]
  PORT = "8080"
  DATABASE_PATH = "/data/openthrottle.db"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

  [[http_service.checks]]
    grace_period = "10s"
    interval = "30s"
    method = "GET"
    timeout = "5s"
    path = "/healthz"

[mounts]
  source = "${FLY_VOLUME_NAME}"
  destination = "/data"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 512
`;
}
