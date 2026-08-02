import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendCodexMcpConfig,
  buildClaudeMcpConfig,
  codexMcpServersToml,
  readSealedRepositoryConfig,
  selectAllowedMcpServers,
  writeClaudeMcpConfigFile,
} from "./loop-mcp-config.mjs";

describe("loop action MCP config materialization", () => {
  const directories = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function tempDir() {
    const directory = mkdtempSync(join(tmpdir(), "ot-loop-mcp-"));
    directories.push(directory);
    return directory;
  }

  const repositoryConfig = {
    mcp_servers: {
      github: { command: "mcp-github", args: ["--stdio"], env: { GITHUB_MCP_MODE: "readonly" } },
      docs: { url: "https://mcp.example.com/docs", headers: { "X-Team": "openthrottle" } },
      disabled: { command: "mcp-disabled", enabled: false },
    },
  };

  it("selects only the declared, enabled MCP servers from the sealed repository config", () => {
    expect(selectAllowedMcpServers(["github"], repositoryConfig)).toEqual({
      github: repositoryConfig.mcp_servers.github,
    });
    expect(selectAllowedMcpServers(["disabled"], repositoryConfig)).toEqual({});
    expect(selectAllowedMcpServers(["not-configured"], repositoryConfig)).toEqual({});
    expect(selectAllowedMcpServers([], repositoryConfig)).toEqual({});
  });

  it("rejects an unsafe allowed MCP server name", () => {
    expect(() => selectAllowedMcpServers(["../escape"], repositoryConfig)).toThrow(/is invalid/);
  });

  it("accepts every MCP server name shape the shared IDENTIFIER contract admits, including a '/' segment", () => {
    // contracts/src/validation.ts's IDENTIFIER (used to validate
    // worker.allowed_mcp_servers and config.mcp_servers keys at admission)
    // permits '/' as a segment separator, e.g. a team-namespaced server name.
    // This runtime check must not be stricter than what admission already
    // accepted, or an admitted action fails solely on validator drift.
    const namespaced = { mcp_servers: { "team/github": { command: "mcp-github" } } };
    expect(selectAllowedMcpServers(["team/github"], namespaced)).toEqual({
      "team/github": namespaced.mcp_servers["team/github"],
    });
  });

  it("keeps the sandbox-side MCP server name pattern aligned with contracts' IDENTIFIER", () => {
    // The sandbox cannot import @openthrottle/contracts (see the
    // LOGICAL_CREDENTIAL_SCOPES cross-check in execute-loop.test.mjs for the
    // same constraint), so this is a hand-mirrored copy. Cross-check the two
    // source texts so a future change to one is caught if the other isn't
    // updated to match.
    const sandboxSource = readFileSync(new URL("./loop-mcp-config.mjs", import.meta.url), "utf8");
    const sandboxMatch = sandboxSource.match(/const MCP_SERVER_NAME = (\/\^.*\$\/);/);
    expect(sandboxMatch).not.toBeNull();

    const contractsSource = readFileSync(
      new URL("../../contracts/src/validation.ts", import.meta.url),
      "utf8"
    );
    const contractsMatch = contractsSource.match(/export const IDENTIFIER = (\/\^.*\$\/);/);
    expect(contractsMatch).not.toBeNull();

    expect(sandboxMatch[1]).toBe(contractsMatch[1]);
  });

  it("rejects a repository-declared server entry that is not an object", () => {
    expect(() => selectAllowedMcpServers(["weird"], { mcp_servers: { weird: "not-an-object" } }))
      .toThrow(/mcp_servers\.weird must be an object/);
  });

  it("reads the sealed repository config from a fixed, well-known path rather than inherited env", () => {
    const dir = tempDir();
    const path = join(dir, "repository-config.json");
    writeFileSync(path, JSON.stringify(repositoryConfig));
    expect(readSealedRepositoryConfig(path)).toEqual(repositoryConfig);
    expect(readSealedRepositoryConfig(join(dir, "missing.json"))).toEqual({});
  });

  it("rejects an oversized sealed repository config", () => {
    const dir = tempDir();
    const path = join(dir, "repository-config.json");
    writeFileSync(path, JSON.stringify({ mcp_servers: { big: { command: "x".repeat(70_000) } } }));
    expect(() => readSealedRepositoryConfig(path)).toThrow(/exceeds 64 KiB/);
  });

  it("rejects a malformed server entry defining neither command nor url", () => {
    expect(() => buildClaudeMcpConfig({ bad: { note: "no command or url" } }))
      .toThrow(/mcp_servers\.bad must define command or url/);
  });

  it("builds a clean Claude MCP config for local and remote servers", () => {
    const config = buildClaudeMcpConfig(selectAllowedMcpServers(["github", "docs"], repositoryConfig));
    expect(config).toEqual({
      mcpServers: {
        github: { type: "stdio", command: "mcp-github", args: ["--stdio"], env: { GITHUB_MCP_MODE: "readonly" } },
        docs: { type: "http", url: "https://mcp.example.com/docs", headers: { "X-Team": "openthrottle" } },
      },
    });
  });

  it("writes no Claude config file when no MCP servers are declared", () => {
    const dir = tempDir();
    expect(writeClaudeMcpConfigFile({}, join(dir, "mcp"))).toBeNull();
    expect(existsSync(join(dir, "mcp"))).toBe(false);
  });

  it("writes a read-only Claude MCP config file when servers are declared", () => {
    const dir = tempDir();
    const configDir = join(dir, "mcp");
    const path = writeClaudeMcpConfigFile({ github: repositoryConfig.mcp_servers.github }, configDir);
    expect(path).toBe(join(configDir, "mcp-config.json"));
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.mcpServers.github.command).toBe("mcp-github");
  });

  it("serializes local (stdio) servers to Codex config.toml", () => {
    const toml = codexMcpServersToml(selectAllowedMcpServers(["github"], repositoryConfig));
    expect(toml).toContain('[mcp_servers.github]');
    expect(toml).toContain('command = "mcp-github"');
    expect(toml).toContain('args = ["--stdio"]');
    expect(toml).toContain('[mcp_servers.github.env]');
    expect(toml).toContain('GITHUB_MCP_MODE = "mcp-github"'.replace("mcp-github", "readonly"));
  });

  it("fails closed on a remote-only MCP server instead of silently dropping it", () => {
    expect(() => codexMcpServersToml(selectAllowedMcpServers(["docs"], repositoryConfig)))
      .toThrow(/mcp_servers\.docs has no local \(stdio\) command/);
  });

  it("escapes quotes and backslashes in TOML string values", () => {
    const toml = codexMcpServersToml({ tricky: { command: 'c:\\"tool"' } });
    expect(toml).toContain('command = "c:\\\\\\"tool\\""');
  });

  it("escapes control characters in TOML string values instead of breaking out of the quoted string", () => {
    // A repo-controlled command/arg/env value containing a raw newline or
    // other control character must not be able to terminate the TOML string
    // early and inject content into a later table (e.g. an [mcp_servers.*]
    // block outside this action's declared allowedMcpServers).
    const toml = codexMcpServersToml({
      tricky: { command: "tool", args: ["line1\nline2\ttabbed\x01ctrl"] },
    });
    expect(toml).toContain('args = ["line1\\nline2\\ttabbed\\u0001ctrl"]');
    // The escaped value must not introduce a raw newline that would let it
    // span multiple lines or terminate the string early.
    const argsLine = toml.split("\n").find((line) => line.startsWith("args ="));
    expect(argsLine).toBe('args = ["line1\\nline2\\ttabbed\\u0001ctrl"]');
  });

  it("produces no TOML output when there is nothing to declare", () => {
    expect(codexMcpServersToml({})).toBe("");
  });

  it("appends MCP servers to an existing config.toml without disturbing its content", () => {
    const dir = tempDir();
    const configPath = join(dir, "config.toml");
    writeFileSync(configPath, "# baseline config\n");
    const appended = appendCodexMcpConfig(selectAllowedMcpServers(["github"], repositoryConfig), configPath);
    expect(appended).toBe(true);
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("# baseline config");
    expect(content).toContain("[mcp_servers.github]");
  });

  it("is a no-op append when no MCP servers are declared", () => {
    const dir = tempDir();
    const configPath = join(dir, "config.toml");
    writeFileSync(configPath, "# baseline config\n");
    expect(appendCodexMcpConfig({}, configPath)).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe("# baseline config\n");
  });

  it("rejects an unsafe MCP env var name", () => {
    expect(() => codexMcpServersToml({ bad: { command: "x", env: { "not-an-env-name": "1" } } }))
      .toThrow(/is invalid/);
  });
});
