import type { ArtifactKind, ContextPolicy } from "./manifest.js";

export const FOR_EACH_UNIT_CAPABILITY = "graph/for-each-unit@1";
export const REPOSITORY_SKILL_CAPABILITY = "agent/repository-skill@1";
export const ORDINARY_STAGE_BUILTIN_CAPABILITIES = [
  "agent/semantic@1",
  "ce/implement@1",
  "ce/plan@1",
  "ce/publish@1",
  "ce/investigate@1",
  "ce/review@1",
  "ce/simplify@1",
] as const;
export const ORDINARY_STAGE_INPUT_SCOPE: Readonly<Partial<Record<string, "graph" | "diff">>> = {
  "agent/semantic@1": "graph",
  "ce/implement@1": "graph",
  "ce/plan@1": "graph",
  "ce/publish@1": "graph",
  "ce/investigate@1": "graph",
  "ce/review@1": "diff",
  "ce/simplify@1": "diff",
  [REPOSITORY_SKILL_CAPABILITY]: "graph",
};
export const STRUCTURED_PHASE_BUILTIN_CAPABILITIES = {
  implement: "ce/implement@1",
  simplify: "ce/simplify@1",
  lead: "accept-unit@1",
} as const;

export interface CapabilityCredentialContract {
  minimum: readonly string[];
  allowed: readonly string[];
  contexts: readonly ContextPolicy[];
  artifacts: readonly ArtifactKind[];
}

export interface CapabilityCredentialContractInput {
  capability: string;
  context: ContextPolicy;
  credentials: readonly string[];
  requiredArtifacts?: readonly ArtifactKind[];
}

export interface CapabilityCredentialContractViolation {
  field: "context" | "credentials" | "artifacts";
  message: string;
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
    allowed: ["model.invoke", "mcp", "provider.read", "repo.read", "repo.write"],
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
  "accept-unit@1": {
    minimum: ["model.invoke", "repo.read"],
    allowed: ["model.invoke", "repo.read"],
    contexts: ["fresh", "resume_required", "prefer_resume"],
    artifacts: ["stage_result"],
  },
  [FOR_EACH_UNIT_CAPABILITY]: {
    minimum: ["repo.read"],
    allowed: ["repo.read", "provider.read"],
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

export function capabilityCredentialContractViolations({
  capability,
  context,
  credentials,
  requiredArtifacts = [],
}: CapabilityCredentialContractInput): CapabilityCredentialContractViolation[] {
  const contract = capabilityCredentialContract(capability);
  if (!contract) return [];
  const violations: CapabilityCredentialContractViolation[] = [];
  if (!contract.contexts.includes(context)) {
    violations.push({ field: "context", message: `${capability} does not support context policy ${context}` });
  }
  for (const credential of contract.minimum) {
    if (!credentials.includes(credential)) {
      violations.push({ field: "credentials", message: `${capability} requires credential scope ${credential}` });
    }
  }
  for (const credential of credentials) {
    if (!contract.allowed.includes(credential)) {
      violations.push({ field: "credentials", message: `${capability} is not authorized for credential scope ${credential}` });
    }
  }
  for (const artifact of requiredArtifacts) {
    if (!contract.artifacts.includes(artifact)) {
      violations.push({ field: "artifacts", message: `${capability} cannot produce required artifact ${artifact}` });
    }
  }
  return violations;
}

export function capabilityRequiresCredential(capability: string, credential: string): boolean {
  return capabilityCredentialContract(capability)?.minimum.includes(credential) ?? false;
}
