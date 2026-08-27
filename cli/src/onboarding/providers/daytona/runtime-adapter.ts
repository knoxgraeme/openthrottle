// Daytona runtime onboarding adapter.
//
// Wraps the pinned @daytona/sdk behind the provider-neutral RuntimeSetupAdapter
// contract. The SDK is loaded lazily via dynamic import (mirroring
// cli/src/setup.ts) so credential-free flows such as `--check` still render
// evidence on machines that cannot authenticate; no SDK types enter the
// module-level import graph.

import type {
  AdapterContext,
  ProviderEvidence,
  ProviderPendingEvidence,
  ProviderPlan,
  ReleaseManifest,
  RuntimeDeploymentFragment,
  RuntimeEnsureResult,
  RuntimeSetupAdapter,
} from "../../contracts.js";
import { assertSnapshotName } from "../../contracts.js";
import { getErrorMessage } from "../../../util.js";

export const DAYTONA_PROVIDER_ID = "daytona";

// Daytona enforces a *total* disk quota per organization (30 GiB on the
// standard tier), not a per-sandbox cap, and OpenThrottle retains a stopped
// sandbox per non-closed ticket — so existing sandbox disk plus each new
// sandbox's disk is the number that matters (see
// supervisor/scripts/snapshot-resources.mjs for the incident history).
export const DAYTONA_ORG_DISK_CAP_GIB = 30;

// Keep the best-effort sandbox inventory scan bounded on large organizations.
const SANDBOX_SCAN_LIMIT = 200;

// profile-store's validateEvidence rejects summaries longer than 500 chars.
const MAX_SUMMARY_LENGTH = 500;
const MAX_ERROR_DETAIL_LENGTH = 200;

const DISK_CLEANUP_RECOVERY =
  "Delete stopped or retained Daytona sandboxes (or lower the per-sandbox disk) so existing plus " +
  `new sandbox disk fits the ${DAYTONA_ORG_DISK_CAP_GIB} GiB org disk cap.`;

// Minimal structural view of @daytona/sdk covering exactly the calls this
// adapter makes. Shapes verified against supervisor/scripts/build-snapshot.mjs
// and the pinned SDK's declarations (Snapshot.d.ts: snapshot.get/list/create
// with `image: string | Image` and `{ onLogs }`; Image.base(ref) producing a
// zero-context `FROM <ref>\n` wrapper; Daytona.d.ts: `Resources` cpu in cores
// with memory/disk in GiB, and `list()` async-iterating Sandbox objects that
// carry `disk` in GiB).
export interface DaytonaSnapshotLike {
  name?: string;
  state?: string;
  organizationId?: string;
}

export interface DaytonaSandboxLike {
  state?: string;
  disk?: number;
}

export interface DaytonaImageLike {
  readonly dockerfile: string;
}

export interface DaytonaSnapshotCreateParams {
  name: string;
  image: DaytonaImageLike;
  resources: { cpu: number; memory: number; disk: number };
}

export interface DaytonaClientLike {
  snapshot: {
    get(name: string): Promise<DaytonaSnapshotLike>;
    list(page?: number, limit?: number): Promise<{ items?: DaytonaSnapshotLike[] }>;
    create(
      params: DaytonaSnapshotCreateParams,
      options?: { onLogs?: (chunk: string) => void }
    ): Promise<DaytonaSnapshotLike>;
  };
  list?(): AsyncIterable<DaytonaSandboxLike>;
}

export interface DaytonaSdkLike {
  Daytona: new (config: { apiKey: string }) => DaytonaClientLike;
  Image: {
    base(image: string): DaytonaImageLike;
  };
}

export interface DaytonaRuntimeAdapterOptions {
  env?: Record<string, string | undefined>;
  sdk?: () => Promise<DaytonaSdkLike>;
  log?: (line: string) => void;
}

async function loadRealSdk(): Promise<DaytonaSdkLike> {
  // The cast is deliberate: DaytonaClientLike is a verified structural subset
  // of the pinned SDK surface, and casting keeps the SDK's own types out of
  // this module's compile-time graph.
  return (await import("@daytona/sdk")) as unknown as DaytonaSdkLike;
}

