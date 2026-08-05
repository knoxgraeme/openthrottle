import type { ArtifactKind, ContextPolicy } from "./manifest.js";

export const FOR_EACH_UNIT_CAPABILITY = "graph/for-each-unit@1";
export const REPOSITORY_SKILL_CAPABILITY = "agent/repository-skill@1";

export interface CapabilityCredentialContract {
  minimum: readonly string[];
  allowed: readonly string[];
  contexts: readonly ContextPolicy[];
  artifacts: readonly ArtifactKind[];
}

const CAPABILITY_CREDENTIALS: Readonly<Record<string, CapabilityCredentialContract>> = {
  "agent/semantic@1": {
    minimum: ["model.invoke", "repo.read"],
    allowed: ["model.invoke", "repo.read", "repo.write"],
    contexts: ["fresh", "resume_required", "prefer_resume"],
    artifacts: ["stage_result", "review"],
  },
  "ce/implement@1": {
    minimum: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    allowed: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    contexts: ["fresh", "resume_required", "prefer_resume"],
    artifacts: ["stage_result", "review"],
  },
  "ce/plan@1": {
    minimum: ["model.invoke", "repo.read"],
    allowed: ["model.invoke", "repo.read"],
    contexts: ["fresh", "resume_required", "prefer_resume"],
    artifacts: ["stage_result"],
  },
  "ce/publish@1": {
    minimum: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    allowed: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    contexts: ["resume_required", "prefer_resume"],
    artifacts: ["stage_result", "publish_subject"],
  },
  "ce/investigate@1": {
    minimum: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    allowed: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    contexts: ["fresh", "resume_required", "prefer_resume"],
    artifacts: ["stage_result", "review"],
  },
  "ce/review@1": {
    minimum: ["model.invoke", "repo.read"],
    allowed: ["model.invoke", "repo.read", "repo.write"],
    contexts: ["fresh", "resume_required", "prefer_resume"],
    artifacts: ["stage_result", "review"],
  },
  "ce/simplify@1": {
    minimum: ["model.invoke", "repo.read"],
    allowed: ["model.invoke", "repo.read", "repo.write"],
    contexts: ["resume_required", "prefer_resume"],
    artifacts: ["stage_result"],
  },
  [FOR_EACH_UNIT_CAPABILITY]: {
    minimum: ["repo.read", "repo.write"],
    allowed: ["repo.read", "repo.write", "provider.read"],
    contexts: ["none"],
    artifacts: ["stage_result", "execution_graph_result"],
  },
  [REPOSITORY_SKILL_CAPABILITY]: {
    minimum: ["model.invoke", "repo.read"],
    allowed: ["model.invoke", "provider.read", "repo.read", "repo.write", "mcp"],
    contexts: ["fresh", "resume_required", "prefer_resume"],
    artifacts: ["stage_result", "review"],
  },
  "command/run@1": {
    minimum: ["repo.read"],
    allowed: ["repo.read"],
    contexts: ["none"],
    artifacts: ["stage_result", "command_result"],
  },
  "loop-action@2": {
    minimum: ["model.invoke", "repo.read"],
    allowed: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    contexts: ["fresh", "resume_required", "prefer_resume"],
    artifacts: ["stage_result"],
  },
  "provider/wait@1": {
    minimum: ["provider.read"],
    allowed: ["provider.read"],
    contexts: ["none"],
    artifacts: ["stage_result", "provider_check"],
  },
};

export function capabilityCredentialContract(capability: string): CapabilityCredentialContract | undefined {
  return CAPABILITY_CREDENTIALS[capability];
}

export function capabilityRequiresCredential(capability: string, credential: string): boolean {
  return capabilityCredentialContract(capability)?.minimum.includes(credential) ?? false;
}
