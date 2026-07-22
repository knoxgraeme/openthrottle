#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const STAGE_EXECUTOR_PROTOCOL = "stage-executor@1";

export const CAPABILITY_CONTRACTS = Object.freeze({
  "agent/semantic@1": {
    kind: "agent",
    minimumCredentials: ["model.invoke", "repo.read"],
    allowedCredentials: ["model.invoke", "repo.read", "repo.write"],
    contexts: ["fresh", "resume_required", "prefer_resume", "fresh_review"],
    artifacts: ["stage_result", "review"],
  },
  "ce/implement@1": {
    kind: "agent",
    minimumCredentials: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    allowedCredentials: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    contexts: ["fresh", "resume_required", "prefer_resume", "fresh_review"],
    artifacts: ["stage_result", "review"],
  },
  "ce/plan@1": {
    kind: "agent",
    minimumCredentials: ["model.invoke", "repo.read"],
    allowedCredentials: ["model.invoke", "repo.read"],
    contexts: ["fresh", "resume_required", "prefer_resume", "fresh_review"],
    artifacts: ["stage_result"],
  },
  "ce/review@1": {
    kind: "agent",
    minimumCredentials: ["model.invoke", "repo.read"],
    allowedCredentials: ["model.invoke", "repo.read", "repo.write"],
    contexts: ["fresh", "resume_required", "prefer_resume", "fresh_review"],
    artifacts: ["stage_result", "review"],
  },
  "ce/simplify@1": {
    kind: "agent",
    minimumCredentials: ["model.invoke", "repo.read"],
    allowedCredentials: ["model.invoke", "repo.read", "repo.write"],
    contexts: ["resume_required", "prefer_resume"],
    artifacts: ["stage_result"],
  },
  "ce/publish@1": {
    kind: "agent",
    minimumCredentials: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    allowedCredentials: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    contexts: ["resume_required", "prefer_resume"],
    artifacts: ["stage_result", "publish_subject"],
  },
  "ce/investigate@1": {
    kind: "agent",
    minimumCredentials: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    allowedCredentials: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    contexts: ["fresh", "resume_required", "prefer_resume", "fresh_review"],
    artifacts: ["stage_result", "review"],
  },
  "command/run@1": {
    kind: "command",
    minimumCredentials: ["repo.read"],
    allowedCredentials: ["repo.read"],
    contexts: ["none"],
    artifacts: ["stage_result", "command_result"],
  },
  "provider/wait@1": {
    kind: "provider_wait",
    minimumCredentials: ["provider.read"],
    allowedCredentials: ["provider.read"],
    contexts: ["none"],
    artifacts: ["stage_result", "provider_check"],
  },
  "repository/publish@1": {
    kind: "publish",
    minimumCredentials: ["repo.read", "repo.write"],
    allowedCredentials: ["repo.read", "repo.write"],
    contexts: ["none"],
    artifacts: ["stage_result", "publish_subject"],
  },
});

export const RUNTIME_DESCRIPTOR = Object.freeze({
  schema: "openthrottle.runtime-capabilities/v1",
  release: "openthrottle-snapshot/v1",
  generatedBy: "sandbox-runtime-build",
  protocol: STAGE_EXECUTOR_PROTOCOL,
  capabilities: Object.keys(CAPABILITY_CONTRACTS).sort(),
  executors: ["agent", "command", "provider_wait", "publish"],
  evaluators: ["command", "human", "provider", "publish_subject", "result", "semantic"],
  artifacts: ["command_result", "human_approval", "provider_check", "publish_subject", "review", "stage_result"],
  contextPolicies: ["fresh", "fresh_review", "none", "prefer_resume", "resume_required"],
  credentialScopes: ["model.invoke", "provider.read", "repo.read", "repo.write"],
  adapters: {
    claude: "claude-jsonl@1",
    codex: "codex-jsonl@1",
    opencode: "opencode-jsonl@1",
  },
});

export function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function capabilityContract(capability) {
  const contract = CAPABILITY_CONTRACTS[capability];
  if (!contract) throw new Error(`unsupported installed capability: ${capability}`);
  return contract;
}

export function authorizeCapability({ capability, contextPolicy, credentialScopes, requiredArtifacts }) {
  const contract = capabilityContract(capability);
  if (!contract.contexts.includes(contextPolicy)) {
    throw new Error(`${capability} does not support context policy ${contextPolicy}`);
  }
  const scopes = [...new Set(credentialScopes)].sort();
  for (const minimum of contract.minimumCredentials) {
    if (!scopes.includes(minimum)) throw new Error(`${capability} requires credential scope ${minimum}`);
  }
  for (const scope of scopes) {
    if (!contract.allowedCredentials.includes(scope)) {
      throw new Error(`${capability} is not authorized for credential scope ${scope}`);
    }
  }
  for (const artifact of requiredArtifacts) {
    if (!contract.artifacts.includes(artifact)) {
      throw new Error(`${capability} cannot produce required artifact ${artifact}`);
    }
  }
  return contract;
}

function main() {
  const [command, path] = process.argv.slice(2);
  if (command === "--print") {
    process.stdout.write(`${canonicalJson(RUNTIME_DESCRIPTOR)}\n`);
    return;
  }
  if (command === "--verify" && path) {
    const expected = JSON.parse(readFileSync(resolve(path), "utf8"));
    if (canonicalJson(expected) !== canonicalJson(RUNTIME_DESCRIPTOR)) {
      throw new Error(`runtime descriptor ${path} does not match installed capabilities`);
    }
    return;
  }
  throw new Error("Usage: capabilities.mjs --print | --verify <descriptor.json>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`capabilities: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
