#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
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

function externalReadPolicy(readableExternalPaths) {
  if (!Array.isArray(readableExternalPaths) || readableExternalPaths.length > 8) {
    throw new Error("OpenCode readableExternalPaths must be a bounded array");
  }
  const paths = readableExternalPaths.map((path) => {
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new Error("OpenCode readableExternalPaths must contain absolute paths");
    }
    const value = normalize(path);
    if (value === "/" || /[\0\r\n*?[\]\\]/u.test(value)) {
      throw new Error("OpenCode readableExternalPaths cannot widen inspection authority");
    }
    return value;
  });
  if (new Set(paths).size !== paths.length) {
    throw new Error("OpenCode readableExternalPaths must not contain duplicates");
  }
  return paths.length === 0
    ? "deny"
    : Object.fromEntries([["*", "deny"], ...paths.map((path) => [path, "allow"])]);
}

export function buildOpenCodeConfig({
  model,
  inspection = false,
  skillRoot,
  allowedSkills = [],
  readableExternalPaths = [],
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
          external_directory: externalReadPolicy(readableExternalPaths),
          skill: progressiveSkillPolicy(allowedSkills),
        }
      : {
          edit: "allow",
          bash: "allow",
          webfetch: "allow",
          external_directory: externalReadPolicy(readableExternalPaths),
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
    mcp: {},
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
    else if (arg === "--config-dir") args.configDir = argv[++i];
    else if (arg === "--skill-root") args.skillRoot = argv[++i];
    else if (arg === "--allowed-skills-json") args.allowedSkills = JSON.parse(argv[++i] || "[]");
    else if (arg === "--readable-external-paths-json") args.readableExternalPaths = JSON.parse(argv[++i] || "[]");
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
