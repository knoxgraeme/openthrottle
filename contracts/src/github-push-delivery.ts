import {
  enumAt,
  fail,
  normalizedContract,
  objectAt,
  stringAt,
  type ValidatedContract,
} from "./validation.js";

export const GITHUB_PUSH_DELIVERY_SCHEMA = "openthrottle.github-push-delivery/v1" as const;

const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_TASK_REF = /^refs\/heads\/ot\/[A-Za-z0-9._/-]{1,180}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const REF_MODES = ["create", "update"] as const;
const REJECTION_REASONS = [
  "publication_parent_missing",
  "ref_missing",
  "ref_conflict",
] as const;

interface GithubPushDeliveryBase {
  schema: typeof GITHUB_PUSH_DELIVERY_SCHEMA;
  repository: string;
  ref: string;
  sha: string;
  ref_mode: (typeof REF_MODES)[number];
}

interface ConfirmedGithubPushDelivery extends GithubPushDeliveryBase {
  expected_old_subject?: never;
  actual?: never;
  reason?: never;
}

interface PublicationParentMissingGithubPushDelivery extends GithubPushDeliveryBase {
  ref_mode: "create";
  expected_old_subject: string;
  actual: null;
  reason: "publication_parent_missing";
}

interface MissingRefGithubPushDelivery extends GithubPushDeliveryBase {
  ref_mode: "update";
  expected_old_subject: string;
  actual: null;
  reason: "ref_missing";
}

interface ConflictingRefGithubPushDelivery extends GithubPushDeliveryBase {
  expected_old_subject: string;
  actual: string;
  reason: "ref_conflict";
}

export type GithubPushDelivery =
  | ConfirmedGithubPushDelivery
  | PublicationParentMissingGithubPushDelivery
  | MissingRefGithubPushDelivery
  | ConflictingRefGithubPushDelivery;

function gitSha(value: unknown, path: string): string {
  return stringAt(value, path, { max: 40, pattern: GIT_SHA });
}

export function validateGithubPushDelivery(
  value: unknown,
  options: { source?: string } = {},
): ValidatedContract<GithubPushDelivery> {
  const source = options.source ?? "github_push_delivery";
  const input = objectAt(value, source, [
    "schema",
    "repository",
    "ref",
    "sha",
    "ref_mode",
    "expected_old_subject",
    "actual",
    "reason",
  ]);
  if (input.schema !== GITHUB_PUSH_DELIVERY_SCHEMA) {
    fail(`${source}.schema`, `must be ${GITHUB_PUSH_DELIVERY_SCHEMA}`);
  }
  const base: GithubPushDeliveryBase = {
    schema: GITHUB_PUSH_DELIVERY_SCHEMA,
    repository: stringAt(input.repository, `${source}.repository`, {
      max: 512,
      pattern: GITHUB_REPOSITORY,
    }),
    ref: stringAt(input.ref, `${source}.ref`, { max: 194, pattern: GITHUB_TASK_REF }),
    sha: gitSha(input.sha, `${source}.sha`),
    ref_mode: enumAt(input.ref_mode, `${source}.ref_mode`, REF_MODES),
  };
  const hasRejectionDetails = ["expected_old_subject", "actual", "reason"]
    .some((field) => Object.hasOwn(input, field));
  if (!hasRejectionDetails) return normalizedContract(base);

  const expectedOldSubject = gitSha(
    input.expected_old_subject,
    `${source}.expected_old_subject`,
  );
  const reason = enumAt(input.reason, `${source}.reason`, REJECTION_REASONS);
  if (reason === "publication_parent_missing") {
    if (base.ref_mode !== "create") {
      fail(`${source}.ref_mode`, "must be create when publication parent is missing");
    }
    if (input.actual !== null) {
      fail(`${source}.actual`, "must be null when publication parent is missing");
    }
    return normalizedContract({
      ...base,
      ref_mode: "create",
      expected_old_subject: expectedOldSubject,
      actual: null,
      reason,
    });
  }
  if (reason === "ref_missing") {
    if (base.ref_mode !== "update") {
      fail(`${source}.ref_mode`, "must be update when the task ref is missing");
    }
    if (input.actual !== null) {
      fail(`${source}.actual`, "must be null when the task ref is missing");
    }
    return normalizedContract({
      ...base,
      ref_mode: "update",
      expected_old_subject: expectedOldSubject,
      actual: null,
      reason,
    });
  }

  const actual = gitSha(input.actual, `${source}.actual`);
  if (actual === base.sha) {
    fail(`${source}.actual`, "must differ from the expected published subject");
  }
  if (base.ref_mode === "update" && actual === expectedOldSubject) {
    fail(`${source}.actual`, "must differ from the expected publication parent in update mode");
  }
  return normalizedContract({
    ...base,
    expected_old_subject: expectedOldSubject,
    actual,
    reason,
  });
}
