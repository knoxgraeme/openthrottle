import {
  COMMAND_NAME_PATTERN,
  IDENTIFIER,
  arrayAt,
  booleanAt,
  enumAt,
  fail,
  integerAt,
  normalizedContract,
  objectAt,
  recordAt,
  stringAt,
  unique,
  type ValidatedContract,
} from "./validation.js";

const CONFIG_SCHEMA = "openthrottle.config/v1" as const;
const GRAPH_SOURCE_KINDS = ["builtin", "repository"] as const;
const CONFIG_AGENTS = ["claude", "codex", "opencode"] as const;
const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const DEFAULT_CONFIG_LIMITS = Object.freeze({
  max_turns: 200,
  task_timeout: 7_200,
} as const);

export interface ConfigGraphSource {
  id: string;
  kind: (typeof GRAPH_SOURCE_KINDS)[number];
  ref: string;
}

interface ConfigLimits {
  max_turns?: number;
  task_timeout?: number;
}

export interface ConfigMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface ConfigRepositorySkill {
  id: string;
  path: string;
  tunable?: boolean;
}

export interface ConfigAgentDefault {
  model?: string;
  reasoning_effort?: (typeof REASONING_EFFORTS)[number];
}

export interface RepositoryConfigContract {
  schema: typeof CONFIG_SCHEMA;
  default_graph: string;
  graphs: ConfigGraphSource[];
  skills?: ConfigRepositorySkill[];
  agent?: string;
  model?: string;
  agent_defaults?: Partial<Record<(typeof CONFIG_AGENTS)[number], ConfigAgentDefault>>;
  commands?: Record<string, string>;
  test?: string;
  lint?: string;
  build?: string;
  dev?: string;
  format?: string;
  post_bootstrap?: string[];
  limits?: ConfigLimits;
  mcp_servers?: Record<string, ConfigMcpServer>;
  pipelines?: Record<string, string>;
  intents?: Record<string, {
    default_graph: string;
    allowed_graphs: string[];
  }>;
}

const COMMAND_ALIAS_NAMES = ["test", "lint", "build", "dev", "format"] as const;
type CommandAliasName = (typeof COMMAND_ALIAS_NAMES)[number];

const BUILTIN_GRAPH = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*@\d+$/;
const REPOSITORY_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+\.json$/;
const REPOSITORY_DIR = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/;
const PIPELINE_REFERENCE = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*(?:@\d+)?$/;
const MODEL_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const PROVIDER_SECRET_NAMES = new Set([
  "OT_STATUS_TOKEN",
  "OT_INSTALL_SECRET",
  "LINEAR_API_KEY",
  "LINEAR_WEBHOOK_SECRET",
  "LINEAR_CLIENT_ID",
  "LINEAR_CLIENT_SECRET",
  "LINEAR_ACCESS_TOKEN",
  "LINEAR_REFRESH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_READ_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "DAYTONA_API_KEY",
  "DAYTONA_SNAPSHOT",
  "FLY_API_TOKEN",
  "FLY_ACCESS_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "KIMI_CODE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
]);
const SECRET_IDENTIFIER_SEGMENTS = new Set(["TOKEN", "KEY", "SECRET", "PASSWORD"]);
const ENV_REFERENCE = /[$%{]?[A-Z_][A-Z0-9_]*[%}]?/g;

function isProviderSecretIdentifier(value: string): boolean {
  const token = value.replace(/^[${%]+|[%}]+$/g, "").toUpperCase();
  if (PROVIDER_SECRET_NAMES.has(token)) return true;
  const segments = token.split(/[_./-]+/).filter(Boolean);
  if (segments.some((segment) => SECRET_IDENTIFIER_SEGMENTS.has(segment))) return true;
  return segments.length >= 2 && segments.at(-2) === "AUTH" && segments.at(-1) === "JSON";
}

function rejectProviderSecretIdentifier(value: string, path: string): void {
  const tokens = value.match(ENV_REFERENCE) ?? [value];
  for (const token of tokens) {
    if (isProviderSecretIdentifier(token)) {
      fail(path, "must not name a provider-secret identifier");
    }
  }
}

function parseSource(value: unknown, path: string): ConfigGraphSource {
  const input = objectAt(value, path, ["id", "kind", "ref"]);
  const kind = enumAt(input.kind, `${path}.kind`, GRAPH_SOURCE_KINDS);
  const ref = stringAt(input.ref, `${path}.ref`, {
    max: 240,
    pattern: kind === "builtin" ? BUILTIN_GRAPH : REPOSITORY_PATH,
  });
  return {
    id: stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER }),
    kind,
    ref,
  };
}

function parseRepositorySkill(value: unknown, path: string): ConfigRepositorySkill {
  const input = objectAt(value, path, ["id", "path", "tunable"]);
  const id = stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER });
  const skillPath = stringAt(input.path, `${path}.path`, { max: 240, pattern: REPOSITORY_DIR });
  const expectedPath = `.openthrottle/skills/${id}`;
  if (skillPath !== expectedPath) {
    fail(`${path}.path`, `must be exactly ${expectedPath}`);
  }
  return {
    id,
    path: skillPath,
    ...(input.tunable === undefined ? {} : { tunable: booleanAt(input.tunable, `${path}.tunable`) }),
  };
}

