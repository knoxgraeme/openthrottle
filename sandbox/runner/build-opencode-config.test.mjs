import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOpenCodeConfig,
  resolveOpenCodeModelProfile,
  translateMcpServers,
  writeOpenCodeConfig,
} from "./build-opencode-config.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("OpenCode config builder", () => {
  it("builds the Kimi Code subscription profile without materializing secrets", () => {
    const config = buildOpenCodeConfig({
      model: "kimi-code/kimi-for-coding",
      mcpServers: {},
    });

    expect(config.plugin).toEqual(["/opt/openthrottle/compound-engineering-marketplace"]);
    expect(config.provider["kimi-code"]).toMatchObject({
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: "https://api.kimi.com/coding/v1",
        apiKey: "{env:KIMI_CODE_API_KEY}",
      },
      models: {
        "kimi-for-coding": {
          limit: { context: 262_144 },
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain("secret-value");
  });

  it("fails closed for malformed and unsupported models", () => {
    expect(() => resolveOpenCodeModelProfile("kimi-for-coding")).toThrow("provider/model");
    expect(() => resolveOpenCodeModelProfile("kimi-code/kimi-k3")).toThrow(
      "Unsupported OpenCode model"
    );
  });

  it("translates local and remote MCP servers", () => {
    expect(
      translateMcpServers({
        local: { command: "node", args: ["server.mjs"], env: { A: "B" } },
        remote: { url: "https://mcp.example.test", headers: { Authorization: "Bearer token" } },
      })
    ).toEqual({
      local: {
        type: "local",
        command: ["node", "server.mjs"],
        enabled: true,
        environment: { A: "B" },
      },
      remote: {
        type: "remote",
        url: "https://mcp.example.test",
        enabled: true,
        headers: { Authorization: "Bearer token" },
      },
    });
  });

  it("names invalid MCP servers", () => {
    expect(() => translateMcpServers({ broken: { args: [] } })).toThrow("mcp_servers.broken");
  });

  it("writes deterministic config to the supplied directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "ot-opencode-config-"));
    directories.push(directory);
    const configPath = writeOpenCodeConfig({
      model: "kimi-code/kimi-for-coding",
      mcpServers: {},
      configDir: directory,
    });
    expect(configPath).toBe(join(directory, "opencode.json"));
    expect(readFileSync(configPath, "utf8")).toBe(
      `${JSON.stringify(buildOpenCodeConfig({ model: "kimi-code/kimi-for-coding" }), null, 2)}\n`
    );
  });
});
