import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  digestCanonicalJson,
  type AttemptCheckpoint,
  type DeliveryRecord,
  type ExecutionRecord,
} from "@openthrottle/contracts";
import { KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES } from "../runtime/kernel-wire.js";
import { createKernelExternalPlanBindings } from "./kernel-plan-bindings.js";

const directories: string[] = [];
const NOW = "2026-08-22T12:00:00.000Z";

function git(repository: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: repository, encoding: "utf8" }).trim();
}

function pointer(bytes: Buffer) {
  return {
    algorithm: "sha256" as const,
    digest: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    encoding: "binary" as const,
    media_type: "application/x-git-bundle",
    payload_schema: "openthrottle.git-checkpoint-bundle/v1",
  };
}

function writeBundle(input: {
  repository: string;
  root: string;
  ref: string;
  commit: string;
  boundary: string;
  name: string;
}) {
  git(input.repository, ["update-ref", input.ref, input.commit]);
  writeFileSync(join(input.repository, ".git", "shallow"), `${input.boundary}\n`);
  const path = join(input.root, input.name);
  git(input.repository, ["bundle", "create", path, input.ref]);
  const bytes = readFileSync(path);
  return { bytes, pointer: pointer(bytes) };
}

function taskRef(): string {
  return `refs/heads/ot/ope-201-${digestCanonicalJson({ run_id: "run-1" }).slice(0, 12)}`;
}

function runtimeDelivery(): ExecutionRecord {
  return {
    schema: "openthrottle.record/v1",
    kind: "delivery",
    id: "delivery-runtime",
    pipeline_run_id: "run-1",
    effect_id: "effect-runtime",
    idempotency_key: "run-1:runtime",
    external_identity: `daytona:${"d".repeat(64)}`,
    status: "confirmed",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: { inline: {
      effect_kind: "daytona/create-sandbox@1",
      provider: "daytona",
      result: { identity: "d".repeat(64) },
    } },
    created_at: NOW,
  };
}

function pushDelivery(
  id: string,
  sha: string,
  refMode: "create" | "update",
  target: { repository: string; ref: string } = {
    repository: "owner/repo",
    ref: taskRef(),
  },
): DeliveryRecord {
  const { repository, ref } = target;
  return {
    schema: "openthrottle.record/v1",
    id,
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: `effect-${id}`,
    idempotency_key: `run-1:${id}`,
    external_identity: `github:${repository}:${ref}`,
    status: "confirmed",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: { inline: {
      effect_kind: "github/push-checkpoint@1",
      provider: "github",
      result: {
        schema: "openthrottle.github-push-delivery/v1",
        repository,
        ref,
        sha,
        ref_mode: refMode,
      },
    } },
    created_at: NOW,
  };
}

function integrationDelivery(input: {
  id: string;
  parent: string;
  output: string;
  checkpointId: string;
  checkpointPointer: ReturnType<typeof pointer>;
}): DeliveryRecord {
  return {
    schema: "openthrottle.record/v1",
    id: input.id,
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: `effect-${input.id}`,
    idempotency_key: `run-1:${input.id}`,
    external_identity: `daytona:${"d".repeat(64)}:publication`,
    status: "confirmed",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: { inline: {
      effect_kind: "daytona/integrate-checkpoint@1",
      provider: "daytona",
      result: {
        schema: "openthrottle.daytona-integration-delivery/v1",
        state: "integrated",
        input_subject: input.parent,
        output_subject: input.output,
        checkpoint_id: input.checkpointId,
        checkpoint_payload_schema: "openthrottle.git-checkpoint-bundle/v1",
        checkpoint_blob: input.checkpointPointer,
      },
    } },
    created_at: NOW,
  };
}

function rejectedDelivery(input: {
  id: string;
  effectKind: string;
  provider: string;
  result: Record<string, string>;
}): DeliveryRecord {
  return {
    schema: "openthrottle.record/v1",
    id: input.id,
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: `effect-${input.id}`,
    idempotency_key: `run-1:${input.id}`,
    external_identity: `${input.provider}:rejected`,
    status: "rejected",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: { inline: {
      effect_kind: input.effectKind,
      provider: input.provider,
      result: input.result,
    } },
    created_at: NOW,
  };
}