function parseStringList(value: unknown, path: string, max: number, entryMax = 1_000): string[] {
  return arrayAt(value, path, (entry, entryPath) => stringAt(entry, entryPath, { max: entryMax }), { max });
}

function parseLimits(value: unknown, path: string): ConfigLimits {
  const input = objectAt(value, path, ["max_turns", "task_timeout"]);
  return {
    ...(input.max_turns === undefined ? {} : { max_turns: integerAt(input.max_turns, `${path}.max_turns`, 1, 10_000) }),
    ...(input.task_timeout === undefined ? {} : { task_timeout: integerAt(input.task_timeout, `${path}.task_timeout`, 1, 86_400) }),
  };
}

function parseMcpServer(value: unknown, path: string): ConfigMcpServer {
  const input = objectAt(value, path, ["command", "args", "env", "url", "headers", "enabled"]);
  const hasCommand = input.command !== undefined;
  const hasUrl = input.url !== undefined;
  if (hasCommand === hasUrl) fail(path, "must define exactly one of command or url");
  const server: ConfigMcpServer = {
    ...(input.enabled === undefined ? {} : { enabled: booleanAt(input.enabled, `${path}.enabled`) }),
  };
  if (hasCommand) {
    server.command = stringAt(input.command, `${path}.command`, { max: 1_000 });
    server.args = input.args === undefined ? [] : parseStringList(input.args, `${path}.args`, 64);
    server.env = input.env === undefined
      ? {}
      : recordAt(input.env, `${path}.env`, (entry, entryPath, key) => {
        rejectProviderSecretIdentifier(key, entryPath);
        const value = stringAt(entry, entryPath, { max: 1_000 });
        rejectProviderSecretIdentifier(value, entryPath);
        return value;
      }, {
        max: 64,
        keyPattern: ENV_NAME,
      });
    if (input.headers !== undefined) fail(`${path}.headers`, "is valid only for a remote server");
  } else {
    const url = stringAt(input.url, `${path}.url`, { max: 2_000 });
    try {
      if (!/^https?:$/.test(new URL(url).protocol)) throw new Error("unsupported protocol");
    } catch {
      fail(`${path}.url`, "must be an absolute HTTP(S) URL");
    }
    server.url = url;
    server.headers = input.headers === undefined
      ? {}
      : recordAt(input.headers, `${path}.headers`, (entry, entryPath, key) => {
        rejectProviderSecretIdentifier(key, entryPath);
        const value = stringAt(entry, entryPath, { max: 1_000 });
        rejectProviderSecretIdentifier(value, entryPath);
        return value;
      }, { max: 64 });
    if (input.args !== undefined || input.env !== undefined) {
      fail(path, "args and env are valid only for a local server");
    }
  }
  return server;
}

function parsePipelineMap(value: unknown, path: string): Record<string, string> {
  return recordAt(value, path, (entry, entryPath) => stringAt(entry, entryPath, { pattern: PIPELINE_REFERENCE }), {
    max: 32,
    keyPattern: IDENTIFIER,
  });
}

function parseCommandMap(value: unknown, path: string): Record<string, string> {
  return recordAt(value, path, (entry, entryPath) => stringAt(entry, entryPath, { max: 4_000 }), {
    max: 32,
    keyPattern: COMMAND_NAME_PATTERN,
  });
}

function parseCommandAliases(input: Record<string, unknown>, source: string): {
  commands?: Record<string, string>;
  aliases: Partial<Record<CommandAliasName, string>>;
} {
  const commands = input.commands === undefined ? {} : parseCommandMap(input.commands, `${source}.commands`);
  const aliases: Partial<Record<CommandAliasName, string>> = {};
  for (const name of COMMAND_ALIAS_NAMES) {
    const alias = input[name] === undefined ? undefined : stringAt(input[name], `${source}.${name}`, { max: 4_000 });
    const command = commands[name];
    if (alias !== undefined && command !== undefined && alias !== command) {
      fail(`${source}.${name}`, `must match commands.${name}`);
    }
    const normalized = command ?? alias;
    if (normalized !== undefined) {
      commands[name] = normalized;
      aliases[name] = normalized;
    }
  }
  return {
    ...(Object.keys(commands).length === 0 ? {} : { commands }),
    aliases,
  };
}

function parseIntent(value: unknown, path: string): { default_graph: string; allowed_graphs: string[] } {
  const input = objectAt(value, path, ["default_graph", "allowed_graphs"]);
  return {
    default_graph: stringAt(input.default_graph, `${path}.default_graph`, { pattern: IDENTIFIER }),
    allowed_graphs: unique(arrayAt(input.allowed_graphs, `${path}.allowed_graphs`, (entry, entryPath) => {
      return stringAt(entry, entryPath, { pattern: IDENTIFIER });
    }, { min: 1, max: 16 }), `${path}.allowed_graphs`),
  };
}

