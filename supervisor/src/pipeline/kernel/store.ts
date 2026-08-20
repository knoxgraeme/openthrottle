import { digestCanonicalJson } from "@openthrottle/contracts";
import type {
  AtomicTransitionBundle,
  AtomicTransitionBundleContent,
} from "./types.js";

export interface AtomicTransitionObservedState {
  run_id: string;
  run_version: number;
  cursor_version: number;
  attempt_versions: Readonly<Record<string, number>>;
}

export interface StoredTransitionIdentity {
  transition_id: string;
  content_hash: string;
}

export type TransitionApplicationDisposition = "apply" | "replay";

export type AtomicTransitionApplyResult =
  | { disposition: "applied"; run_version: number }
  | { disposition: "replayed"; run_version: number };

export interface AtomicTransitionStore {
  applyTransition(bundle: AtomicTransitionBundle): Promise<AtomicTransitionApplyResult>;
}

export function atomicTransitionContent(
  bundle: AtomicTransitionBundle,
): AtomicTransitionBundleContent {
  const { content_hash: _contentHash, ...content } = bundle;
  return content;
}

export function assertAtomicTransitionIntegrity(bundle: AtomicTransitionBundle): void {
  const actual = digestCanonicalJson(atomicTransitionContent(bundle));
  if (actual !== bundle.content_hash) {
    throw new Error(`atomic transition ${bundle.transition_id} content hash mismatch`);
  }
  if (bundle.run.id !== bundle.expected.run_id) {
    throw new Error(`atomic transition ${bundle.transition_id} writes another pipeline run`);
  }
  if (bundle.run.version !== bundle.expected.run_version + 1) {
    throw new Error(`atomic transition ${bundle.transition_id} must advance the run version exactly once`);
  }
  if (
    bundle.run.cursor.version !== bundle.expected.cursor_version &&
    bundle.run.cursor.version !== bundle.expected.cursor_version + 1
  ) {
    throw new Error(`atomic transition ${bundle.transition_id} has an invalid cursor version advance`);
  }
  const writtenAttemptIds = bundle.attempt_writes.map((write) =>
    write.kind === "replace" ? write.attempt.id : write.attempt_id).sort();
  const expectedAttemptIds = Object.keys(bundle.expected.attempt_versions).sort();
  if (JSON.stringify(writtenAttemptIds) !== JSON.stringify(expectedAttemptIds)) {
    throw new Error(`atomic transition ${bundle.transition_id} attempt writes do not match its fences`);
  }
  for (const write of bundle.attempt_writes) {
    const attemptId = write.kind === "replace" ? write.attempt.id : write.attempt_id;
    const nextVersion = write.kind === "replace" ? write.attempt.version : write.next_version;
    if (nextVersion !== bundle.expected.attempt_versions[attemptId]! + 1) {
      throw new Error(`atomic transition ${bundle.transition_id} has an invalid attempt version advance`);
    }
  }
  const createdAttemptIds = bundle.create_attempts.map((attempt) => attempt.id);
  if (
    new Set(createdAttemptIds).size !== createdAttemptIds.length ||
    bundle.create_attempts.some((attempt) => attempt.version !== 0)
  ) {
    throw new Error(`atomic transition ${bundle.transition_id} creates invalid attempt identities`);
  }
  const effectIds = bundle.put_effects.map((effect) => effect.id);
  const idempotencyKeys = bundle.put_effects.map((effect) => effect.idempotency_key);
  if (
    new Set(effectIds).size !== effectIds.length ||
    new Set(idempotencyKeys).size !== idempotencyKeys.length
  ) {
    throw new Error(`atomic transition ${bundle.transition_id} creates conflicting effects`);
  }
}

export function transitionApplicationDisposition(input: {
  bundle: AtomicTransitionBundle;
  observed: AtomicTransitionObservedState;
  existing?: StoredTransitionIdentity;
}): TransitionApplicationDisposition {
  assertAtomicTransitionIntegrity(input.bundle);
  if (input.existing) {
    if (input.existing.transition_id !== input.bundle.transition_id) {
      throw new Error("stored transition identity does not match the requested replay");
    }
    if (input.existing.content_hash !== input.bundle.content_hash) {
      throw new Error(`atomic transition ${input.bundle.transition_id} conflicts with its immutable replay`);
    }
    return "replay";
  }

  const expected = input.bundle.expected;
  if (input.observed.run_id !== expected.run_id) {
    throw new Error("atomic transition targets another pipeline run");
  }
  if (
    input.observed.run_version !== expected.run_version ||
    input.observed.cursor_version !== expected.cursor_version
  ) {
    throw new Error(`atomic transition ${input.bundle.transition_id} has a stale run or cursor version`);
  }
  for (const [attemptId, expectedVersion] of Object.entries(expected.attempt_versions)) {
    if (input.observed.attempt_versions[attemptId] !== expectedVersion) {
      throw new Error(
        `atomic transition ${input.bundle.transition_id} has a stale attempt version for ${attemptId}`,
      );
    }
  }
  return "apply";
}
