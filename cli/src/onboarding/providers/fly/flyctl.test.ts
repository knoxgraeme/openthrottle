import { describe, expect, it } from "vitest";
import {
  createFlyctlRunner,
  FlyctlClient,
  FlyctlCommandError,
  FlyctlNotFoundError,
  FlyctlParseError,
  type FlyctlResult,
  type FlyctlRunner,
} from "./flyctl.js";

function fakeRunner(respond: (args: string[]) => Partial<FlyctlResult>): { runner: FlyctlRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      async run(args: string[]): Promise<FlyctlResult> {
        calls.push([...args]);
        return { stdout: "", stderr: "", code: 0, ...respond(args) };
      },
    },
  };
}

function clientReturning(stdout: string): { client: FlyctlClient; calls: string[][] } {
  const { runner, calls } = fakeRunner(() => ({ stdout }));
  return { client: new FlyctlClient(runner), calls };
}

describe("flyctl typed helpers", () => {
  it("reads version via --json and accepts either field casing", async () => {
    const capitalized = clientReturning(JSON.stringify({ Name: "flyctl", Version: "0.3.100", Extra: true }));
    await expect(capitalized.client.version()).resolves.toBe("0.3.100");
    expect(capitalized.calls).toEqual([["version", "--json"]]);

    const lowercase = clientReturning(JSON.stringify({ version: "0.2.7" }));
    await expect(lowercase.client.version()).resolves.toBe("0.2.7");
  });

  it("raises typed errors for malformed version output and non-zero exits", async () => {
    const malformed = clientReturning("flyctl v0.3.100 darwin/arm64");
    await expect(malformed.client.version()).rejects.toBeInstanceOf(FlyctlParseError);

    const missingField = clientReturning(JSON.stringify({ Name: "flyctl" }));
    await expect(missingField.client.version()).rejects.toBeInstanceOf(FlyctlParseError);

    const { runner } = fakeRunner(() => ({ code: 3, stderr: "boom" }));
    const failing = new FlyctlClient(runner);
    const error = await failing.version().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FlyctlCommandError);
    expect((error as FlyctlCommandError).code).toBe(3);
    expect((error as FlyctlCommandError).command).toBe("version");
  });

  it("reads the account via auth whoami --json with a plain-text fallback", async () => {
    const json = clientReturning(JSON.stringify({ email: "ops@example.com" }));
    await expect(json.client.whoami()).resolves.toBe("ops@example.com");
    expect(json.calls).toEqual([["auth", "whoami", "--json"]]);

    const capitalized = clientReturning(JSON.stringify({ Email: "caps@example.com" }));
    await expect(capitalized.client.whoami()).resolves.toBe("caps@example.com");

    // Older flyctl prints the bare email even under --json.
    const plain = clientReturning("legacy@example.com\n");
    await expect(plain.client.whoami()).resolves.toBe("legacy@example.com");

    const garbage = clientReturning("some multi word failure banner");
    await expect(garbage.client.whoami()).rejects.toBeInstanceOf(FlyctlParseError);
  });

  it("lists apps defensively, ignoring unknown fields and nameless entries", async () => {
    const { client, calls } = clientReturning(
      JSON.stringify([
        { Name: "alpha", Organization: { Slug: "personal" } },
        { name: "beta", deployed: true },
        { id: "nameless" },
        null,
      ])
    );
    await expect(client.appsList()).resolves.toEqual([{ name: "alpha" }, { name: "beta" }]);
    expect(calls).toEqual([["apps", "list", "--json"]]);
  });

  it("lists bounded volume identity and attachment with defensive field casing", async () => {
    const { client, calls } = clientReturning(
      JSON.stringify([
        {
          id: "vol_abc123",
          name: "openthrottle_data",
          region: "sjc",
          attached_machine_id: null,
          state: "created",
        },
        {
          ID: "vol_def456",
          Name: "legacy_volume",
          Region: "fra",
          AttachedMachineId: "machine-1",
        },
      ])
    );
    await expect(client.volumesList("app-1")).resolves.toEqual([
      {
        id: "vol_abc123",
        name: "openthrottle_data",
        region: "sjc",
        attachedMachineId: null,
      },
      {
        id: "vol_def456",
        name: "legacy_volume",
        region: "fra",
        attachedMachineId: "machine-1",
      },
    ]);
    expect(calls).toEqual([["volumes", "list", "--app", "app-1", "--json"]]);
  });

  it("rejects incomplete or unbounded volume identity", async () => {
    const missingRegion = clientReturning(JSON.stringify([
      { id: "vol_abc123", name: "openthrottle_data" },
    ]));
    await expect(missingRegion.client.volumesList("app-1")).rejects.toThrow("omitted volume region");

    const unsafeAttachment = clientReturning(JSON.stringify([
      {
        id: "vol_abc123",
        name: "openthrottle_data",
        region: "sjc",
        attached_machine_id: "machine id with spaces",
      },
    ]));
    await expect(unsafeAttachment.client.volumesList("app-1")).rejects.toThrow(
      "invalid attached Machine ID",
    );
  });

  it("lists secret names and digests only", async () => {
    const { client, calls } = clientReturning(
      JSON.stringify([
        { Name: "OT_STATUS_TOKEN", Digest: "abc123", CreatedAt: "2026-08-14" },
        { name: "SUPERVISOR_URL", digest: "def456" },
        { name: "NO_DIGEST" },
      ])
    );
    await expect(client.secretsList("app-1")).resolves.toEqual([
      { name: "OT_STATUS_TOKEN", digest: "abc123" },
      { name: "SUPERVISOR_URL", digest: "def456" },
      { name: "NO_DIGEST" },
    ]);
    expect(calls).toEqual([["secrets", "list", "--app", "app-1", "--json"]]);
  });

  it("lists machines using the deploy workflow's state and image fallback chain", async () => {
    const { client, calls } = clientReturning(
      JSON.stringify([
        { id: "m1", state: "started", config: { image: "registry.fly.io/app@sha256:aa" } },
        { State: "Started", Config: { Image: "capitalized-image" } },
        { state: "stopped", imageRef: "ref-image" },
        { state: "started", ImageRef: "cap-ref-image" },
        { state: "started", image: "flat-image" },
        { state: "started", Image: "cap-flat-image" },
        { state: "started" },
      ])
    );
    await expect(client.machinesList("app-1")).resolves.toEqual([
      { state: "started", image: "registry.fly.io/app@sha256:aa" },
      { state: "started", image: "capitalized-image" },
      { state: "stopped", image: "ref-image" },
      { state: "started", image: "cap-ref-image" },
      { state: "started", image: "flat-image" },
      { state: "started", image: "cap-flat-image" },
      { state: "started" },
    ]);
    expect(calls).toEqual([["machines", "list", "--app", "app-1", "--json"]]);
  });

  it("treats null list output as empty and rejects non-array JSON with a typed error", async () => {
    const empty = clientReturning("null");
    await expect(empty.client.machinesList("app-1")).resolves.toEqual([]);

    const object = clientReturning(JSON.stringify({ machines: [] }));
    await expect(object.client.machinesList("app-1")).rejects.toBeInstanceOf(FlyctlParseError);

    const malformed = clientReturning("not json at all");
    await expect(malformed.client.appsList()).rejects.toBeInstanceOf(FlyctlParseError);
  });

  it("rejects unsafe app arguments before spawning anything", async () => {
    const { client, calls } = clientReturning("[]");
    await expect(client.volumesList("bad app; rm -rf /")).rejects.toThrow("Fly app name");
    expect(calls).toEqual([]);
  });

  it("surfaces a typed not-found error when the flyctl binary is unavailable", async () => {
    const runner = createFlyctlRunner({ env: { PATH: "/nonexistent-openthrottle-path" } });
    await expect(runner.run(["version"])).rejects.toBeInstanceOf(FlyctlNotFoundError);
  });
});