export function resolveDaytonaSnapshotName(release: ReleaseManifest): string {
  const name = release.runtime.snapshotName ?? `openthrottle-${release.releaseId}`;
  assertSnapshotName(name, "runtime snapshot name");
  return name;
}

// Sandbox-sizing semantics: the release manifest recommends memory in MiB, but
// the Daytona `Resources` contract sizes memory (and disk) in GiB. Round the
// MiB value UP to whole GiB so a sandbox is never provisioned smaller than the
// recommendation — undersized sandboxes OOM-kill real monorepo builds (the
// memory cgroup SIGKILLs, surfacing as exit 137 before diagnostics print).
export function memoryMbToGib(memoryMb: number): number {
  return Math.max(1, Math.ceil(memoryMb / 1024));
}

function describeResources(release: ReleaseManifest): string {
  const { cpu, memoryMb, diskGb } = release.recommendedResources;
  return `cpu ${cpu} / mem ${memoryMbToGib(memoryMb)} GiB / disk ${diskGb} GiB`;
}

function fragmentFor(name: string, release: ReleaseManifest): RuntimeDeploymentFragment {
  return {
    providerId: DAYTONA_PROVIDER_ID,
    configuration: {
      snapshot: name,
      cpu: release.recommendedResources.cpu,
      memoryGib: memoryMbToGib(release.recommendedResources.memoryMb),
      diskGib: release.recommendedResources.diskGb,
    },
    secrets: { DAYTONA_API_KEY: { owner: "operator", name: "daytona_api_key" } },
  };
}

function boundSummary(text: string): string {
  return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : text;
}

// Bounded, secret-free rendering of an SDK failure. The API key value must
// never reach evidence, so any occurrence is redacted defensively even though
// SDK errors are not expected to echo credentials.
function describeError(error: unknown, secret?: string): string {
  let detail = getErrorMessage(error) || "unknown error";
  if (secret) detail = detail.split(secret).join("[redacted]");
  return detail.length > MAX_ERROR_DETAIL_LENGTH ? `${detail.slice(0, MAX_ERROR_DETAIL_LENGTH - 1)}…` : detail;
}

function missingKeyEvidence(observedAt: string): ProviderPendingEvidence {
  return {
    status: "needs_action",
    owner: "operator",
    summary: "DAYTONA_API_KEY is not set; the Daytona runtime provider cannot be verified.",
    recoveryAction: "Export DAYTONA_API_KEY (create an API key at https://app.daytona.io) and re-run setup.",
    observedAt,
  };
}

function sdkLoadErrorEvidence(error: unknown, observedAt: string): ProviderPendingEvidence {
  return {
    status: "error",
    owner: "operator",
    summary: boundSummary(`Daytona SDK could not be loaded: ${describeError(error)}`),
    recoveryAction: "Reinstall the openthrottle CLI so its bundled @daytona/sdk dependency is present.",
    observedAt,
  };
}

function diskCapExceededEvidence(release: ReleaseManifest, observedAt: string): ProviderPendingEvidence {
  return {
    status: "error",
    owner: "operator",
    summary: boundSummary(
      `recommended sandbox disk ${release.recommendedResources.diskGb} GiB exceeds the ` +
        `${DAYTONA_ORG_DISK_CAP_GIB} GiB Daytona org disk cap; no sandbox of that size can ever be created`
    ),
    recoveryAction:
      `Lower recommendedResources.diskGb below ${DAYTONA_ORG_DISK_CAP_GIB} or move the Daytona ` +
      "organization to a plan with a larger disk quota.",
    releaseId: release.releaseId,
    observedAt,
  };
}

