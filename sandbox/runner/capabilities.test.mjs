import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  RUNTIME_DESCRIPTOR,
  REVIEW_PERSONA_CAPABILITIES,
  authorizeCapability,
  canonicalJson,
  capabilityContract,
} from "./capabilities.mjs";

describe("installed stage capabilities", () => {
  it("advertises a deterministic inventory independent of pipeline manifests", () => {
    expect(RUNTIME_DESCRIPTOR.protocol).toBe("stage-executor@1");
    expect(RUNTIME_DESCRIPTOR.capabilities).toEqual([...RUNTIME_DESCRIPTOR.capabilities].sort());
    expect(canonicalJson(RUNTIME_DESCRIPTOR)).not.toContain("ce-implement-v1.yaml");
    expect(RUNTIME_DESCRIPTOR.capabilities).not.toContain("repository/publish@1");
    expect(RUNTIME_DESCRIPTOR.executors).not.toContain("publish");
    expect(RUNTIME_DESCRIPTOR.capabilities).toContain("loop-action@2");
    expect(RUNTIME_DESCRIPTOR.capabilities).toEqual(expect.arrayContaining(REVIEW_PERSONA_CAPABILITIES));
    expect(RUNTIME_DESCRIPTOR.executors).toContain("loop_action");
    expect(capabilityContract("command/run@1").kind).toBe("command");
    const supervisorDescriptor = JSON.parse(readFileSync(
      new URL("../../supervisor/pipelines/runtime-capabilities-v1.json", import.meta.url),
      "utf8"
    ));
    expect(canonicalJson(supervisorDescriptor)).toBe(canonicalJson(RUNTIME_DESCRIPTOR));
  });

  it("enforces minimum and maximum logical credential scopes", () => {
    expect(() => authorizeCapability({
      capability: "ce/implement@1",
      contextPolicy: "prefer_resume",
      credentialScopes: ["model.invoke", "repo.read", "repo.write"],
      requiredArtifacts: ["stage_result"],
    })).toThrow(/requires credential scope provider.read/);
    expect(() => authorizeCapability({
      capability: "command/run@1",
      contextPolicy: "none",
      credentialScopes: ["repo.read", "repo.write"],
      requiredArtifacts: ["stage_result", "command_result"],
    })).toThrow(/not authorized.*repo.write/);
    expect(authorizeCapability({
      capability: "command/run@1",
      contextPolicy: "none",
      credentialScopes: ["repo.read"],
      requiredArtifacts: ["stage_result", "command_result"],
    }).kind).toBe("command");
    expect(authorizeCapability({
      capability: "ce/investigate@1",
      contextPolicy: "prefer_resume",
      credentialScopes: ["model.invoke", "provider.read", "repo.read", "repo.write"],
      requiredArtifacts: ["stage_result", "review"],
    }).kind).toBe("agent");
    expect(authorizeCapability({
      capability: "ce/plan@1",
      contextPolicy: "fresh",
      credentialScopes: ["model.invoke", "repo.read"],
      requiredArtifacts: ["stage_result"],
    }).kind).toBe("agent");
    expect(authorizeCapability({
      capability: "loop-action@2",
      contextPolicy: "prefer_resume",
      credentialScopes: ["model.invoke", "repo.read", "repo.write"],
      requiredArtifacts: ["stage_result"],
    }).kind).toBe("loop_action");
    for (const capability of REVIEW_PERSONA_CAPABILITIES) {
      expect(authorizeCapability({
        capability,
        contextPolicy: "fresh",
        credentialScopes: ["model.invoke", "repo.read"],
        requiredArtifacts: ["stage_result"],
      }).kind).toBe("agent");
      expect(() => authorizeCapability({
        capability,
        contextPolicy: "fresh",
        credentialScopes: ["model.invoke", "repo.read", "repo.write"],
        requiredArtifacts: ["stage_result"],
      })).toThrow(/not authorized.*repo.write/);
    }
  });

  it("rejects unknown capabilities, contexts, and artifacts", () => {
    expect(() => capabilityContract("unknown/run@1")).toThrow(/unsupported installed capability/);
    expect(() => authorizeCapability({
      capability: "command/run@1",
      contextPolicy: "fresh",
      credentialScopes: ["repo.read"],
      requiredArtifacts: ["stage_result"],
    })).toThrow(/does not support context policy/);
    expect(() => authorizeCapability({
      capability: "command/run@1",
      contextPolicy: "none",
      credentialScopes: ["repo.read"],
      requiredArtifacts: ["review"],
    })).toThrow(/cannot produce required artifact/);
  });
});
