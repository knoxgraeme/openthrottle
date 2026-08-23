import { dirname, isAbsolute, normalize } from "node:path";

const CODEX_DISABLED_HOSTED_FEATURES = [
  "apps",
  "browser_use",
  "in_app_browser",
  "multi_agent",
  "plugins",
  "remote_plugin",
  "image_generation",
];

function codexPolicyArgs(sandbox, { ephemeral = true } = {}) {
  return [
    "--sandbox", sandbox,
    ...(ephemeral ? ["--ephemeral"] : []),
    "--ignore-user-config",
    "--ignore-rules",
    "-c", 'web_search="disabled"',
    ...CODEX_DISABLED_HOSTED_FEATURES.flatMap((feature) => ["--disable", feature]),
  ];
}

export function codexResultCorrectionPolicyArgs({ ephemeral = false } = {}) {
  return codexPolicyArgs("read-only", { ephemeral });
}

function claudeReadRule(repositoryPath) {
  if (typeof repositoryPath !== "string" || !isAbsolute(repositoryPath)) {
    throw new Error("Claude inspect authority requires an absolute repository path");
  }
  const root = normalize(repositoryPath);
  if (root === "/" || /[\0\r\n*?[\]\\()]/u.test(root)) {
    throw new Error("Claude inspect repository path cannot be safely scoped");
  }
  return `Read(//${root.slice(1)}/**)`;
}

function readableExecutorPaths(paths) {
  if (!Array.isArray(paths) || paths.length > 8) {
    throw new Error("inspect readable paths must be a bounded array");
  }
  const normalized = paths.map((path) => {
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new Error("inspect readable path must be absolute");
    }
    const value = normalize(path);
    if (value === "/" || /[\0\r\n*?[\]\\()]/u.test(value)) {
      throw new Error("inspect readable path cannot be safely scoped");
    }
    return value;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("inspect readable paths must not contain duplicates");
  }
  return normalized;
}

export function repositoryGitEnvironment(repositoryPath) {
  if (typeof repositoryPath !== "string" || !isAbsolute(repositoryPath)) {
    throw new Error("repository Git authority requires an absolute repository path");
  }
  const root = normalize(repositoryPath);
  if (root === "/" || /[\0\r\n*]/u.test(root)) {
    throw new Error("repository Git path cannot be safely scoped");
  }
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export function inspectPolicyArgs(engine, repositoryPath, {
  ephemeral = true,
  readablePaths = [],
} = {}) {
  const executorPaths = readableExecutorPaths(readablePaths);
  if (engine === "claude") {
    const allowedReads = [
      claudeReadRule(repositoryPath),
      ...executorPaths.map((path) => `Read(//${path.slice(1)})`),
    ];
    return [
      ...executorPaths.flatMap((path) => ["--add-dir", dirname(path)]),
      "--permission-mode", "dontAsk",
      "--tools", "Read,Grep,Glob",
      "--allowedTools", allowedReads.join(","),
      "--disallowedTools", "mcp__*",
    ];
  }
  if (engine === "codex") {
    return codexPolicyArgs("danger-full-access", { ephemeral });
  }
  if (engine === "opencode") return [];
  throw new Error(`unsupported inspect engine ${engine}`);
}
