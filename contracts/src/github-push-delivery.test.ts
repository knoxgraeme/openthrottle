import { describe, expect, it } from "vitest";
import {
  GITHUB_PUSH_DELIVERY_SCHEMA,
  GITHUB_PUSH_REJECTION_REASONS,
  GITHUB_PUSH_REF_MODES,
  validateGithubPushDelivery,
  type GithubPushDelivery,
} from "./index.js";

const SHA = "a".repeat(40);
const EXPECTED_OLD_SUBJECT = "b".repeat(40);
const ACTUAL = "c".repeat(40);

function confirmed(refMode: "create" | "update" = "create"): GithubPushDelivery {
  return {
    schema: GITHUB_PUSH_DELIVERY_SCHEMA,
    repository: "owner/repo",
    ref: "refs/heads/ot/run-1/task",
    sha: SHA,
    ref_mode: refMode,
  };
}

describe("GitHub push delivery contract", () => {
  it.each(GITHUB_PUSH_REF_MODES)("accepts and normalizes a %s confirmation", (refMode) => {
    const input = confirmed(refMode);
    const validated = validateGithubPushDelivery(input);

    expect(validated.value).toEqual(input);
    expect(JSON.parse(validated.normalized)).toEqual(input);
  });

  it.each([
    ["ref_missing", null],
    ["publication_parent_missing", null],
    ["ref_conflict", ACTUAL],
  ] as const)("accepts %s rejection evidence", (reason, actual) => {
    const input: GithubPushDelivery = {
      ...confirmed("update"),
      expected_old_subject: EXPECTED_OLD_SUBJECT,
      actual,
      reason,
    };

    expect(validateGithubPushDelivery(input).value).toEqual(input);
  });

  it("normalizes equivalent inputs deterministically", () => {
    const canonical = {
      ...confirmed("update"),
      expected_old_subject: EXPECTED_OLD_SUBJECT,
      actual: ACTUAL,
      reason: "ref_conflict" as const,
    };
    const reordered = {
      reason: canonical.reason,
      actual: canonical.actual,
      ref_mode: canonical.ref_mode,
      sha: canonical.sha,
      ref: canonical.ref,
      repository: canonical.repository,
      expected_old_subject: canonical.expected_old_subject,
      schema: canonical.schema,
    };

    expect(validateGithubPushDelivery(reordered)).toEqual(validateGithubPushDelivery(canonical));
  });

  it.each([
    ["schema", { ...confirmed(), schema: "openthrottle.github-push-delivery/v2" }],
    ["repository", { ...confirmed(), repository: "owner" }],
    ["task ref namespace", { ...confirmed(), ref: "refs/heads/main" }],
    ["empty task ref suffix", { ...confirmed(), ref: "refs/heads/ot/" }],
    ["sha length", { ...confirmed(), sha: "a".repeat(39) }],
    ["uppercase sha", { ...confirmed(), sha: "A".repeat(40) }],
    ["ref mode", { ...confirmed(), ref_mode: "delete" }],
  ])("rejects an invalid %s", (_label, input) => {
    expect(() => validateGithubPushDelivery(input)).toThrow();
  });

  it.each([
    ["confirmed field", { ...confirmed(), extra: true }, /extra: unknown field/],
    ["rejected field", {
      ...confirmed(),
      expected_old_subject: EXPECTED_OLD_SUBJECT,
      actual: null,
      reason: "ref_missing",
      extra: true,
    }, /extra: unknown field/],
    ["confirmed sha", (({ sha: _sha, ...input }) => input)(confirmed()), /sha/],
    ["rejection reason", {
      ...confirmed(),
      expected_old_subject: EXPECTED_OLD_SUBJECT,
      actual: null,
      reason: "permission_denied",
    }, /reason.*must be one of/],
    ["rejection expected subject", {
      ...confirmed(),
      actual: null,
      reason: GITHUB_PUSH_REJECTION_REASONS[0],
    }, /expected_old_subject/],
    ["rejection actual", {
      ...confirmed(),
      expected_old_subject: EXPECTED_OLD_SUBJECT,
      reason: GITHUB_PUSH_REJECTION_REASONS[0],
    }, /actual/],
    ["rejection actual SHA", {
      ...confirmed(),
      expected_old_subject: EXPECTED_OLD_SUBJECT,
      actual: "D".repeat(40),
      reason: GITHUB_PUSH_REJECTION_REASONS[2],
    }, /actual.*invalid format/],
    ["rejected fields without discriminator", {
      ...confirmed(),
      expected_old_subject: EXPECTED_OLD_SUBJECT,
      actual: null,
    }, /expected_old_subject: unknown field/],
  ] as const)("rejects an unknown, missing, or malformed %s", (_label, input, error) => {
    expect(() => validateGithubPushDelivery(input)).toThrow(error);
  });
});
