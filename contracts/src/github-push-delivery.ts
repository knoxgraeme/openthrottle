import {
  enumAt,
  fail,
  normalizedContract,
  nullable,
  objectAt,
  stringAt,
  type ValidatedContract,
} from "./validation.js";

export const GITHUB_PUSH_DELIVERY_SCHEMA = "openthrottle.github-push-delivery/v1" as const;
export const GITHUB_PUSH_REF_MODES = Object.freeze(["create", "update"] as const);
export const GITHUB_PUSH_REJECTION_REASONS = Object.freeze([
  "ref_missing",
  "publication_parent_missing",
  "ref_conflict",
] as const);

const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_TASK_REF = /^refs\/heads\/ot\/[A-Za-z0-9._/-]{1,180}$/;
const GITHUB_COMMIT_SHA = /^[a-f0-9]{40}$/;

export type GithubPushRefMode = typeof GITHUB_PUSH_REF_MODES[number];
export type GithubPushRejectionReason = typeof GITHUB_PUSH_REJECTION_REASONS[number];

interface GithubPushDeliveryCommon {
  schema: typeof GITHUB_PUSH_DELIVERY_SCHEMA;
  repository: string;
  ref: string;
  sha: string;
  ref_mode: GithubPushRefMode;
}

export interface ConfirmedGithubPushDelivery extends GithubPushDeliveryCommon {}

export interface RejectedGithubPushDelivery extends GithubPushDeliveryCommon {
  expected_old_subject: string;
  actual: string | null;
  reason: GithubPushRejectionReason;
}

export type GithubPushDelivery = ConfirmedGithubPushDelivery | RejectedGithubPushDelivery;

function githubCommitSha(value: unknown, path: string): string {
  return stringAt(value, path, { pattern: GITHUB_COMMIT_SHA });
}

export function validateGithubPushDelivery(
  value: unknown,
  options: { source?: string } = {},
): ValidatedContract<GithubPushDelivery> {
  const source = options.source ?? "github_push_delivery";
  const candidate = objectAt(value, source, [
    "schema",
    "repository",
    "ref",
    "sha",
    "ref_mode",
    "expected_old_subject",
    "actual",
    "reason",
  ]);
  if (candidate.schema !== GITHUB_PUSH_DELIVERY_SCHEMA) {
    fail(`${source}.schema`, `must be ${GITHUB_PUSH_DELIVERY_SCHEMA}`);
  }
  const common: GithubPushDeliveryCommon = {
    schema: GITHUB_PUSH_DELIVERY_SCHEMA,
    repository: stringAt(candidate.repository, `${source}.repository`, {
      pattern: GITHUB_REPOSITORY,
    }),
    ref: stringAt(candidate.ref, `${source}.ref`, { pattern: GITHUB_TASK_REF }),
    sha: githubCommitSha(candidate.sha, `${source}.sha`),
    ref_mode: enumAt(candidate.ref_mode, `${source}.ref_mode`, GITHUB_PUSH_REF_MODES),
  };

  if (!("reason" in candidate)) {
    objectAt(value, source, ["schema", "repository", "ref", "sha", "ref_mode"]);
    return normalizedContract(common);
  }

  return normalizedContract({
    ...common,
    expected_old_subject: githubCommitSha(
      candidate.expected_old_subject,
      `${source}.expected_old_subject`,
    ),
    actual: nullable(candidate.actual, (entry) =>
      githubCommitSha(entry, `${source}.actual`)),
    reason: enumAt(candidate.reason, `${source}.reason`, GITHUB_PUSH_REJECTION_REASONS),
  });
}
