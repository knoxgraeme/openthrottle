import { describe, expect, it } from "vitest";
import {
  GITHUB_PUSH_DELIVERY_SCHEMA,
  validateGithubPushDelivery,
  type GithubPushDelivery,
} from "./index.js";

const OLD_SUBJECT = "a".repeat(40);
const NEW_SUBJECT = "b".repeat(40);
const ACTUAL_SUBJECT = "c".repeat(40);

function confirmed(refMode: "create" | "update" = "create"): GithubPushDelivery {
  return {
    schema: GITHUB_PUSH_DELIVERY_SCHEMA,
    repository: "owner/repo",
    ref: "refs/heads/ot/ope-209-contract",
    sha: NEW_SUBJECT,
    ref_mode: refMode,
  };
}

describe("GitHub push delivery contract", () => {
  it.each(["create", "update"] as const)("accepts confirmed %s-mode evidence", (refMode) => {
    const evidence = confirmed(refMode);
    expect(validateGithubPushDelivery(evidence).value).toEqual(evidence);
  });

  it.each([
    ["publication parent missing", {
      ...confirmed("create"),
      expected_old_subject: OLD_SUBJECT,
      actual: null,
      reason: "publication_parent_missing",
    }],
    ["task ref missing", {
      ...confirmed("update"),
      expected_old_subject: OLD_SUBJECT,
      actual: null,
      reason: "ref_missing",
    }],
    ["create ref conflict", {
      ...confirmed("create"),
      expected_old_subject: OLD_SUBJECT,
      actual: ACTUAL_SUBJECT,
      reason: "ref_conflict",
    }],
    ["update ref conflict", {
      ...confirmed("update"),
      expected_old_subject: OLD_SUBJECT,
      actual: ACTUAL_SUBJECT,
      reason: "ref_conflict",
    }],
  ] as const)("accepts rejected evidence for %s", (_label, evidence) => {
    expect(validateGithubPushDelivery(evidence).value).toEqual(evidence);
  });

  it.each([
    ["wrong schema", { ...confirmed(), schema: "openthrottle.github-push-delivery/v2" }],
    ["repository without owner", { ...confirmed(), repository: "repo" }],
    ["repository with extra path", { ...confirmed(), repository: "owner/repo/extra" }],
    ["non-task ref", { ...confirmed(), ref: "refs/heads/main" }],
    ["empty task-ref suffix", { ...confirmed(), ref: "refs/heads/ot/" }],
    ["oversized task-ref suffix", { ...confirmed(), ref: `refs/heads/ot/${"x".repeat(181)}` }],
    ["short subject", { ...confirmed(), sha: "a".repeat(39) }],
    ["uppercase subject", { ...confirmed(), sha: "A".repeat(40) }],
    ["unsupported ref mode", { ...confirmed(), ref_mode: "force" }],
    ["missing required field", (({ sha: _sha, ...rest }) => rest)(confirmed())],
    ["unknown field", { ...confirmed(), provider: "github" }],
  ])("rejects %s", (_label, evidence) => {
    expect(() => validateGithubPushDelivery(evidence)).toThrow();
  });

  it.each([
    ["partial rejection", { ...confirmed(), reason: "ref_missing" }],
    ["unknown reason", {
      ...confirmed("update"), expected_old_subject: OLD_SUBJECT, actual: null, reason: "unknown",
    }],
    ["invalid old subject", {
      ...confirmed("update"), expected_old_subject: "a".repeat(41), actual: null, reason: "ref_missing",
    }],
    ["create-mode missing ref", {
      ...confirmed("create"), expected_old_subject: OLD_SUBJECT, actual: null, reason: "ref_missing",
    }],
    ["update-mode missing publication parent", {
      ...confirmed("update"),
      expected_old_subject: OLD_SUBJECT,
      actual: null,
      reason: "publication_parent_missing",
    }],
    ["missing ref with an actual subject", {
      ...confirmed("update"),
      expected_old_subject: OLD_SUBJECT,
      actual: ACTUAL_SUBJECT,
      reason: "ref_missing",
    }],
    ["conflict without an actual subject", {
      ...confirmed("update"), expected_old_subject: OLD_SUBJECT, actual: null, reason: "ref_conflict",
    }],
    ["conflict with a malformed actual subject", {
      ...confirmed("update"),
      expected_old_subject: OLD_SUBJECT,
      actual: "c".repeat(39),
      reason: "ref_conflict",
    }],
    ["conflict already at the new subject", {
      ...confirmed("update"),
      expected_old_subject: OLD_SUBJECT,
      actual: NEW_SUBJECT,
      reason: "ref_conflict",
    }],
    ["update still at the old subject", {
      ...confirmed("update"),
      expected_old_subject: OLD_SUBJECT,
      actual: OLD_SUBJECT,
      reason: "ref_conflict",
    }],
  ])("rejects invalid rejection details for %s", (_label, evidence) => {
    expect(() => validateGithubPushDelivery(evidence)).toThrow();
  });

  it("reports a caller-provided validation source", () => {
    expect(() => validateGithubPushDelivery(
      { ...confirmed(), repository: "invalid" },
      { source: "delivery.result" },
    )).toThrow(/^delivery\.result\.repository:/);
  });
});
