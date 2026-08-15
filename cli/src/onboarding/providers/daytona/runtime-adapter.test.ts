import { describe, expect, it } from "vitest";
import type { AdapterContext, ReleaseManifest } from "../../contracts.js";
import { validateEvidence } from "../../profile-store.js";
import {
  createDaytonaRuntimeAdapter,
  memoryMbToGib,
  resolveDaytonaSnapshotName,
  type DaytonaClientLike,
  type DaytonaSandboxLike,
  type DaytonaSdkLike,
  type DaytonaSnapshotCreateParams,
  type DaytonaSnapshotLike,
} from "./runtime-adapter.js";

const release: ReleaseManifest = {
  schema: "openthrottle.release-manifest/v1",
  cliVersion: "2.0.0",
  releaseId: "v2.0.0",
  supervisorImage: `ghcr.io/acme/supervisor@sha256:${"a".repeat(64)}`,
  sandboxImage: `ghcr.io/acme/sandbox@sha256:${"b".repeat(64)}`,
  runtime: { release: "sandbox-v2", descriptorDigest: `sha256:${"c".repeat(64)}` },
  recommendedResources: { cpu: 2, memoryMb: 4096, diskGb: 20 },
};

const SNAPSHOT_NAME = "openthrottle-v2.0.0";
const env = { DAYTONA_API_KEY: "test-api-key" };

function contextFor(releaseOverride: ReleaseManifest = release): AdapterContext {
  return {
    profileName: "default",
    release: releaseOverride,
    now: () => new Date("2026-08-14T00:00:00.000Z"),
  };
}

function notFound(name: string): Error {
  return new Error(`Snapshot with name ${name} not found`);
}

function activeSnapshot(name: string): DaytonaSnapshotLike {
  return { name, state: "active", organizationId: "org-123" };
}

interface FakeSdkBehavior {
  get?: (name: string) => Promise<DaytonaSnapshotLike>;
  list?: () => Promise<{ items?: DaytonaSnapshotLike[] }>;
  create?: (
    params: DaytonaSnapshotCreateParams,
    options?: { onLogs?: (chunk: string) => void }
  ) => Promise<DaytonaSnapshotLike>;
  sandboxes?: DaytonaSandboxLike[];
}

interface FakeSdkCalls {
  loads: number;
  apiKeys: string[];
  getNames: string[];
  creates: DaytonaSnapshotCreateParams[];
  listPages: Array<Array<number | undefined>>;
}

function fakeSdk(behavior: FakeSdkBehavior = {}): { sdk: () => Promise<DaytonaSdkLike>; calls: FakeSdkCalls } {
  const calls: FakeSdkCalls = { loads: 0, apiKeys: [], getNames: [], creates: [], listPages: [] };
  const client: DaytonaClientLike = {
    snapshot: {
      async get(name) {
        calls.getNames.push(name);
        if (behavior.get) return behavior.get(name);
        return activeSnapshot(name);
      },
      async list(page, limit) {
        calls.listPages.push([page, limit]);
        if (behavior.list) return behavior.list();
        return { items: [{ organizationId: "org-123" }] };
      },
      async create(params, options) {
        calls.creates.push(params);
        if (behavior.create) return behavior.create(params, options);
        return activeSnapshot(params.name);
      },
    },
    ...(behavior.sandboxes
      ? {
          list(): AsyncIterable<DaytonaSandboxLike> {
            const sandboxes = behavior.sandboxes ?? [];
            return (async function* () {
              yield* sandboxes;
            })();
          },
        }
      : {}),
  };
  const Daytona = function (this: unknown, config: { apiKey: string }) {
    calls.apiKeys.push(config.apiKey);
    return client;
  } as unknown as DaytonaSdkLike["Daytona"];
  return {
    sdk: async () => {
      calls.loads += 1;
      return { Daytona };
    },
    calls,
  };
}

