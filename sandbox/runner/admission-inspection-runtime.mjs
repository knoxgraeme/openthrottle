const ADMISSION_INSPECTION_STAGES = new Set(["admission_planner", "admission_reviewer"]);
const ADMISSION_INSPECTION_CAPABILITIES = new Set([
  "admission/plan@1",
  "admission/review@1",
  "agent/repository-skill@1",
]);

const INSPECTION_MODEL_CREDENTIAL = Object.freeze({
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
  opencode: "KIMI_CODE_API_KEY",
});

export function isAdmissionInspectionStage(request) {
  return ADMISSION_INSPECTION_STAGES.has(request?.stageId) &&
    ADMISSION_INSPECTION_CAPABILITIES.has(request?.capability);
}

export function assertAdmissionInspectionRuntimeSupported(request) {
  if (isAdmissionInspectionStage(request) && request.agent === "codex") {
    throw new Error(
      "Codex automatic admission requires an OS-enforced contained read broker; no supported broker is installed"
    );
  }
}

export function inspectionProcessEnvironment(request, env = process.env) {
  if (!isAdmissionInspectionStage(request)) return env;
  assertAdmissionInspectionRuntimeSupported(request);
  const credential = INSPECTION_MODEL_CREDENTIAL[request.agent];
  if (!credential) throw new Error(`unsupported admission inspection agent ${request.agent}`);
  const result = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", credential]) {
    if (typeof env[name] === "string" && env[name]) result[name] = env[name];
  }
  return result;
}

export function inspectionAgentPolicyArgs(agent) {
  if (agent === "claude") {
    return [
      "--permission-mode", "dontAsk",
      "--allowedTools", "Read,Grep,Glob",
      "--disallowedTools", "Bash,Write,Edit,WebFetch,WebSearch,Task,NotebookEdit",
    ];
  }
  if (agent === "codex") {
    throw new Error(
      "Codex automatic admission requires an OS-enforced contained read broker; read-only sandboxing is insufficient"
    );
  }
  if (agent === "opencode") return [];
  throw new Error(`unsupported admission inspection agent ${agent}`);
}