function lookupErrorEvidence(detail: string, release: ReleaseManifest, observedAt: string): ProviderPendingEvidence {
  return {
    status: "error",
    owner: "operator",
    summary: boundSummary(`Daytona snapshot lookup failed: ${detail}`),
    recoveryAction:
      "Check that DAYTONA_API_KEY is a valid API key for your Daytona organization (https://app.daytona.io) and re-run setup.",
    releaseId: release.releaseId,
    observedAt,
  };
}

// Mirrors supervisor/scripts/build-snapshot.mjs: a same-name snapshot in any
// non-active state must be deleted in Daytona before it can be rebuilt.
function unbuildableEvidence(
  name: string,
  state: string,
  release: ReleaseManifest,
  observedAt: string
): ProviderPendingEvidence {
  return {
    status: "error",
    owner: "operator",
    summary: boundSummary(`Daytona snapshot ${name} already exists in state ${state}`),
    recoveryAction: `Delete snapshot ${name} in Daytona before rebuilding.`,
    resourceRef: `daytona:snapshot/${name}`,
    releaseId: release.releaseId,
    observedAt,
  };
}

type SnapshotProbe =
  | { kind: "active" }
  | { kind: "unbuildable"; state: string }
  | { kind: "missing" }
  | { kind: "unreachable"; detail: string };

async function probeSnapshot(daytona: DaytonaClientLike, name: string, key: string): Promise<SnapshotProbe> {
  let snapshot: DaytonaSnapshotLike;
  try {
    snapshot = await daytona.snapshot.get(name);
  } catch (error) {
    const detail = describeError(error, key);
    // snapshot.get throws on absence (see cli/src/setup.ts and
    // supervisor/scripts/build-snapshot.mjs); "not found" wording matches the
    // convention the supervisor's Daytona adapter already relies on.
    if (/not found|does not exist|\b404\b/i.test(detail)) return { kind: "missing" };
    return { kind: "unreachable", detail };
  }
  const state = String(snapshot?.state ?? "unknown").toLowerCase();
  return state === "active" ? { kind: "active" } : { kind: "unbuildable", state };
}

interface DiskAssessment {
  note: string;
  overCap: boolean;
}

// Best-effort sum of existing sandbox disk. The SDK's top-level list() is the
// only cheap inventory call; when it is unavailable or fails the caller falls
// back to a static per-sandbox note. Warning-grade only: never blocks ensure.
async function sumSandboxDiskGib(daytona: DaytonaClientLike): Promise<number | undefined> {
  if (typeof daytona.list !== "function") return undefined;
  try {
    let total = 0;
    let seen = 0;
    for await (const sandbox of daytona.list()) {
      if (String(sandbox?.state ?? "").toLowerCase() === "destroyed") continue;
      if (typeof sandbox?.disk === "number" && Number.isFinite(sandbox.disk)) total += sandbox.disk;
      if (++seen >= SANDBOX_SCAN_LIMIT) break;
    }
    return total;
  } catch {
    return undefined;
  }
}

async function assessOrgDisk(daytona: DaytonaClientLike, diskGb: number): Promise<DiskAssessment> {
  const existing = await sumSandboxDiskGib(daytona);
  if (existing === undefined) {
    return {
      note: `each sandbox uses ${diskGb} GiB disk against the ${DAYTONA_ORG_DISK_CAP_GIB} GiB Daytona org disk cap`,
      overCap: false,
    };
  }
  return {
    note:
      `existing sandboxes use ${existing} GiB of the ${DAYTONA_ORG_DISK_CAP_GIB} GiB Daytona org ` +
      `disk cap and each new sandbox adds ${diskGb} GiB`,
    overCap: existing + diskGb > DAYTONA_ORG_DISK_CAP_GIB,
  };
}

