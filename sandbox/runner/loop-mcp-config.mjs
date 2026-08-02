#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_REPOSITORY_CONFIG_PATH = "/var/lib/openthrottle/stage-input/repository-config.json";
const MAX_REPOSITORY_CONFIG_BYTES = 64 * 1024;
// Sandbox cannot import @openthrottle/contracts (separate deployable, no TS
// build step -- see execute-loop.test.mjs's LOGICAL_CREDENTIAL_SCOPES
// cross-check for the same constraint), so this hand-mirrors contracts/src/
// validation.ts's IDENTIFIER pattern exactly, including its allowed `/`
// separator. A stricter local regex here would reject an MCP server name
// that admission already accepted, failing an admitted action solely on
// validator drift between the two layers.
const MCP_SERVER_NAME = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const MCP_SERVER_NAME_MAX_LENGTH = 512;
// Hand-mirrors contracts/src/config.ts's (unexported) ENV_NAME, cross-checked
// by source text below for the same reason as MCP_SERVER_NAME above.
const MCP_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

// The clean trusted baseline for MCP structure: the sealed repository config
// uploaded at bootstrap, never a real operator's personal MCP configuration.
// OT_STAGE_CONFIG_FILE (already set by the Daytona adapter's dispatchStage)
// is honored when present; the fixed bootstrap path is the reliable fallback
// so loop actions never depend on stage env inheritance to find it.
export function readSealedRepositoryConfig(
  path = process.env.OT_STAGE_CONFIG_FILE ?? DEFAULT_REPOSITORY_CONFIG_PATH
) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_REPOSITORY_CONFIG_BYTES) {
    throw new Error("sealed repository config exceeds 64 KiB");
  }
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

export function selectAllowedMcpServers(allowedMcpServers, repositoryConfig = null) {
  const selected = {};
  // Most loop actions declare no MCP servers at all; skip the sealed-config
  // disk read and parse entirely for that common case rather than paying it
  // on every dispatch only to discard the result in the loop below.
  if (allowedMcpServers.length === 0) return selected;
  const resolvedConfig = repositoryConfig ?? readSealedRepositoryConfig();
  const servers = resolvedConfig.mcp_servers && typeof resolvedConfig.mcp_servers === "object"
    ? resolvedConfig.mcp_servers
    : {};
  for (const name of allowedMcpServers) {
    if (name.length > MCP_SERVER_NAME_MAX_LENGTH || !MCP_SERVER_NAME.test(name)) {
      throw new Error(`allowed MCP server name ${name} is invalid`);
    }
    const server = servers[name];
    if (!server || server.enabled === false) continue;
    selected[name] = assertObject(server, `mcp_servers.${name}`);
  }
  return selected;
}

export function buildClaudeMcpConfig(mcpServers) {
  const entries = {};
  for (const [name, server] of Object.entries(mcpServers)) {
    if (typeof server.command === "string" && server.command.trim()) {
      entries[name] = {
        type: "stdio",
        command: server.command,
        args: Array.isArray(server.args) ? server.args : [],
        env: server.env && typeof server.env === "object" ? server.env : {},
      };
    } else if (typeof server.url === "string" && server.url.trim()) {
      entries[name] = {
        type: "http",
        url: server.url,
        headers: server.headers && typeof server.headers === "object" ? server.headers : {},
      };
    } else {
      throw new Error(`mcp_servers.${name} must define command or url`);
    }
  }
  return { mcpServers: entries };
}

// Returns the written config path, or null when there is nothing to declare
// (the common case: most loop actions have no allowed MCP servers at all).
export function writeClaudeMcpConfigFile(mcpServers, configDir) {
  if (Object.keys(mcpServers).length === 0) return null;
  const config = buildClaudeMcpConfig(mcpServers);
  mkdirSync(configDir, { recursive: true, mode: 0o755 });
  const path = join(configDir, "mcp-config.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o444 });
  return path;
}

// TOML basic-string escapes (https://toml.io/en/v1.0.0#string): backslash and
// quote plus every control character except tab must be escaped, or a
// repo-controlled command/args/env value containing e.g. a raw newline can
// break out of the string and inject additional TOML content -- including
// content outside this action's declared allowedMcpServers.
const TOML_BASIC_ESCAPES = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r", '"': '\\"', "\\": "\\\\" };

function tomlString(value) {
  let escaped = "";
  for (const char of String(value)) {
    const codePoint = char.codePointAt(0);
    if (TOML_BASIC_ESCAPES[char]) {
      escaped += TOML_BASIC_ESCAPES[char];
    } else if (codePoint < 0x20 || codePoint === 0x7f) {
      escaped += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else {
      escaped += char;
    }
  }
  return `"${escaped}"`;
}

function tomlStringArray(values) {
  return `[${values.map(tomlString).join(", ")}]`;
}

export function codexMcpServersToml(mcpServers) {
  const blocks = [];
  for (const [name, server] of Object.entries(mcpServers)) {
    if (typeof server.command !== "string" || !server.command.trim()) {
      // The installed Codex CLI only supports local (stdio) MCP servers. A
      // remote-only server assigned to a codex-agent worker would otherwise
      // silently grant Codex a smaller tool surface than an identically
      // scoped Claude worker with no signal anywhere that this happened;
      // fail closed instead so the mismatch is caught rather than hidden.
      throw new Error(`mcp_servers.${name} has no local (stdio) command; Codex loop actions cannot use a remote-only MCP server`);
    }
    // `name` is a bare interpolation target, so it must be a quoted TOML key
    // segment (tomlString), never a raw bareword: IDENTIFIER (and therefore
    // this server's own admitted name) allows '.' and '/', and an unquoted
    // '.' is TOML's own nested-table separator while '/' is not a valid
    // bareword character at all -- either would corrupt or misparse this
    // table header for a validly admitted server name.
    const lines = [`[mcp_servers.${tomlString(name)}]`, `command = ${tomlString(server.command)}`];
    if (Array.isArray(server.args) && server.args.length > 0) {
      lines.push(`args = ${tomlStringArray(server.args)}`);
    }
    const env = server.env && typeof server.env === "object" ? server.env : {};
    const envEntries = Object.entries(env);
    if (envEntries.length > 0) {
      lines.push(`[mcp_servers.${tomlString(name)}.env]`);
      for (const [key, value] of envEntries) {
        if (!MCP_ENV_NAME.test(key)) throw new Error(`mcp_servers.${name}.env key ${key} is invalid`);
        lines.push(`${key} = ${tomlString(value)}`);
      }
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.length > 0 ? `\n${blocks.join("\n\n")}\n` : "";
}

// Appends to the action-scoped config.toml already materialized from the
// trusted Codex baseline. Returns whether anything was appended.
export function appendCodexMcpConfig(mcpServers, configPath) {
  const toml = codexMcpServersToml(mcpServers);
  if (!toml) return false;
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  writeFileSync(configPath, `${existing}${toml}`, { mode: 0o644 });
  return true;
}
