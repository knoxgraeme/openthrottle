import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { NetworkPolicy, SpriteInfo, SpritesClient } from "./sprites.js";
import {
  SpritesClient as RealSpritesClient,
  createForTicket,
  findSandboxForTicket,
  spriteName,
  startTask,
  toEnvVars,
  type SandboxEnvContract,
} from "./sprites.js";

const RUN_ENV_PATH = "/home/agent/.ot/run.env";
const LINEAR_CONTEXT_PATH = "/home/agent/.ot/linear-context.md";
const PROVISION_TAR_PATH = "/tmp/ot-payload.tar.gz";

// A real file the payload reader can open. The fake client never untars it.
const fixtureDir = mkdtempSync(join(tmpdir(), "ot-sprites-"));
const payloadTarPath = join(fixtureDir, "payload.tar.gz");
writeFileSync(payloadTarPath, "fake-tarball-bytes");

const cfg = {
  supervisorUrl: "https://ot.test",
  payloadTarPath,
} as Config;

const baseEnv: SandboxEnvContract = {
  TASK_TYPE: "resume",
  AGENT: "claude",
  GITHUB_REPO: "owner/repo",
  GITHUB_TOKEN: "github",
  BASE_BRANCH: "main",
  BRANCH_NAME: "ot/test",
  LINEAR_ISSUE_ID: "issue",
  LINEAR_ISSUE_IDENTIFIER: "OT-1",
  RUN_ID: "run",
  RUN_CALLBACK_TOKEN: "callback",
  SUPERVISOR_URL: "https://ot.test",
  MAX_TURNS: "200",
  TASK_TIMEOUT: "7200",
  DEV_PORT: "3000",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("spriteName", () => {
  it("normalizes an issue identifier to an RFC-1123-ish sprite name", () => {
    expect(spriteName("OT-1")).toBe("ot-ot-1");
    expect(spriteName("ENG-123")).toBe("ot-eng-123");
    expect(spriteName("A/B _ C")).toBe("ot-a-b-c");
  });

  it("collapses separators and caps the length to a valid label", () => {
    // Junk separators collapse; the `ot-` prefix keeps the result valid.
    expect(spriteName("///")).toBe("ot");
    const long = spriteName("X".repeat(80));
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });
});

describe("createForTicket", () => {
  it("creates the sprite, applies an egress policy, and runs provisioning", async () => {
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    const record = (fn: string) =>
      vi.fn(async (...args: unknown[]) => {
        calls.push({ fn, args });
        if (fn === "createSprite") return { name: args[0], url: `https://${args[0]}.fly.dev` } as SpriteInfo;
        if (fn === "exec") return { exitCode: 0, output: "" };
        return undefined;
      });
    const client = {
      createSprite: record("createSprite"),
      setNetworkPolicy: record("setNetworkPolicy"),
      fsWrite: record("fsWrite"),
      exec: record("exec"),
    } as unknown as SpritesClient;

    const handle = await createForTicket(client, cfg, { issueIdentifier: "OT-1", env: baseEnv });

    expect(handle).toEqual({ name: "ot-ot-1", url: "https://ot-ot-1.fly.dev" });
    expect(client.createSprite).toHaveBeenCalledWith("ot-ot-1", {
      waitForCapacity: true,
      urlAuth: "sprite",
    });
    // The network policy allows the supervisor callback host on top of defaults.
    const policy = calls.find((c) => c.fn === "setNetworkPolicy")?.args[1] as NetworkPolicy;
    expect(policy.rules).toEqual(
      expect.arrayContaining([
        { include: "defaults" },
        { domain: "ot.test", action: "allow" },
      ])
    );
    // The payload tarball is uploaded and provision.sh is executed.
    expect(client.fsWrite).toHaveBeenCalledWith("ot-ot-1", PROVISION_TAR_PATH, expect.any(Buffer), "0600");
    expect(client.exec).toHaveBeenCalledOnce();
    expect(String(calls.find((c) => c.fn === "exec")?.args[1])).toContain("provision.sh");
  });

  it("fails when provisioning exits non-zero", async () => {
    const client = {
      createSprite: vi.fn(async (name: string) => ({ name, url: "" }) as SpriteInfo),
      setNetworkPolicy: vi.fn(async () => undefined),
      fsWrite: vi.fn(async () => undefined),
      exec: vi.fn(async () => ({ exitCode: 3, output: "boom" })),
    } as unknown as SpritesClient;

    await expect(
      createForTicket(client, cfg, { issueIdentifier: "OT-1", env: baseEnv })
    ).rejects.toThrow(/provisioning failed/);
  });

  it("tolerates a 409 from the real client (idempotent by name)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 409 }))
    );
    const client = new RealSpritesClient("token", { baseURL: "https://api.test" });
    await expect(client.createSprite("ot-ot-1")).resolves.toEqual({ name: "ot-ot-1" });
  });
});