export function createDaytonaRuntimeAdapter(options: DaytonaRuntimeAdapterOptions = {}): RuntimeSetupAdapter {
  const loadSdk = options.sdk ?? loadRealSdk;
  const log = options.log;
  let sdkPromise: Promise<DaytonaSdkLike> | undefined;

  function apiKey(): string | undefined {
    const env = options.env ?? process.env;
    const value = env.DAYTONA_API_KEY;
    return value && value.trim() !== "" ? value.trim() : undefined;
  }

  async function connect(key: string): Promise<{ daytona: DaytonaClientLike; Image: DaytonaSdkLike["Image"] }> {
    const pendingSdk = (sdkPromise ??= loadSdk());
    let sdk: DaytonaSdkLike;
    try {
      sdk = await pendingSdk;
    } catch (error) {
      // A transient loader failure must not poison later setup retries.
      if (sdkPromise === pendingSdk) sdkPromise = undefined;
      throw error;
    }
    return { daytona: new sdk.Daytona({ apiKey: key }), Image: sdk.Image };
  }

  async function preflight(context: AdapterContext): Promise<ProviderEvidence> {
    const observedAt = context.now().toISOString();
    const key = apiKey();
    if (!key) return missingKeyEvidence(observedAt);
    let daytona: DaytonaClientLike;
    try {
      ({ daytona } = await connect(key));
    } catch (error) {
      return sdkLoadErrorEvidence(error, observedAt);
    }
    try {
      // One cheap authenticated call proves the key works; the snapshot page
      // also carries the organization id when the org has any snapshots.
      const page = await daytona.snapshot.list(1, 1);
      const org = page?.items?.find((item) => typeof item?.organizationId === "string" && item.organizationId)
        ?.organizationId;
      return {
        status: "ready",
        owner: "runtime_provider",
        summary: boundSummary(
          org
            ? `Daytona API authentication verified for organization ${org}.`
            : "Daytona API authentication verified."
        ),
        observedAt,
      };
    } catch (error) {
      return {
        status: "error",
        owner: "operator",
        summary: boundSummary(`Daytona API authentication failed: ${describeError(error, key)}`),
        recoveryAction:
          "Check that DAYTONA_API_KEY is a valid API key for your Daytona organization (https://app.daytona.io) and re-run setup.",
        observedAt,
      };
    }
  }

  async function inspect(context: AdapterContext): Promise<RuntimeEnsureResult | ProviderPendingEvidence> {
    const release = context.release;
    const name = resolveDaytonaSnapshotName(release);
    const observedAt = context.now().toISOString();
    if (release.recommendedResources.diskGb > DAYTONA_ORG_DISK_CAP_GIB) {
      return diskCapExceededEvidence(release, observedAt);
    }
    const key = apiKey();
    if (!key) return missingKeyEvidence(observedAt);
    let daytona: DaytonaClientLike;
    try {
      ({ daytona } = await connect(key));
    } catch (error) {
      return sdkLoadErrorEvidence(error, observedAt);
    }
    const probe = await probeSnapshot(daytona, name, key);
    if (probe.kind === "unreachable") return lookupErrorEvidence(probe.detail, release, observedAt);
    if (probe.kind === "unbuildable") return unbuildableEvidence(name, probe.state, release, observedAt);
    const disk = await assessOrgDisk(daytona, release.recommendedResources.diskGb);
    if (probe.kind === "missing") {
      return {
        status: "needs_action",
        owner: "runtime_provider",
        summary: boundSummary(
          `Daytona snapshot ${name} not found; ensure will create it with an exact digest-backed wrapper build ` +
            `from ${release.sandboxImage} and no repository build context (${disk.note})`
        ),
        ...(disk.overCap ? { recoveryAction: DISK_CLEANUP_RECOVERY } : {}),
        releaseId: release.releaseId,
        observedAt,
      };
    }
    const evidence: ProviderEvidence = disk.overCap
      ? {
          status: "needs_action",
          owner: "operator",
          summary: boundSummary(
            `Daytona snapshot ${name} is active (${describeResources(release)}), but ${disk.note}`
          ),
          recoveryAction: DISK_CLEANUP_RECOVERY,
          resourceRef: `daytona:snapshot/${name}`,
          releaseId: release.releaseId,
          observedAt,
        }
      : {
          status: "ready",
          owner: "runtime_provider",
          summary: boundSummary(
            `Daytona snapshot ${name} is active (${describeResources(release)}); ${disk.note}`
          ),
          resourceRef: `daytona:snapshot/${name}`,
          releaseId: release.releaseId,
          observedAt,
        };
    return { evidence, fragment: fragmentFor(name, release) };
  }

  async function plan(context: AdapterContext): Promise<ProviderPlan> {
    const release = context.release;
    const name = resolveDaytonaSnapshotName(release);
    const none: ProviderPlan = { mutations: [], billable: false, externallyVisible: false };
    // Ensure surfaces the unrecoverable disk-cap error and the credential gap
    // as evidence; neither adds a mutation.
    if (release.recommendedResources.diskGb > DAYTONA_ORG_DISK_CAP_GIB) return none;
    const key = apiKey();
    if (!key) return none;
    let probe: SnapshotProbe;
    try {
      probe = await probeSnapshot((await connect(key)).daytona, name, key);
    } catch (error) {
      probe = { kind: "unreachable", detail: describeError(error, key) };
    }
    // "unreachable" keeps the create mutation listed: ensure re-probes before
    // mutating, and over-reporting a possible create is safer than creating a
    // snapshot without an approved plan entry.
    if (probe.kind === "missing" || probe.kind === "unreachable") {
      return {
        mutations: [
          `create Daytona snapshot ${name} with an exact digest-backed wrapper build from ` +
            `${release.sandboxImage} and no repository build context (${describeResources(release)})`,
        ],
        billable: false,
        externallyVisible: false,
      };
    }
    return none;
  }

  async function ensure(context: AdapterContext): Promise<RuntimeEnsureResult> {
    const release = context.release;
    const name = resolveDaytonaSnapshotName(release);
    const fragment = fragmentFor(name, release);
    const observedAt = context.now().toISOString();
    if (release.recommendedResources.diskGb > DAYTONA_ORG_DISK_CAP_GIB) {
      return { evidence: diskCapExceededEvidence(release, observedAt), fragment };
    }
    const key = apiKey();
    if (!key) return { evidence: missingKeyEvidence(observedAt), fragment };
    let connection: Awaited<ReturnType<typeof connect>>;
    try {
      connection = await connect(key);
    } catch (error) {
      return { evidence: sdkLoadErrorEvidence(error, observedAt), fragment };
    }
    const { daytona, Image } = connection;
    const probe = await probeSnapshot(daytona, name, key);
    if (probe.kind === "unreachable") {
      return { evidence: lookupErrorEvidence(probe.detail, release, observedAt), fragment };
    }
    if (probe.kind === "unbuildable") {
      return { evidence: unbuildableEvidence(name, probe.state, release, observedAt), fragment };
    }
    if (probe.kind === "missing") {
      try {
        // A string image uses Daytona's imageName path, which rewrites digest
        // syntax as a tag. Image.base instead emits exactly `FROM <digest>\n`
        // with zero context, so the SDK submits a digest-backed wrapper build.
        // No repository Dockerfile or build context is read.
        await daytona.snapshot.create(
          {
            name,
            image: Image.base(release.sandboxImage),
            resources: {
              cpu: release.recommendedResources.cpu,
              memory: memoryMbToGib(release.recommendedResources.memoryMb),
              disk: release.recommendedResources.diskGb,
            },
          },
          { onLogs: (chunk) => log?.(chunk) }
        );
      } catch (error) {
        return {
          evidence: {
            status: "error",
            owner: "operator",
            summary: boundSummary(`Daytona snapshot create failed for ${name}: ${describeError(error, key)}`),
            recoveryAction: "Inspect the failed snapshot in Daytona, delete it if present, and re-run setup.",
            releaseId: release.releaseId,
            observedAt,
          },
          fragment,
        };
      }
    }
    // Re-inspect so the returned result reflects the freshly observed state.
    const inspection = await inspect(context);
    if ("fragment" in inspection) return inspection;
    return { evidence: inspection, fragment };
  }

  return { id: DAYTONA_PROVIDER_ID, preflight, inspect, plan, ensure };
}
