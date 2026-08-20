#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OPENCODE_PROGRESSIVE_SKILLS_CAPABILITY } from "./action-profile.mjs";

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

function progressiveSkillPolicy(allowedSkills) {
  if (!Array.isArray(allowedSkills) || allowedSkills.some((name) =>
    typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
    throw new Error("OpenCode allowedSkills must be native Agent Skill names");
  }
  if (new Set(allowedSkills).size !== allowedSkills.length) {
    throw new Error("OpenCode allowedSkills must not contain duplicates");
  }
  return Object.fromEntries([["*", "deny"], ...allowedSkills.map((name) => [name, "allow"])]);
}

export function buildOpenCodeConfig({
  model,
  mcpServers = {},
  inspection = false,
  skillRoot,
  allowedSkills = [],
  progressiveSkillsCapability,
}) {
  const profile = resolveOpenCodeModelProfile(model);
  const skillBound = allowedSkills.length > 0 || skillRoot !== undefined;
  if (skillBound && progressiveSkillsCapability !== OPENCODE_PROGRESSIVE_SKILLS_CAPABILITY) {
    throw new Error("OpenCode native progressive-skill capability is unavailable");
  }
  if (skillBound && (typeof skillRoot !== "string" || !skillRoot.startsWith("/"))) {
    throw new Error("OpenCode skillRoot must be an absolute sealed path");
  }
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    ...(skillBound ? { skills: [skillRoot] } : {}),
    permission: inspection
      ? {
          edit: "deny",
          bash: "deny",
          webfetch: "deny",
          task: "deny",
          external_directory: "deny",
          skill: progressiveSkillPolicy(allowedSkills),
        }
      : {
          edit: "allow",
          bash: "allow",
          webfetch: "allow",
          skill: progressiveSkillPolicy(allowedSkills),
        },
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
    mcp: inspection ? {} : translateMcpServers(mcpServers),
  };
}

export function writeOpenCodeConfig(options) {
  const { configDir } = options;
  if (!configDir) throw new Error("configDir is required");
  const config = buildOpenCodeConfig(options);
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
    else if (arg === "--skill-root") args.skillRoot = argv[++i];
    else if (arg === "--allowed-skills-json") args.allowedSkills = JSON.parse(argv[++i] || "[]");
    else if (arg === "--progressive-skills-capability") args.progressiveSkillsCapability = argv[++i];
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