describe("daytona runtime adapter", () => {
  it("identifies as the daytona runtime provider", () => {
    expect(createDaytonaRuntimeAdapter({ env, sdk: fakeSdk().sdk }).id).toBe("daytona");
  });

  it("preflight reports needs_action without loading the SDK when DAYTONA_API_KEY is missing", async () => {
    const { sdk, calls } = fakeSdk();
    const adapter = createDaytonaRuntimeAdapter({ env: {}, sdk });

    const evidence = await adapter.preflight(contextFor());

    expect(evidence.status).toBe("needs_action");
    expect(evidence.owner).toBe("operator");
    expect(evidence.recoveryAction).toContain("DAYTONA_API_KEY");
    expect(evidence.recoveryAction).toContain("app.daytona.io");
    expect(calls.loads).toBe(0);
    expect(() => validateEvidence(evidence)).not.toThrow();

    const inspection = await adapter.inspect(contextFor());
    expect("fragment" in inspection).toBe(false);
    if ("fragment" in inspection) throw new Error("expected pending evidence");
    expect(inspection.status).toBe("needs_action");
    expect(calls.loads).toBe(0);
  });

  it("preflight surfaces auth failure as bounded evidence that never includes the key", async () => {
    const { sdk } = fakeSdk({
      list: async () => {
        throw new Error(`401 Unauthorized for key test-api-key ${"x".repeat(600)}`);
      },
    });
    const adapter = createDaytonaRuntimeAdapter({ env, sdk });

    const evidence = await adapter.preflight(contextFor());

    expect(evidence.status).toBe("error");
    expect(evidence.summary).toContain("authentication failed");
    expect(evidence.summary).not.toContain("test-api-key");
    expect(evidence.summary.length).toBeLessThanOrEqual(500);
    expect(evidence.recoveryAction).toContain("DAYTONA_API_KEY");
    expect(() => validateEvidence(evidence)).not.toThrow();
  });

  it("preflight makes one cheap authenticated call and names the organization", async () => {
    const { sdk, calls } = fakeSdk();
    const adapter = createDaytonaRuntimeAdapter({ env, sdk });

    const evidence = await adapter.preflight(contextFor());

    expect(evidence.status).toBe("ready");
    expect(evidence.summary).toContain("org-123");
    expect(calls.apiKeys).toEqual(["test-api-key"]);
    expect(calls.listPages).toEqual([[1, 1]]);
    expect(calls.getNames).toEqual([]);
    expect(() => validateEvidence(evidence)).not.toThrow();
  });

  it("inspect returns a ready result with the full deployment fragment for an active snapshot", async () => {
    const { sdk, calls } = fakeSdk();
    const adapter = createDaytonaRuntimeAdapter({ env, sdk });

    const result = await adapter.inspect(contextFor());

    if (!("fragment" in result)) throw new Error("expected an ensure result");
    expect(result.fragment).toEqual({
      providerId: "daytona",
      configuration: { snapshot: SNAPSHOT_NAME, cpu: 2, memoryGib: 4, diskGib: 20 },
      secrets: { DAYTONA_API_KEY: { owner: "operator", name: "daytona_api_key" } },
    });
    expect(result.evidence.status).toBe("ready");
    expect(result.evidence.resourceRef).toBe(`daytona:snapshot/${SNAPSHOT_NAME}`);
    expect(result.evidence.releaseId).toBe("v2.0.0");
    expect(result.evidence.observedAt).toBe("2026-08-14T00:00:00.000Z");
    // No cheap sandbox listing on this fake, so the static org-cap note applies.
    expect(result.evidence.summary).toContain("30 GiB");
    expect(calls.getNames).toEqual([SNAPSHOT_NAME]);
    expect(() => validateEvidence(result.evidence)).not.toThrow();
  });

  it("maps recommended memoryMb up to whole GiB", async () => {
    expect(memoryMbToGib(4096)).toBe(4);
    expect(memoryMbToGib(1536)).toBe(2);
    expect(memoryMbToGib(512)).toBe(1);

    const { sdk } = fakeSdk();
    const adapter = createDaytonaRuntimeAdapter({ env, sdk });
    const result = await adapter.inspect(
      contextFor({ ...release, recommendedResources: { cpu: 2, memoryMb: 1536, diskGb: 20 } })
    );
    if (!("fragment" in result)) throw new Error("expected an ensure result");
    expect(result.fragment.configuration).toMatchObject({ memoryGib: 2 });
  });

  it("inspect reports an error with a delete-before-rebuild recovery for a non-active snapshot", async () => {
    const { sdk } = fakeSdk({ get: async (name) => ({ name, state: "build_failed" }) });
    const adapter = createDaytonaRuntimeAdapter({ env, sdk });

    const result = await adapter.inspect(contextFor());

    if ("fragment" in result) throw new Error("expected pending evidence");
    expect(result.status).toBe("error");
    expect(result.summary).toContain("build_failed");
    expect(result.recoveryAction).toContain(`Delete snapshot ${SNAPSHOT_NAME} in Daytona before rebuilding.`);
    expect(() => validateEvidence(result)).not.toThrow();
  });

  it("inspect reports a missing snapshot as pending work that ensure will create", async () => {
    const { sdk } = fakeSdk({
      get: async (name) => {
        throw notFound(name);
      },
    });
    const adapter = createDaytonaRuntimeAdapter({ env, sdk });

    const result = await adapter.inspect(contextFor());

    if ("fragment" in result) throw new Error("expected pending evidence");
    expect(result.status).toBe("needs_action");
    expect(result.summary).toContain(`snapshot ${SNAPSHOT_NAME} not found`);
    expect(result.summary).toContain(release.sandboxImage);
    expect(() => validateEvidence(result)).not.toThrow();
  });

  it("plan lists the snapshot create mutation when the snapshot is missing", async () => {
    const { sdk } = fakeSdk({
      get: async (name) => {
        throw notFound(name);
      },
    });
    const adapter = createDaytonaRuntimeAdapter({ env, sdk });

    expect(await adapter.plan(contextFor())).toEqual({
      mutations: [
        `create Daytona snapshot ${SNAPSHOT_NAME} from ${release.sandboxImage} (cpu 2 / mem 4 GiB / disk 20 GiB)`,
      ],
      billable: false,
      externallyVisible: false,
    });
  });

  it("plan has zero mutations when the snapshot is already active", async () => {
    const { sdk } = fakeSdk();
    const adapter = createDaytonaRuntimeAdapter({ env, sdk });

    expect(await adapter.plan(contextFor())).toEqual({ mutations: [], billable: false, externallyVisible: false });
  });

  it("ensure creates the snapshot from the pinned registry image and returns the re-inspected result", async () => {
    let missing = true;
    const logs: string[] = [];
    const { sdk, calls } = fakeSdk({
      get: async (name) => {
        if (missing) throw notFound(name);
        return activeSnapshot(name);
      },
      create: async (params, options) => {
        missing = false;
        options?.onLogs?.("build progress line");
        return activeSnapshot(params.name);
      },
    });
    const adapter = createDaytonaRuntimeAdapter({ env, sdk, log: (line) => logs.push(line) });

    const result = await adapter.ensure(contextFor());

    expect(calls.creates).toEqual([
      { name: SNAPSHOT_NAME, image: release.sandboxImage, resources: { cpu: 2, memory: 4, disk: 20 } },
    ]);
    expect(logs).toEqual(["build progress line"]);
    // Probed once before the create and re-inspected once afterwards.
    expect(calls.getNames).toEqual([SNAPSHOT_NAME, SNAPSHOT_NAME]);
    expect(result.evidence.status).toBe("ready");
    expect(result.evidence.resourceRef).toBe(`daytona:snapshot/${SNAPSHOT_NAME}`);
    expect(result.fragment.configuration).toMatchObject({ snapshot: SNAPSHOT_NAME });
    expect(() => validateEvidence(result.evidence)).not.toThrow();
  });

  it("ensure surfaces a create failure as bounded error evidence instead of throwing", async () => {
    const { sdk } = fakeSdk({
      get: async (name) => {
        throw notFound(name);
      },
      create: async () => {
        throw new Error(`registry denied for key test-api-key ${"y".repeat(600)}`);
      },
    });
    const adapter = createDaytonaRuntimeAdapter({ env, sdk });

    const result = await adapter.ensure(contextFor());

    expect(result.evidence.status).toBe("error");
    expect(result.evidence.summary).toContain("create failed");
    expect(result.evidence.summary).not.toContain("test-api-key");
    expect(result.evidence.summary.length).toBeLessThanOrEqual(500);
    expect(() => validateEvidence(result.evidence)).not.toThrow();
  });

  it("rejects a recommended disk larger than the 30 GiB org cap before touching the SDK", async () => {
    const { sdk, calls } = fakeSdk();
    const adapter = createDaytonaRuntimeAdapter({ env, sdk });
    const context = contextFor({ ...release, recommendedResources: { cpu: 2, memoryMb: 4096, diskGb: 31 } });

    const inspection = await adapter.inspect(context);
    if ("fragment" in inspection) throw new Error("expected pending evidence");
    expect(inspection.status).toBe("error");
    expect(inspection.summary).toContain("30 GiB");
    expect(calls.loads).toBe(0);
    expect(() => validateEvidence(inspection)).not.toThrow();

    const ensured = await adapter.ensure(context);
    expect(ensured.evidence.status).toBe("error");
    expect(calls.creates).toEqual([]);
  });

  it("inspect downgrades an active snapshot to needs_action when existing plus planned disk exceeds the cap", async () => {
    const { sdk } = fakeSdk({
      sandboxes: [
        { disk: 20, state: "stopped" },
        { disk: 5, state: "started" },
        { disk: 99, state: "destroyed" }, // destroyed sandboxes no longer hold quota
      ],
    });
    const adapter = createDaytonaRuntimeAdapter({ env, sdk });

    const result = await adapter.inspect(contextFor());

    if (!("fragment" in result)) throw new Error("expected an ensure result");
    expect(result.evidence.status).toBe("needs_action");
    expect(result.evidence.summary).toContain("25 GiB");
    expect(result.evidence.recoveryAction).toContain("30 GiB");
    expect(() => validateEvidence(result.evidence)).not.toThrow();
  });

  it("inspect stays ready when existing plus planned disk fits under the cap", async () => {
    const { sdk } = fakeSdk({ sandboxes: [{ disk: 5, state: "stopped" }] });
    const adapter = createDaytonaRuntimeAdapter({ env, sdk });

    const result = await adapter.inspect(contextFor());

    if (!("fragment" in result)) throw new Error("expected an ensure result");
    expect(result.evidence.status).toBe("ready");
    expect(result.evidence.summary).toContain("existing sandboxes use 5 GiB");
  });

  it("ensure is not blocked by an over-cap disk sum but surfaces the cleanup evidence", async () => {
    let missing = true;
    const { sdk, calls } = fakeSdk({
      get: async (name) => {
        if (missing) throw notFound(name);
        return activeSnapshot(name);
      },
      create: async (params) => {
        missing = false;
        return activeSnapshot(params.name);
      },
      sandboxes: [{ disk: 28, state: "stopped" }],
    });
    const adapter = createDaytonaRuntimeAdapter({ env, sdk });

    const result = await adapter.ensure(contextFor());

    expect(calls.creates).toHaveLength(1);
    expect(result.evidence.status).toBe("needs_action");
    expect(result.evidence.recoveryAction).toContain("30 GiB");
    expect(() => validateEvidence(result.evidence)).not.toThrow();
  });

  it("derives the snapshot name from the release id and honors the manifest override", async () => {
    expect(resolveDaytonaSnapshotName(release)).toBe(SNAPSHOT_NAME);
    expect(
      resolveDaytonaSnapshotName({ ...release, runtime: { ...release.runtime, snapshotName: "custom-snap" } })
    ).toBe("custom-snap");
    expect(() => resolveDaytonaSnapshotName({ ...release, releaseId: "bad id!" })).toThrow("snapshot name");

    const { sdk, calls } = fakeSdk();
    const adapter = createDaytonaRuntimeAdapter({ env, sdk });
    const result = await adapter.inspect(
      contextFor({ ...release, runtime: { ...release.runtime, snapshotName: "custom-snap" } })
    );
    if (!("fragment" in result)) throw new Error("expected an ensure result");
    expect(calls.getNames).toEqual(["custom-snap"]);
    expect(result.fragment.configuration).toMatchObject({ snapshot: "custom-snap" });
    expect(result.evidence.resourceRef).toBe("daytona:snapshot/custom-snap");
  });
});