async function evaluateRejected(
  externalKind: "core/publish@1" | "core/integrate-unit@1",
  delivery: DeliveryRecord,
  intentKind = "daytona/integrate-checkpoint@1",
) {
  const bindings = createKernelExternalPlanBindings({
    environments: {} as never,
    blob_store: {} as never,
  });
  const binding = bindings.find(({ external_kind }) => external_kind === externalKind)!;
  return binding.evaluate({
    run: {} as never,
    attempt: {} as never,
    stage: {} as never,
    prepared: {} as never,
    schedules: [{ effects: [{ intent: { kind: intentKind }, delivery }] }] as never,
  });
}

function integrationBudgetFixture() {
  const root = mkdtempSync(join(tmpdir(), "ot-kernel-integration-budget-"));
  directories.push(root);
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git(work, ["config", "user.name", "Test"]);
  git(work, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(work, "file.txt"), "source\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-qm", "source"]);
  const source = git(work, ["rev-parse", "HEAD"]);
  writeFileSync(join(work, "file.txt"), "private candidate\n");
  git(work, ["commit", "-qam", "private candidate"]);
  const candidateSubject = git(work, ["rev-parse", "HEAD"]);
  const candidateTree = git(work, ["rev-parse", "HEAD^{tree}"]);
  const candidateRequestHash = "9".repeat(64);
  const candidateBundle = writeBundle({
    repository: work,
    root,
    ref: `refs/openthrottle/checkpoints/${candidateRequestHash}`,
    commit: candidateSubject,
    boundary: source,
    name: "candidate.bundle",
  });
  const currentSubject = git(work, [
    "commit-tree", candidateTree, "-p", source, "-m", "OpenThrottle integrated checkpoint",
  ]);
  const proofBundle = writeBundle({
    repository: work,
    root,
    ref: `refs/openthrottle/integrations/${"8".repeat(64)}`,
    commit: currentSubject,
    boundary: source,
    name: "proof.bundle",
  });
  const candidate: AttemptCheckpoint = {
    schema: "openthrottle.attempt-checkpoint/v1",
    id: "checkpoint-budget-candidate",
    pipeline_run_id: "run-1",
    attempt_id: "attempt-budget-candidate",
    request_hash: candidateRequestHash,
    definition_bundle_hash: "b".repeat(64),
    input_subject: source,
    output_subject: candidateSubject,
    native_session_id: "session-budget-candidate",
    payload_schema: "openthrottle.git-checkpoint-bundle/v1",
    payload: { blob: candidateBundle.pointer },
    captured_at: NOW,
  };
  const proof: AttemptCheckpoint = {
    ...candidate,
    id: "checkpoint-budget-proof",
    attempt_id: "attempt-budget-proof",
    request_hash: "8".repeat(64),
    input_subject: source,
    output_subject: currentSubject,
    native_session_id: null,
    payload: { blob: proofBundle.pointer },
  };
  return {
    source,
    currentSubject,
    candidate,
    proof,
    bytesByDigest: new Map([
      [candidateBundle.pointer.digest, candidateBundle.bytes],
      [proofBundle.pointer.digest, proofBundle.bytes],
    ]),
  };
}

function withDeclaredBytes(checkpoint: AttemptCheckpoint, bytes: number): AttemptCheckpoint {
  if (!("blob" in checkpoint.payload)) throw new Error("test checkpoint has no blob pointer");
  return {
    ...checkpoint,
    payload: { blob: { ...checkpoint.payload.blob, bytes } },
  };
}