function parseAgentDefault(value: unknown, path: string, agent: string): ConfigAgentDefault {
  const input = objectAt(value, path, ["model", "reasoning_effort"]);
  if (agent === "opencode" && input.reasoning_effort !== undefined) {
    fail(`${path}.reasoning_effort`, "is not supported for OpenCode");
  }
  return {
    ...(input.model === undefined ? {} : {
      model: stringAt(input.model, `${path}.model`, { max: 240, pattern: MODEL_REFERENCE }),
    }),
    ...(input.reasoning_effort === undefined ? {} : {
      reasoning_effort: enumAt(input.reasoning_effort, `${path}.reasoning_effort`, REASONING_EFFORTS),
    }),
  };
}

export function validateRepositoryConfigContract(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<RepositoryConfigContract> {
  const source = options.source ?? "config";
  const input = objectAt(value, source, [
    "schema", "default_graph", "graphs", "skills", "agent", "model", "agent_defaults", "commands", "test", "lint", "build", "dev", "format",
    "post_bootstrap", "limits", "mcp_servers", "pipelines", "intents",
  ]);
  if (input.schema !== CONFIG_SCHEMA) fail(`${source}.schema`, `must be ${CONFIG_SCHEMA}`);
  const commandAliases = parseCommandAliases(input, source);
  const config: RepositoryConfigContract = {
    schema: CONFIG_SCHEMA,
    default_graph: stringAt(input.default_graph, `${source}.default_graph`, { pattern: IDENTIFIER }),
    graphs: arrayAt(input.graphs, `${source}.graphs`, parseSource, { min: 1, max: 16 }),
    ...(input.skills === undefined ? {} : {
      skills: arrayAt(input.skills, `${source}.skills`, parseRepositorySkill, { max: 32 }),
    }),
    ...(input.agent === undefined ? {} : { agent: stringAt(input.agent, `${source}.agent`, { pattern: IDENTIFIER }) }),
    ...(input.model === undefined ? {} : { model: stringAt(input.model, `${source}.model`, { max: 240, pattern: MODEL_REFERENCE }) }),
    ...(input.agent_defaults === undefined ? {} : {
      agent_defaults: recordAt(input.agent_defaults, `${source}.agent_defaults`, parseAgentDefault, {
        max: CONFIG_AGENTS.length,
        keyPattern: /^(?:claude|codex|opencode)$/,
      }),
    }),
    ...(commandAliases.commands === undefined ? {} : { commands: commandAliases.commands }),
    ...(commandAliases.aliases.test === undefined ? {} : { test: commandAliases.aliases.test }),
    ...(commandAliases.aliases.lint === undefined ? {} : { lint: commandAliases.aliases.lint }),
    ...(commandAliases.aliases.build === undefined ? {} : { build: commandAliases.aliases.build }),
    ...(commandAliases.aliases.dev === undefined ? {} : { dev: commandAliases.aliases.dev }),
    ...(commandAliases.aliases.format === undefined ? {} : { format: commandAliases.aliases.format }),
    ...(input.post_bootstrap === undefined ? {} : { post_bootstrap: parseStringList(input.post_bootstrap, `${source}.post_bootstrap`, 32) }),
    ...(input.limits === undefined ? {} : { limits: parseLimits(input.limits, `${source}.limits`) }),
    ...(input.mcp_servers === undefined ? {} : {
      mcp_servers: recordAt(input.mcp_servers, `${source}.mcp_servers`, parseMcpServer, {
        max: 32,
        keyPattern: IDENTIFIER,
      }),
    }),
    ...(input.pipelines === undefined ? {} : { pipelines: parsePipelineMap(input.pipelines, `${source}.pipelines`) }),
    ...(input.intents === undefined ? {} : {
      intents: recordAt(input.intents, `${source}.intents`, parseIntent, {
        max: 16,
        keyPattern: IDENTIFIER,
      }),
    }),
  };
  unique(config.graphs.map((graph) => graph.id), `${source}.graphs`);
  unique((config.skills ?? []).map((skill) => skill.id), `${source}.skills`);
  const graphIds = new Set(config.graphs.map((graph) => graph.id));
  if (!graphIds.has(config.default_graph)) {
    fail(`${source}.default_graph`, "references an unknown graph");
  }
  for (const [intentName, intent] of Object.entries(config.intents ?? {})) {
    if (!graphIds.has(intent.default_graph)) fail(`${source}.intents.${intentName}.default_graph`, "references an unknown graph");
    for (const graphId of intent.allowed_graphs) {
      if (!graphIds.has(graphId)) fail(`${source}.intents.${intentName}.allowed_graphs`, "references an unknown graph");
    }
    if (!intent.allowed_graphs.includes(intent.default_graph)) {
      fail(`${source}.intents.${intentName}.default_graph`, "must be included in allowed_graphs");
    }
  }
  return normalizedContract(config);
}

export function parseRepositoryConfigContract(
  raw: string,
  options: { source?: string } = {}
): ValidatedContract<RepositoryConfigContract> {
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) fail(options.source ?? "config", "JSON exceeds 64 KiB");
  return validateRepositoryConfigContract(JSON.parse(raw) as unknown, options);
}
