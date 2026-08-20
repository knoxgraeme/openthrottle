import { isAbsolute, normalize } from "node:path";

const ADMISSION_INSPECTION_STAGES = new Set(["admission_planner", "admission_reviewer"]);
const ADMISSION_INSPECTION_CAPABILITIES = new Set([
  "admission/plan@1",
  "admission/review@1",
  "agent/repository-skill@1",
]);
const INSPECT_CAPABILITIES = new Set([
  ...ADMISSION_INSPECTION_CAPABILITIES,
  "ce/review@1",
]);

const INSPECTION_MODEL_CREDENTIAL = Object.freeze({
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
  opencode: "KIMI_CODE_API_KEY",
});

export function isAdmissionInspectionStage(request) {
  return ADMISSION_INSPECTION_STAGES.has(request?.stageId) &&
    ADMISSION_INSPECTION_CAPABILITIES.has(request?.capability);
}

export function repositoryAuthorityForRequest(request) {
  if (request?.repositoryAuthority === "inspect" || request?.repository_authority === "inspect") return "inspect";
  if (request?.repositoryAuthority === "edit" || request?.repository_authority === "edit") return "edit";
  return INSPECT_CAPABILITIES.has(request?.capability) ? "inspect" : "edit";
}

export function isInspectionAction(request) {
  return repositoryAuthorityForRequest(request) === "inspect";
}

export function assertAdmissionInspectionRuntimeSupported(request) {
  if (!isInspectionAction(request)) return;
  if (!Object.hasOwn(INSPECTION_MODEL_CREDENTIAL, request.agent) && request.agent !== "codex") {
    throw new Error(`unsupported admission inspection agent ${request.agent}`);
  }
}

export function inspectionProcessEnvironment(request, env = process.env) {
  if (!isInspectionAction(request)) return env;
  assertAdmissionInspectionRuntimeSupported(request);
  // Codex reads its credential from the action-scoped CODEX_HOME/auth.json.
  // Never expose the raw broker value through the child process environment.
  if (request.agent === "codex") {
    const result = {};
    for (const name of ["PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
      if (typeof env[name] === "string" && env[name]) result[name] = env[name];
    }
    return result;
  }
  const credential = INSPECTION_MODEL_CREDENTIAL[request.agent];
  if (!credential) throw new Error(`unsupported admission inspection agent ${request.agent}`);
  const result = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", credential]) {
    if (typeof env[name] === "string" && env[name]) result[name] = env[name];
  }
  return result;
}

function claudeInspectionReadRule(repositoryViewPath) {
  if (typeof repositoryViewPath !== "string" || !isAbsolute(repositoryViewPath)) {
    throw new Error("Claude admission inspection requires an absolute repository view path");
  }
  const root = normalize(repositoryViewPath);
  if (root === "/" || /[\0\r\n*?[\]\\()]/u.test(root)) {
    throw new Error("Claude admission inspection repository view path cannot be safely scoped");
  }
  return `Read(//${root.slice(1)}/**)`;
}

export function inspectionAgentPolicyArgs(agent, repositoryViewPath, { ephemeral = true } = {}) {
  if (agent === "claude") {
    return [
      "--permission-mode", "dontAsk",
      "--tools", "Read,Grep,Glob",
      "--allowedTools", claudeInspectionReadRule(repositoryViewPath),
      "--disallowedTools", "mcp__*",
    ];
  }
  if (agent === "codex") {
    return [
      "--sandbox", "read-only",
      ...(ephemeral ? ["--ephemeral"] : []),
      "--ignore-user-config",
      "--ignore-rules",
      "-c", 'web_search="disabled"',
    ];
  }
  if (agent === "opencode") return [];
  throw new Error(`unsupported admission inspection agent ${agent}`);
}