function integrationBudgetPrepare(input: {
  candidate: AttemptCheckpoint;
  proof: AttemptCheckpoint;
  source: string;
  currentSubject: string;
  read: (pointer: { digest: string }) => Buffer;
}) {
  const bindings = createKernelExternalPlanBindings({
    environments: {
      loadExactRunEnvironment: () => ({
        repository: "owner/repo",
        base_branch: "main",
        source_reference: "OPE-201",
        runtime_snapshot: "snapshot-1",
        title: "Dogfood repair",
      }),
    } as never,
    blob_store: { read: input.read } as never,
  });
  const integrate = bindings.find(({ external_kind }) => external_kind === "core/integrate-unit@1")!;
  const priorPush = pushDelivery("delivery-budget-anchor", input.currentSubject, "create");
  return integrate.prepare({
    run: {
      id: "run-1",
      current_subject: input.currentSubject,
      definition_bundle_hash: "b".repeat(64),
    } as never,
    attempt: {
      id: "attempt-budget-integrate",
      input_subject: input.currentSubject,
      request_hash: "7".repeat(64),
      definition_bundle_hash: "b".repeat(64),
    } as never,
    stage: {} as never,
    context: {
      records: new Map<string, ExecutionRecord>([
        ["delivery-runtime", runtimeDelivery()],
        [priorPush.id, priorPush],
      ]),
      checkpoints: new Map([
        [input.candidate.id, input.candidate],
        [input.proof.id, input.proof],
      ]),
    },
    bundle: { source_commit: input.source } as never,
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("kernel publication plan binding", () => {
  it("preserves retryable Daytona integration failures for publish and unit integration", async () => {
    const delivery = rejectedDelivery({
      id: "delivery-retryable-integration",
      effectKind: "daytona/integrate-checkpoint@1",
      provider: "daytona",
      result: {
        schema: "openthrottle.daytona-integration-delivery/v1",
        state: "retryable_failure",
      },
    });

    await expect(evaluateRejected("core/publish@1", delivery)).resolves.toMatchObject({
      outcome: "retryable_infrastructure_failure",
    });
    await expect(evaluateRejected("core/integrate-unit@1", delivery)).resolves.toMatchObject({
      outcome: "retryable_infrastructure_failure",
    });
  });

  it("keeps needs-human and non-integration rejections permanent", async () => {
    const needsHuman = rejectedDelivery({
      id: "delivery-needs-human-integration",
      effectKind: "daytona/integrate-checkpoint@1",
      provider: "daytona",
      result: {
        schema: "openthrottle.daytona-integration-delivery/v1",
        state: "needs_human",
      },
    });
    const githubRejection = rejectedDelivery({
      id: "delivery-rejected-push",
      effectKind: "github/push-checkpoint@1",
      provider: "github",
      result: { schema: "openthrottle.github-push-delivery/v1" },
    });

    await expect(evaluateRejected("core/publish@1", needsHuman)).resolves.toMatchObject({
      outcome: "failure",
    });
    await expect(evaluateRejected(
      "core/integrate-unit@1",
      githubRejection,
      "github/push-checkpoint@1",
    )).resolves.toMatchObject({
      outcome: "failure",
    });
  });

  it("rejects an aggregate integration bundle over budget before reads or effect scheduling", async () => {
    const fixture = integrationBudgetFixture();
    let reads = 0;
    const candidate = withDeclaredBytes(
      fixture.candidate,
      KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES / 2,
    );
    const proof = withDeclaredBytes(
      fixture.proof,
      KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES / 2 + 1,
    );

    await expect(integrationBudgetPrepare({
      ...fixture,
      candidate,
      proof,
      read: ({ digest }) => {
        reads += 1;
        return fixture.bytesByDigest.get(digest)!;
      },
    })).rejects.toThrow(/aggregate sealed bundle byte ceiling/i);
    expect(reads).toBe(0);
  });

  it("accepts the exact aggregate integration bundle budget with one read per bundle", async () => {
    const fixture = integrationBudgetFixture();
    let reads = 0;
    const candidate = withDeclaredBytes(
      fixture.candidate,
      KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES / 2,
    );
    const proof = withDeclaredBytes(
      fixture.proof,
      KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES / 2,
    );

    const prepared = await integrationBudgetPrepare({
      ...fixture,
      candidate,
      proof,
      read: ({ digest }) => {
        reads += 1;
        return fixture.bytesByDigest.get(digest)!;
      },
    });

    expect(reads).toBe(2);
    expect(prepared.phases[0]!.effects[0]!.payload).toMatchObject({
      candidate_blob: { bytes: KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES / 2 },
      current_ancestry: [{
        checkpoint_blob: { bytes: KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES / 2 },
      }],
    });
  }, 15_000);

  it("compacts first and later publications onto the exact durable task-ref anchor", async () => {
    const root = mkdtempSync(join(tmpdir(), "ot-kernel-publication-compaction-"));
    directories.push(root);
    const work = join(root, "work");
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    git(work, ["config", "user.name", "Test"]);
    git(work, ["config", "user.email", "test@example.com"]);
    writeFileSync(join(work, "file.txt"), "source\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-qm", "source"]);
    const source = git(work, ["rev-parse", "HEAD"]);
    writeFileSync(join(work, "file.txt"), "accepted private tree\n");
    git(work, ["commit", "-qam", "private candidate"]);
    const candidateSubject = git(work, ["rev-parse", "HEAD"]);
    const candidateTree = git(work, ["rev-parse", "HEAD^{tree}"]);
    const requestHash = "1".repeat(64);
    const candidateBundle = writeBundle({
      repository: work,
      root,
      ref: `refs/openthrottle/checkpoints/${requestHash}`,
      commit: candidateSubject,
      boundary: source,
      name: "candidate.bundle",
    });
    const candidate: AttemptCheckpoint = {
      schema: "openthrottle.attempt-checkpoint/v1",
      id: "checkpoint-private-candidate",
      pipeline_run_id: "run-1",
      attempt_id: "attempt-private",
      request_hash: requestHash,
      definition_bundle_hash: "b".repeat(64),
      input_subject: source,
      output_subject: candidateSubject,
      native_session_id: "session-private",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      payload: { blob: candidateBundle.pointer },
      captured_at: NOW,
    };

    const firstPublication = git(work, [
      "commit-tree", candidateTree, "-p", source, "-m", "OpenThrottle integrated checkpoint",
    ]);
    const firstBundle = writeBundle({
      repository: work,
      root,
      ref: `refs/openthrottle/integrations/${"2".repeat(64)}`,
      commit: firstPublication,
      boundary: source,
      name: "first-publication.bundle",
    });
    const secondPublication = git(work, [
      "commit-tree", candidateTree, "-p", firstPublication, "-m", "OpenThrottle integrated checkpoint",
    ]);
    const secondBundle = writeBundle({
      repository: work,
      root,
      ref: `refs/openthrottle/integrations/${"3".repeat(64)}`,
      commit: secondPublication,
      boundary: firstPublication,
      name: "second-publication.bundle",
    });
    const blobs = new Map([
      [candidateBundle.pointer.digest, candidateBundle.bytes],
      [firstBundle.pointer.digest, firstBundle.bytes],
      [secondBundle.pointer.digest, secondBundle.bytes],
    ]);
    const bindings = createKernelExternalPlanBindings({
      environments: {
        loadExactRunEnvironment: () => ({
          repository: "owner/repo",
          base_branch: "main",
          source_reference: "OPE-201",
          runtime_snapshot: "snapshot-1",
          title: "Dogfood repair",
        }),
      } as never,
      blob_store: { read: (value: { digest: string }) => blobs.get(value.digest)! } as never,
    });
    const publish = bindings.find(({ external_kind }) => external_kind === "core/publish@1")!;
    const attempt = {
      id: "attempt-publish",
      input_subject: candidateSubject,
      request_hash: "4".repeat(64),
      definition_bundle_hash: "b".repeat(64),
    } as never;
    const run = {
      id: "run-1",
      current_subject: candidateSubject,
      definition_bundle_hash: "b".repeat(64),
    } as never;
    const baseContext = {
      records: new Map([["delivery-runtime", runtimeDelivery()]]),
      checkpoints: new Map([[candidate.id, candidate]]),
    };

    const firstPrepared = await publish.prepare({
      run,
      attempt,
      stage: {} as never,
      context: baseContext,
      bundle: { source_commit: source } as never,
    });
    expect(firstPrepared.checkpoint_payload).toMatchObject({
      candidate_checkpoint_id: candidate.id,
      publication_parent_subject: source,
      publication_ref_mode: "create",
      publication_parent_delivery_record_id: null,
      ref: taskRef(),
    });
    expect(firstPrepared.phases[0]!.effects[0]!.payload).toMatchObject({
      checkpoint_base_subject: source,
      current_subject: source,
      candidate_output_subject: candidateSubject,
      current_ancestry: [],
    });

    const wrongTargetPush = pushDelivery(
      "delivery-wrong-target",
      firstPublication,
      "create",
      { repository: "other/repo", ref: "refs/heads/ot/other-run" },
    );
    await expect(publish.prepare({
      run,
      attempt,
      stage: {} as never,
      context: {
        records: new Map([
          ["delivery-runtime", runtimeDelivery()],
          [wrongTargetPush.id, wrongTargetPush],
        ]),
        checkpoints: baseContext.checkpoints,
      },
      bundle: { source_commit: source } as never,
    })).rejects.toThrow(/task-ref push evidence.*target/i);

    const firstDelivery = integrationDelivery({
      id: "delivery-first-compaction",
      parent: source,
      output: firstPublication,
      checkpointId: "checkpoint-first-publication",
      checkpointPointer: firstBundle.pointer,
    });
    const firstPromoted = await publish.promote!({
      run,
      attempt,
      stage: {} as never,
      context: baseContext,
      prepared: firstPrepared,
      schedules: [{ effects: [{ delivery: firstDelivery }] }] as never,
    });
    expect(firstPromoted.checkpoint).toMatchObject({
      input_subject: candidateSubject,
      output_subject: firstPublication,
      payload: { blob: firstBundle.pointer },
    });
    expect(firstPromoted.prepared.phases[1]!.effects[0]).toMatchObject({
      subject: firstPublication,
      payload: {
        ref_mode: "create",
        expected_old_subject: source,
        expected_new_subject: firstPublication,
        checkpoint_base_subject: source,
        checkpoint_blob: firstBundle.pointer,
      },
    });
    expect(firstPromoted.prepared.phases[2]!.effects[0]).toMatchObject({
      subject: firstPublication,
      payload: { expected_head_subject: firstPublication },
    });

    // Recovery after phase-zero promotion retains the immutable private
    // candidate on the Attempt even though the durable run subject is now P1.
    await expect(publish.prepare({
      run: {
        id: "run-1",
        current_subject: firstPublication,
        definition_bundle_hash: "b".repeat(64),
      } as never,
      attempt,
      stage: {} as never,
      context: baseContext,
      bundle: { source_commit: source } as never,
    })).resolves.toMatchObject({
      checkpoint_payload: { candidate_checkpoint_id: candidate.id },
    });

    const priorPush = pushDelivery("delivery-push-p1", firstPublication, "create");
    const updateContext = {
      records: new Map([
        ["delivery-runtime", runtimeDelivery()],
        [priorPush.id, priorPush],
      ]),
      checkpoints: baseContext.checkpoints,
    };
    const updatePrepared = await publish.prepare({
      run,
      attempt,
      stage: {} as never,
      context: updateContext,
      bundle: { source_commit: source } as never,
    });
    expect(updatePrepared.checkpoint_payload).toMatchObject({
      publication_parent_subject: firstPublication,
      publication_ref_mode: "update",
      publication_parent_delivery_record_id: priorPush.id,
    });
    expect(updatePrepared.phases[0]!.effects[0]!.payload).toMatchObject({
      checkpoint_base_subject: source,
      current_subject: firstPublication,
      current_ancestry: [],
    });

    const proofCheckpoint: AttemptCheckpoint = {
      ...candidate,
      id: "checkpoint-first-integration-proof",
      attempt_id: "attempt-first-integration",
      request_hash: "5".repeat(64),
      input_subject: source,
      output_subject: firstPublication,
      native_session_id: null,
      payload: { blob: firstBundle.pointer },
    };
    const integrate = bindings.find(({ external_kind }) => external_kind === "core/integrate-unit@1")!;
    await expect(integrate.prepare({
      run: { id: "run-1", definition_bundle_hash: "b".repeat(64) } as never,
      attempt: { id: "attempt-missing-proof", input_subject: firstPublication } as never,
      stage: {} as never,
      context: {
        records: updateContext.records,
        checkpoints: new Map([[candidate.id, candidate]]),
      },
      bundle: { source_commit: source } as never,
    })).rejects.toThrow(/ancestry/i);
    const stalePrepared = await integrate.prepare({
      run: {
        id: "run-1",
        current_subject: firstPublication,
        definition_bundle_hash: "b".repeat(64),
      } as never,
      attempt: {
        id: "attempt-integrate-stale",
        input_subject: firstPublication,
        request_hash: "6".repeat(64),
        definition_bundle_hash: "b".repeat(64),
      } as never,
      stage: {} as never,
      context: {
        records: updateContext.records,
        checkpoints: new Map([
          [proofCheckpoint.id, proofCheckpoint],
          [candidate.id, candidate],
        ]),
      },
      bundle: { source_commit: source } as never,
    });
    expect(stalePrepared.phases[0]!.effects[0]!.payload).toMatchObject({
      candidate_checkpoint_id: candidate.id,
      candidate_input_subject: source,
      current_subject: firstPublication,
      current_ancestry: [{
        checkpoint_id: proofCheckpoint.id,
        input_subject: source,
        output_subject: firstPublication,
        checkpoint_blob: firstBundle.pointer,
        checkpoint_artifact: {
          ref: `refs/openthrottle/integrations/${"2".repeat(64)}`,
          commit: firstPublication,
        },
      }],
    });
    await expect(integrate.prepare({
      run: { id: "run-1", definition_bundle_hash: "b".repeat(64) } as never,
      attempt: { id: "attempt-gap", input_subject: secondPublication } as never,
      stage: {} as never,
      context: {
        records: updateContext.records,
        checkpoints: new Map([
          [candidate.id, candidate],
          [proofCheckpoint.id, proofCheckpoint],
        ]),
      },
      bundle: { source_commit: source } as never,
    })).rejects.toThrow(/ancestry|gap/i);
    const secondProofCheckpoint: AttemptCheckpoint = {
      ...proofCheckpoint,
      id: "checkpoint-second-integration-proof",
      attempt_id: "attempt-second-integration",
      request_hash: "7".repeat(64),
      input_subject: firstPublication,
      output_subject: secondPublication,
      payload: { blob: secondBundle.pointer },
    };
    await expect(integrate.prepare({
      run: { id: "run-1", definition_bundle_hash: "b".repeat(64) } as never,
      attempt: { id: "attempt-extra", input_subject: firstPublication } as never,
      stage: {} as never,
      context: {
        records: updateContext.records,
        checkpoints: new Map([
          [candidate.id, candidate],
          [proofCheckpoint.id, proofCheckpoint],
          [secondProofCheckpoint.id, secondProofCheckpoint],
        ]),
      },
      bundle: { source_commit: source } as never,
    })).rejects.toThrow(/extra checkpoints/i);
    const forkSubject = git(work, [
      "commit-tree", candidateTree, "-p", source, "-m", "forked integration proof",
    ]);
    const forkBundle = writeBundle({
      repository: work,
      root,
      ref: `refs/openthrottle/integrations/${"8".repeat(64)}`,
      commit: forkSubject,
      boundary: source,
      name: "forked-integration.bundle",
    });
    blobs.set(forkBundle.pointer.digest, forkBundle.bytes);
    const forkCheckpoint: AttemptCheckpoint = {
      ...proofCheckpoint,
      id: "checkpoint-forked-integration-proof",
      attempt_id: "attempt-forked-integration",
      request_hash: "8".repeat(64),
      output_subject: forkSubject,
      payload: { blob: forkBundle.pointer },
    };
    await expect(integrate.prepare({
      run: { id: "run-1", definition_bundle_hash: "b".repeat(64) } as never,
      attempt: { id: "attempt-fork", input_subject: firstPublication } as never,
      stage: {} as never,
      context: {
        records: updateContext.records,
        checkpoints: new Map([
          [candidate.id, candidate],
          [proofCheckpoint.id, proofCheckpoint],
          [forkCheckpoint.id, forkCheckpoint],
        ]),
      },
      bundle: { source_commit: source } as never,
    })).rejects.toThrow(/fork/i);
    const forgedParentDelivery = integrationDelivery({
      id: "delivery-forged-identity-publication",
      parent: firstPublication,
      output: firstPublication,
      checkpointId: "checkpoint-forged-identity-publication",
      checkpointPointer: firstBundle.pointer,
    });
    await expect(publish.promote!({
      run,
      attempt,
      stage: {} as never,
      context: updateContext,
      prepared: updatePrepared,
      schedules: [{ effects: [{ delivery: forgedParentDelivery }] }] as never,
    })).rejects.toThrow(/exact sole parent/i);
    const secondDelivery = integrationDelivery({
      id: "delivery-second-compaction",
      parent: firstPublication,
      output: secondPublication,
      checkpointId: "checkpoint-second-publication",
      checkpointPointer: secondBundle.pointer,
    });
    const updatePromoted = await publish.promote!({
      run,
      attempt,
      stage: {} as never,
      context: updateContext,
      prepared: updatePrepared,
      schedules: [{ effects: [{ delivery: secondDelivery }] }] as never,
    });
    expect(updatePromoted.prepared.phases[1]!.effects[0]!.payload).toMatchObject({
      ref_mode: "update",
      expected_old_subject: firstPublication,
      expected_new_subject: secondPublication,
      checkpoint_base_subject: firstPublication,
    });
    expect(updatePromoted.checkpoint).toMatchObject({
      input_subject: candidateSubject,
      output_subject: secondPublication,
      payload: { blob: secondBundle.pointer },
    });

    const secondPriorPush = pushDelivery("delivery-push-p2", secondPublication, "update");
    await expect(publish.prepare({
      run,
      attempt,
      stage: {} as never,
      context: {
        records: new Map([
          ["delivery-runtime", runtimeDelivery()],
          [priorPush.id, priorPush],
          [secondPriorPush.id, secondPriorPush],
        ]),
        checkpoints: baseContext.checkpoints,
      },
      bundle: { source_commit: source } as never,
    })).rejects.toThrow(/multiple task-ref push deliveries/);
  }, 15_000);

  it("selects a legitimate identity checkpoint for structured no-content integration", async () => {
    const root = mkdtempSync(join(tmpdir(), "ot-kernel-plan-identity-test-"));
    directories.push(root);
    const work = join(root, "work");
    const bundlePath = join(root, "identity.bundle");
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: work });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: work });
    writeFileSync(join(work, "file.txt"), "already satisfied\n");
    execFileSync("git", ["add", "file.txt"], { cwd: work });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: work });
    const subject = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    const requestHash = "a".repeat(64);
    const ref = `refs/openthrottle/checkpoints/${requestHash}`;
    execFileSync("git", ["update-ref", ref, subject], { cwd: work });
    writeFileSync(join(work, ".git", "shallow"), `${subject}\n`);
    execFileSync("git", ["bundle", "create", bundlePath, ref], { cwd: work });
    const bytes = readFileSync(bundlePath);
    const checkpoint: AttemptCheckpoint = {
      schema: "openthrottle.attempt-checkpoint/v1",
      id: "checkpoint-identity",
      pipeline_run_id: "run-1",
      attempt_id: "attempt-edit",
      request_hash: requestHash,
      definition_bundle_hash: "b".repeat(64),
      input_subject: subject,
      output_subject: subject,
      native_session_id: "session-1",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      payload: { blob: {
        algorithm: "sha256",
        digest: "c".repeat(64),
        bytes: bytes.byteLength,
        encoding: "binary",
        media_type: "application/x-git-bundle",
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      } },
      captured_at: "2026-08-22T12:00:00.000Z",
    };
    const bindings = createKernelExternalPlanBindings({
      environments: {
        loadExactRunEnvironment: () => ({
          repository: "owner/repo",
          base_branch: "main",
          source_reference: "OPE-201",
        }),
      } as never,
      blob_store: { read: () => bytes } as never,
    });
    const integrate = bindings.find(({ external_kind }) => external_kind === "core/integrate-unit@1")!;
    const runtimeIdentity = "d".repeat(64);

    const prepared = await integrate.prepare({
      run: { id: "run-1", definition_bundle_hash: "b".repeat(64) } as never,
      attempt: { id: "attempt-integrate", input_subject: subject } as never,
      stage: {} as never,
      context: {
        records: new Map([["runtime-create", {
          kind: "delivery",
          status: "confirmed",
          payload_schema: "openthrottle.effect-delivery/v1",
          payload: { inline: {
            effect_kind: "daytona/create-sandbox@1",
            result: { identity: runtimeIdentity },
          } },
        } as never]]),
        checkpoints: new Map([[checkpoint.id, checkpoint]]),
      },
      bundle: { source_commit: subject } as never,
    });
    expect(prepared).toMatchObject({
      checkpoint_payload: {
        candidate_checkpoint_id: checkpoint.id,
        checkpoint_base_subject: subject,
      },
    });
    expect(prepared.phases[0]!.effects[0]!.payload).toMatchObject({
        checkpoint_base_subject: subject,
        current_subject: subject,
        candidate_input_subject: subject,
        candidate_output_subject: subject,
        candidate_artifact: { ref, commit: subject },
        current_ancestry: [],
    });
  });

  it("rejects an ordinary checkpoint with multiple parents before scheduling effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "ot-kernel-plan-bundle-test-"));
    directories.push(root);
    const work = join(root, "work");
    const bundlePath = join(root, "checkpoint.bundle");
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: work });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: work });
    writeFileSync(join(work, "file.txt"), "base\n");
    execFileSync("git", ["add", "file.txt"], { cwd: work });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: work });
    const inputSubject = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["checkout", "-q", "--orphan", "other"], { cwd: work });
    execFileSync("git", ["rm", "-q", "-rf", "."], { cwd: work });
    writeFileSync(join(work, "file.txt"), "other\n");
    execFileSync("git", ["add", "file.txt"], { cwd: work });
    execFileSync("git", ["commit", "-qm", "other"], { cwd: work });
    const other = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: work, encoding: "utf8" }).trim();
    const outputSubject = execFileSync(
      "git",
      ["commit-tree", tree, "-p", inputSubject, "-p", other, "-m", "invalid ordinary checkpoint"],
      { cwd: work, encoding: "utf8" },
    ).trim();
    const requestHash = "d".repeat(64);
    const ref = `refs/openthrottle/checkpoints/${requestHash}`;
    execFileSync("git", ["update-ref", ref, outputSubject], { cwd: work });
    execFileSync("git", ["bundle", "create", bundlePath, ref], { cwd: work });
    const bytes = readFileSync(bundlePath);
    const pointer = {
      algorithm: "sha256" as const,
      digest: "e".repeat(64),
      bytes: bytes.byteLength,
      encoding: "binary" as const,
      media_type: "application/x-git-bundle",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
    };
    const checkpoint: AttemptCheckpoint = {
      schema: "openthrottle.attempt-checkpoint/v1",
      id: "checkpoint-invalid",
      pipeline_run_id: "run-1",
      attempt_id: "attempt-edit",
      request_hash: requestHash,
      definition_bundle_hash: "f".repeat(64),
      input_subject: inputSubject,
      output_subject: outputSubject,
      native_session_id: "session-1",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      payload: { blob: pointer },
      captured_at: "2026-08-22T12:00:00.000Z",
    };
    const bindings = createKernelExternalPlanBindings({
      environments: {
        loadExactRunEnvironment: () => ({
          pipeline_run_id: "run-1",
          work_item_id: "work-1",
          repository_registration_id: "registration-1",
          repository: "owner/repo",
          base_branch: "main",
          runtime_snapshot: "snapshot-1",
          control_provider: "linear",
          source_provider: "linear",
          source_id: "issue-1",
          source_reference: "OPE-201",
          title: "Dogfood repair",
          current_subject: outputSubject,
        }),
      },
      blob_store: { read: () => bytes } as never,
    });
    const publish = bindings.find(({ external_kind }) => external_kind === "core/publish@1")!;

    await expect(publish.prepare({
      run: { id: "run-1", current_subject: outputSubject } as never,
      attempt: { input_subject: outputSubject } as never,
      stage: {} as never,
      context: { records: new Map(), checkpoints: new Map([[checkpoint.id, checkpoint]]) },
      bundle: { source_commit: inputSubject } as never,
    })).rejects.toThrow(/exact sole parent/i);
  });
});
