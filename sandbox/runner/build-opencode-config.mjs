#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const OPENCODE_MODEL_PROFILES = Object.freeze({
  "kimi-code/kimi-for-coding": Object.freeze({
    providerId: "kimi-code",
    modelId: "kimi-for-coding",
    baseURL: "https://api.kimi.com/coding/v1",
    contextLimit: 262_144,
    outputLimit: 65_536,
    apiKeyEnv: "KIMI_CODE_API_KEY",
  }),
});

const CE_PLUGIN_PATH = "/opt/openthrottle/compound-engineering-marketplace";

export function resolveOpenCodeModelProfile(model) {
  if (typeof model !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(model)) {
    throw new Error("OpenCode model must use provider/model format");
  }
  const profile = OPENCODE_MODEL_PROFILES[model];
  if (!profile) {
    throw new Error(
      `Unsupported OpenCode model '${model}'. Supported first-release model: kimi-code/kimi-for-coding`
    );
  }
  return profile;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function translateMcpServers(mcpServers = {}) {
  const servers = assertObject(mcpServers, "mcp_servers");
  const translated = {};
  for (const [name, raw] of Object.entries(servers)) {
    const server = assertObject(raw, `mcp_servers.${name}`);
    if (typeof server.command === "string" && server.command.trim()) {
      translated[name] = {
        type: "local",
        command: [server.command, ...(Array.isArray(server.args) ? server.args : [])],
        enabled: server.enabled ?? true,
        environment: assertObject(server.env ?? {}, `mcp_servers.${name}.env`),
      };
    } else if (typeof server.url === "string" && server.url.trim()) {
      translated[name] = {
        type: "remote",
        url: server.url,
        enabled: server.enabled ?? true,
        headers: assertObject(server.headers ?? {}, `mcp_servers.${name}.headers`),
      };
    } else {
      throw new Error(`mcp_servers.${name} must define command or url`);
    }
  }
  return translated;
}

export function buildOpenCodeConfig({ model, mcpServers = {} }) {
  const profile = resolveOpenCodeModelProfile(model);
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    permission: { edit: "allow", bash: "allow", webfetch: "allow" },
    plugin: [CE_PLUGIN_PATH],
    provider: {
      [profile.providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Kimi Code",
        options: {
          baseURL: profile.baseURL,
          apiKey: `{env:${profile.apiKeyEnv}}`,
        },
        models: {
          [profile.modelId]: {
            name: "kimi-for-coding",
            limit: { context: profile.contextLimit, output: profile.outputLimit },
          },
        },
      },
    },
    mcp: translateMcpServers(mcpServers),
  };
}

export function writeOpenCodeConfig({ model, mcpServers = {}, configDir }) {
  if (!configDir) throw new Error("configDir is required");
  const config = buildOpenCodeConfig({ model, mcpServers });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const configPath = join(configDir, "opencode.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return configPath;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--model") args.model = argv[++i];
    else if (arg === "--mcp-json") args.mcpServers = JSON.parse(argv[++i] || "{}");
    else if (arg === "--config-dir") args.configDir = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const configPath = writeOpenCodeConfig(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${configPath}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