describe("startTask", () => {
  it("writes run.env and linear-context.md, then PUTs the run service", async () => {
    const writes: Array<{ path: string; content: Buffer }> = [];
    const services: Array<{ service: string }> = [];
    const client = {
      fsWrite: vi.fn(async (_name: string, path: string, content: Buffer) => {
        writes.push({ path, content });
      }),
      putService: vi.fn(async (_name: string, service: string) => {
        services.push({ service });
      }),
    } as unknown as SpritesClient;

    await startTask(client, "ot-ot-1", {
      env: baseEnv,
      linearContext: "# OT-1\n\nApproved plan",
      taskTimeoutSeconds: 60,
    });

    const envWrite = writes.find((w) => w.path === RUN_ENV_PATH);
    expect(envWrite).toBeDefined();
    const envText = envWrite!.content.toString("utf8");
    expect(envText).toContain("AGENT='claude'");
    expect(envText).toContain("SUPERVISOR_URL='https://ot.test'");
    expect(envText).toContain("RUN_CALLBACK_TOKEN='callback'");

    const contextWrite = writes.find((w) => w.path === LINEAR_CONTEXT_PATH);
    expect(contextWrite?.content.toString("utf8")).toBe("# OT-1\n\nApproved plan");

    expect(client.fsWrite).toHaveBeenCalledWith(
      "ot-ot-1",
      RUN_ENV_PATH,
      expect.any(Buffer),
      "0600"
    );
    expect(services).toEqual([{ service: "run" }]);
  });

  it("shell-quotes values so secrets never break the env file", async () => {
    const writes: Array<{ path: string; content: Buffer }> = [];
    const client = {
      fsWrite: vi.fn(async (_name: string, path: string, content: Buffer) => {
        writes.push({ path, content });
      }),
      putService: vi.fn(async () => undefined),
    } as unknown as SpritesClient;

    await startTask(client, "ot-ot-1", {
      env: { ...baseEnv, RESUME_MESSAGE: "it's a 'tricky' value" },
      linearContext: "ctx",
      taskTimeoutSeconds: 60,
    });

    const envText = writes.find((w) => w.path === RUN_ENV_PATH)!.content.toString("utf8");
    expect(envText).toContain("RESUME_MESSAGE='it'\\''s a '\\''tricky'\\'' value'");
  });
});

describe("findSandboxForTicket", () => {
  it("maps a found sprite to a handle", async () => {
    const client = {
      getSprite: vi.fn(async (name: string) => ({
        name,
        url: "https://ot-ot-1.fly.dev",
        updated_at: "2026-07-18T00:00:00.000Z",
      })),
    } as unknown as SpritesClient;

    await expect(findSandboxForTicket(client, "OT-1")).resolves.toEqual({
      name: "ot-ot-1",
      url: "https://ot-ot-1.fly.dev",
      updatedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(client.getSprite).toHaveBeenCalledWith("ot-ot-1");
  });

  it("maps a 404 (undefined) to undefined", async () => {
    const client = {
      getSprite: vi.fn(async () => undefined),
    } as unknown as SpritesClient;
    await expect(findSandboxForTicket(client, "OT-1")).resolves.toBeUndefined();
  });

  it("real client returns undefined on a 404 get", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 }))
    );
    const client = new RealSpritesClient("token", { baseURL: "https://api.test" });
    await expect(findSandboxForTicket(client, "OT-1")).resolves.toBeUndefined();
  });
});

describe("toEnvVars", () => {
  it("drops undefined optionals", () => {
    expect(toEnvVars({ ...baseEnv, RESUME_MESSAGE: undefined })).not.toHaveProperty("RESUME_MESSAGE");
    expect(toEnvVars({ ...baseEnv, RESUME_MESSAGE: "hi" })).toHaveProperty("RESUME_MESSAGE", "hi");
  });
});
