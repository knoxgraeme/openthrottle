import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ATTEMPT_CHECKPOINT_SCHEMA,
  EXECUTION_PLAN_SCHEMA_V2,
  EXECUTION_RECORD_SCHEMA,
  RELEASE_COMPILER_ENVIRONMENT_DIGEST,
  RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
  compileDefinitionBundle,
  digestCanonicalJson,
  verifyCompilerEnvironment,
  verifyPlatformDefinitionSource,
  type AttemptCheckpoint,
  type CompiledPipelineManifest,
  type CompilerEnvironmentDescriptor,
  type DecisionRecord,
  type DefinitionBundle,
  type DeliveryRecord,
  type ExecutionPlanContractV2,
  type ExecutionRecord,
  type PlatformDefinitionCatalog,
  type ResultRecord,
  type VirtualDefinitionFile,
} from "@openthrottle/contracts";
import { createPendingKernelAttempt } from "../pipeline/kernel/action-request.js";
import { createPipelineDecisionRecord } from "../pipeline/kernel/evaluator-registry.js";
import type {
  ExternalScheduleView,
  KernelExternalSettlementPlanner,
  KernelAttemptRequestInputs,
  SettledStructuredPlanningAttempt,
  StructuredPlanningReadRequest,
} from "../pipeline/kernel/ports.js";
import { compileKernelCursor, frontierMemberKey } from "../pipeline/kernel/reducer.js";
import {
  KERNEL_RUN_SCHEMA,
  type AttemptScope,
  type KernelAttempt,
  type KernelRun,
} from "../pipeline/kernel/types.js";
import type { OrdinaryKernelSettlementPlanner } from "../pipeline/kernel/ordinary-coordinator.js";
import {
  KernelStructuredSettlementPlanner,
  type KernelStructuredSettlementStore,
} from "./kernel-structured-planner.js";

const NOW = "2026-08-20T12:00:00.000Z";
const SOURCE = "1".repeat(40);
const UNIT_A = "2".repeat(40);
const UNIT_B = "3".repeat(40);
const INTEGRATED = "4".repeat(40);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

type OrdinaryInput = Parameters<OrdinaryKernelSettlementPlanner["plan"]>[0];
type ExternalInput = Parameters<KernelExternalSettlementPlanner["plan"]>[0];

function filesBelow(root: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const candidate of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, candidate.name);
      if (candidate.isDirectory()) visit(path);
      else if (candidate.isFile()) paths.push(path);
    }
  };
  visit(root);
  return paths;
}

function structuredDefinitions(): {
  bundle: DefinitionBundle;
  manifest: CompiledPipelineManifest;
} {
  const definitionRoot = join(REPOSITORY_ROOT, ".openthrottle");
  const files = new Map<string, VirtualDefinitionFile>(filesBelow(definitionRoot).map((path) => [
    `.openthrottle/${relative(definitionRoot, path)}`,
    { type: "file", content: readFileSync(path) },
  ]));
  const configPath = ".openthrottle/config.yml";
  const config = files.get(configPath);
  if (!config || config.type !== "file") throw new Error("test config is missing");
  const selectedConfig = Buffer.from(config.content).toString("utf8")
    .replace(/^pipeline: .*$/m, "pipeline: core/structured");
  files.delete(configPath);
  const generatedRoot = join(REPOSITORY_ROOT, "contracts/generated");
  const platform = JSON.parse(readFileSync(
    join(generatedRoot, "platform-definition-catalog.json"),
    "utf8",
  )) as PlatformDefinitionCatalog;
  const catalogPaths = new Set(platform.files.map(({ path }) => path));
  for (const path of files.keys()) {
    if (!catalogPaths.has(path)) files.delete(path);
  }
  const compiler = JSON.parse(readFileSync(
    join(generatedRoot, "compiler-environment.json"),
    "utf8",
  )) as CompilerEnvironmentDescriptor;
  const compilation = compileDefinitionBundle({
    repository: {
      source_commit: SOURCE,
      files: new Map([[configPath, { type: "file", content: selectedConfig }]]),
    },
    platform: verifyPlatformDefinitionSource(
      platform,
      files,
      RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
    ),
    compiler_environment: verifyCompilerEnvironment(
      compiler,
      RELEASE_COMPILER_ENVIRONMENT_DIGEST,
    ),
    selected_pipeline: "core/structured",
  });
  return { bundle: compilation.bundle.value, manifest: compilation.manifest.value };
}

const DEFINITIONS = structuredDefinitions();

function stage(stageId: string): CompiledPipelineManifest["stages"][number] {
  const value = DEFINITIONS.manifest.stages.find(({ id }) => id === stageId);
  if (!value) throw new Error(`test stage ${stageId} is missing`);
  return value;
}

function plan(): ExecutionPlanContractV2 {
  const unit = (id: string, dependsOn: string[]) => ({
    id,
    title: `Unit ${id}`,
    depends_on: dependsOn,
    objective: `Implement ${id}.`,
    requirements: ["Meet the contract."],
    files: [`src/${id}.ts`],
    approach: ["Implement directly."],
    tests: ["Run the focused test."],
    acceptance: ["The focused test passes."],
    verification: ["Inspect the exact result."],
  });
  return {
    schema: EXECUTION_PLAN_SCHEMA_V2,
    pipeline_id: "core/structured",
    plan_id: "plan-1",
    units: [unit("unit-a", []), unit("unit-b", ["unit-a"])],
    commands: [],
  };
}

function fencedPlan(): string {
  return `Task\n\n\`\`\`json ${EXECUTION_PLAN_SCHEMA_V2}\n${JSON.stringify(plan())}\n\`\`\``;
}

function promotionDecision(): DecisionRecord {
  const payload = {
    schema: "openthrottle.admission-promotion/v1",
    source_run_id: "run-planning",
    source_attempt_id: "attempt-review-plan",
    selected_pipeline: "core/structured",
    source_commit: SOURCE,
    execution_plan: plan(),
    planner_result_id: "result-plan",
    planner_result_hash: "a".repeat(64),
    reviewer_result_id: "result-plan-review",
    reviewer_result_hash: "b".repeat(64),
  };
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: "decision-admission-promotion",
    kind: "decision",
    pipeline_run_id: "run-1",
    reducer: "kernel/promote-admission@1",
    input_record_ids: [],
    payload_schema: "openthrottle.admission-promotion/v1",
    payload: { inline: payload as never },
    created_at: NOW,
  };
}

function runtimeDelivery(kind: "create" | "start"): DeliveryRecord {
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `delivery-runtime-${kind}`,
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: `effect-runtime-${kind}`,
    idempotency_key: `run-1:runtime:${kind}`,
    external_identity: "daytona:sandbox-1",
    status: "confirmed",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: {
      inline: {
        effect_kind: kind === "create"
          ? "daytona/create-sandbox@1"
          : "daytona/start-sandbox@1",
        provider: "daytona",
        result: { sandbox_id: "sandbox-1", resource_state: `${kind}d` },
      },
    },
    created_at: NOW,
  };
}

function phaseDelivery(id: string): DeliveryRecord {
  return {
    ...runtimeDelivery("create"),
    id,
    effect_id: `effect-${id}`,
    idempotency_key: `run-1:${id}`,
    external_identity: `external:${id}`,
    payload: { inline: { effect_kind: "test/effect@1", provider: "test", result: {} } },
  };
}

function githubPushDelivery(id: string, sha: string, refMode: "create" | "update"): DeliveryRecord {
  const repository = "owner/repo";
  const ref = "refs/heads/ot/run-1";
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id,
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: `effect-${id}`,
    idempotency_key: `run-1:${id}`,
    external_identity: `github:${repository}:${ref}`,
    status: "confirmed",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: {
      inline: {
        effect_kind: "github/push-checkpoint@1",
        provider: "github",
        result: {
          schema: "openthrottle.github-push-delivery/v1",
          repository,
          ref,
          sha,
          ref_mode: refMode,
        },
      },
    },
    created_at: NOW,
  };
}

function reviewBoundary(id: string): AttemptCheckpoint {
  return {
    schema: ATTEMPT_CHECKPOINT_SCHEMA,
    id,
    pipeline_run_id: "run-1",
    attempt_id: "attempt-integrate-all",
    request_hash: "d".repeat(64),
    definition_bundle_hash: DEFINITIONS.manifest.definition_bundle_hash,
    input_subject: SOURCE,
    output_subject: INTEGRATED,
    native_session_id: null,
    payload_schema: "openthrottle.git-checkpoint-bundle/v1",
    payload: { inline: { exact: true } },
    captured_at: NOW,
  };
}

function requestInputs(input: {
  task_prompt?: string;
  records?: readonly ExecutionRecord[];
  checkpoints?: readonly AttemptCheckpoint[];
} = {}): KernelAttemptRequestInputs {
  return {
    task_prompt: input.task_prompt ?? fencedPlan(),
    context: {
      records: new Map((input.records ?? []).map((record) => [record.id, record])),
      checkpoints: new Map((input.checkpoints ?? []).map((checkpoint) => [checkpoint.id, checkpoint])),
    },
  };
}

function pendingAttempt(input: {
  id: string;
  stage_id: string;
  scope?: AttemptScope;
  input_subject?: string;
  request: KernelAttemptRequestInputs;
}): KernelAttempt {
  return createPendingKernelAttempt({
    id: input.id,
    pipeline_run_id: "run-1",
    scope: input.scope ?? { kind: "stage", stage_id: input.stage_id },
    input_subject: input.input_subject ?? SOURCE,
    bundle: DEFINITIONS.bundle,
    manifest: DEFINITIONS.manifest,
    action_inputs: {
      task_prompt: input.request.task_prompt,
      context: {
        records: [...input.request.context.records.values()],
        checkpoints: [...input.request.context.checkpoints.values()],
      },
    },
  });
}

function completedAttempt(input: {
  pending: KernelAttempt;
  output_subject: string | null;
  evaluated?: { evaluator: string; outcome: string; reason: string };
  request: KernelAttemptRequestInputs;
  settled?: boolean;
}): {
  attempt: KernelAttempt;
  checkpoint: AttemptCheckpoint;
  result: ResultRecord;
  decision: DecisionRecord;
  evidence: SettledStructuredPlanningAttempt;
} {
  const checkpoint: AttemptCheckpoint = {
    schema: ATTEMPT_CHECKPOINT_SCHEMA,
    id: `checkpoint-${input.pending.id}`,
    pipeline_run_id: input.pending.pipeline_run_id,
    attempt_id: input.pending.id,
    request_hash: input.pending.request_hash,
    definition_bundle_hash: input.pending.definition_bundle_hash,
    input_subject: input.pending.input_subject,
    output_subject: input.output_subject,
    native_session_id: input.pending.repository_authority === "inspect" ? null : `session-${input.pending.id}`,
    payload_schema: "openthrottle.test-checkpoint/v1",
    payload: { inline: { exact: true } },
    captured_at: NOW,
  };
  const result: ResultRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `result-${input.pending.id}`,
    kind: "result",
    pipeline_run_id: input.pending.pipeline_run_id,
    attempt_id: input.pending.id,
    request_hash: input.pending.request_hash,
    definition_bundle_hash: input.pending.definition_bundle_hash,
    input_subject: input.pending.input_subject,
    output_subject: input.output_subject,
    original_candidate_hash: digestCanonicalJson({ attempt: input.pending.id, original: true }),
    normalized_candidate_hash: digestCanonicalJson({ attempt: input.pending.id, normalized: true }),
    payload_schema: "openthrottle.semantic-result-record/v1",
    payload: { inline: { outcome: input.evaluated?.outcome ?? "success" } },
    created_at: NOW,
  };
  const recorded: KernelAttempt = {
    ...input.pending,
    output_subject: input.output_subject,
    native_session_id: checkpoint.native_session_id,
    status: "recorded",
    version: 3,
    checkpoint_id: checkpoint.id,
    result_record_id: result.id,
  };
  const evaluated = input.evaluated ?? {
    evaluator: "core/unit-outcome@1",
    outcome: "success",
    reason: "validated_semantic_result",
  };
  const decision = createPipelineDecisionRecord({
    attempt: recorded,
    result,
    evaluated,
    created_at: NOW,
  });
  const attempt: KernelAttempt = input.settled
    ? {
      ...recorded,
      status: "settled",
      version: recorded.version + 1,
      decision_record_id: decision.id,
    }
    : recorded;
  return {
    attempt,
    checkpoint,
    result,
    decision,
    evidence: {
      attempt: {
        ...recorded,
        status: "settled",
        version: recorded.version + 1,
        decision_record_id: decision.id,
      },
      checkpoint,
      result,
      decision,
      request_inputs: input.request,
    },
  };
}

function view(input: {
  attempts: readonly KernelAttempt[];
  current: KernelAttempt;
  completed?: readonly string[];
  current_subject?: string;
}): OrdinaryInput["view"] {
  const cursor = compileKernelCursor({
    stage_id: input.current.scope.stage_id,
    version: 2,
    attempts: input.attempts,
    completed_scope_keys: input.completed ?? [],
  });
  const run: KernelRun = {
    schema: KERNEL_RUN_SCHEMA,
    id: "run-1",
    pipeline_id: "core/structured",
    definition_bundle_hash: DEFINITIONS.manifest.definition_bundle_hash,
    current_subject: input.current_subject ?? SOURCE,
    status: "running",
    terminal_outcome: null,
    cursor,
    version: 4,
    work_retry_limit: 2,
    result_correction_limit: 2,
    active_attempt_versions: Object.fromEntries(input.attempts.map((attempt) => [attempt.id, attempt.version])),
    active_effect_versions: {},
    checkpoint_ids: Object.fromEntries(input.attempts.flatMap((attempt) =>
      attempt.checkpoint_id === null ? [] : [[attempt.id, attempt.checkpoint_id]])),
  };
  return {
    manifest: DEFINITIONS.manifest,
    run,
    current_attempt: input.current,
    records: new Map(),
    checkpoints: new Map(),
  };
}

class PlanningStore implements KernelStructuredSettlementStore {
  readonly requests = new Map<string, KernelAttemptRequestInputs>();
  readonly reads: StructuredPlanningReadRequest[] = [];
  settled: SettledStructuredPlanningAttempt[] = [];

  async loadAttemptRequestInputs(input: {
    pipeline_run_id: string;
    attempt_id: string;
  }): Promise<KernelAttemptRequestInputs> {
    if (input.pipeline_run_id !== "run-1") throw new Error("foreign test run");
    const request = this.requests.get(input.attempt_id);
    if (!request) throw new Error(`missing test request ${input.attempt_id}`);
    return request;
  }

  async listSettledStructuredPlanningAttempts(
    request: StructuredPlanningReadRequest,
  ): Promise<readonly SettledStructuredPlanningAttempt[]> {
    this.reads.push(request);
    return this.settled;
  }
}

function externalSchedules(deliveries: readonly DeliveryRecord[]): ExternalScheduleView[] {
  return deliveries.map((delivery, index) => ({
    semantic_key: `schedule-${index}`,
    decision: {
      schema: EXECUTION_RECORD_SCHEMA,
      id: `decision-schedule-${index}`,
      kind: "decision",
      pipeline_run_id: "run-1",
      reducer: "core/external-schedule@1",
      input_record_ids: [],
      payload_schema: "openthrottle.external-schedule/v1",
      payload: { inline: { phase: String(index) } },
      created_at: NOW,
    },
    effects: [{ intent: {} as never, delivery }],
  }));
}

function ordinaryInput(input: {
  attempt: KernelAttempt;
  checkpoint: AttemptCheckpoint;
  result: ResultRecord;
  view: OrdinaryInput["view"];
  outcome?: string;
  evaluator?: string;
  reason?: string;
}): OrdinaryInput {
  const selected = stage(input.attempt.scope.stage_id);
  if (selected.kind === "effect" || selected.kind === "wait") throw new Error("test stage is external");
  return {
    view: input.view,
    stage: selected,
    attempt: input.attempt,
    checkpoint: input.checkpoint,
    result: input.result,
    bundle: DEFINITIONS.bundle,
    evaluated: {
      evaluator: input.evaluator ??
        (selected.kind === "command" ? "core/command-outcome@1" : `core/${selected.id}@1`),
      outcome: input.outcome ?? "success",
      reason: input.reason ?? "validated_semantic_result",
    },
    default_plan: vi.fn(async () => {
      throw new Error("unexpected default plan");
    }),
  };
}

describe("KernelStructuredSettlementPlanner", () => {
  it("returns a nonstructured coordinator default plan unchanged", async () => {
    const store = new PlanningStore();
    const request = requestInputs();
    const pending = pendingAttempt({ id: "attempt-final-test", stage_id: "final_test", request });
    const completed = completedAttempt({ pending, output_subject: null, request });
    const selected = stage("final_test");
    if (selected.kind === "effect" || selected.kind === "wait") throw new Error("test stage is external");
    const defaultSettlement = {
      decision: completed.decision,
      outcome: "success",
      input_records: [completed.result],
      checkpoints: [],
      next_attempts: [],
    };
    const defaultPlan = vi.fn(async () => defaultSettlement);
    const reduction = view({ attempts: [completed.attempt], current: completed.attempt });
    const planner = new KernelStructuredSettlementPlanner({ store, now: () => NOW });

    const settlement = await planner.plan({
      view: {
        ...reduction,
        manifest: { ...reduction.manifest, pipeline_id: "core/implement" },
      },
      stage: selected,
      attempt: completed.attempt,
      checkpoint: completed.checkpoint,
      result: completed.result,
      bundle: DEFINITIONS.bundle,
      evaluated: { evaluator: "core/command-outcome@1", outcome: "success", reason: "passed" },
      default_plan: defaultPlan,
    });

    expect(settlement).toBe(defaultSettlement);
    expect(defaultPlan).toHaveBeenCalledOnce();
  });

  it("uses one exact admission promotion plan and retains it in the first unit request", async () => {
    const store = new PlanningStore();
    const promotion = promotionDecision();
    const request = requestInputs({ task_prompt: "Original immutable issue prompt.", records: [promotion] });
    const pending = pendingAttempt({
      id: "attempt-provision",
      stage_id: "ot_runtime_provision",
      request,
    });
    const completed = completedAttempt({ pending, output_subject: null, request });
    store.requests.set(pending.id, request);
    const selected = stage("ot_runtime_provision");
    if (selected.kind !== "effect") throw new Error("provision test stage is not an effect");
    const create = runtimeDelivery("create");
    const start = runtimeDelivery("start");
    const planner = new KernelStructuredSettlementPlanner({ store, now: () => NOW });
    const input: ExternalInput = {
      view: view({ attempts: [completed.attempt], current: completed.attempt }),
      stage: selected,
      attempt: completed.attempt,
      checkpoint: completed.checkpoint,
      result: completed.result,
      bundle: DEFINITIONS.bundle,
      schedules: externalSchedules([create, start]),
      evaluated: { evaluator: "external/core/daytona-provision@1", outcome: "success", reason: "ready" },
      default_plan: vi.fn(async () => {
        throw new Error("promotion should not use the default plan");
      }),
    };

    const settlement = await planner.plan(input);

    expect(settlement.next_attempts).toHaveLength(1);
    expect(settlement.next_attempts[0]!.scope).toMatchObject({
      kind: "loop_item",
      stage_id: "implement_unit",
      item_id: "unit-a",
    });
    expect(settlement.next_attempts[0]!.context_record_ids).toEqual([
      promotion.id,
      create.id,
      start.id,
    ].sort());
  });

  it("fans the last unit sibling into exact lineage-preserving successors", async () => {
    const store = new PlanningStore();
    const records = [runtimeDelivery("create"), runtimeDelivery("start"), promotionDecision()];
    const firstRequest = requestInputs({ records });
    const secondRequest = requestInputs({ records });
    const firstPending = pendingAttempt({
      id: "attempt-unit-a",
      stage_id: "implement_unit",
      scope: {
        kind: "loop_item", stage_id: "implement_unit", parent_attempt_id: "attempt-provision",
        loop_id: "execution_plan.units", item_id: "unit-a", item_index: 0,
      },
      request: firstRequest,
    });
    const secondPending = pendingAttempt({
      id: "attempt-unit-b",
      stage_id: "implement_unit",
      scope: {
        kind: "loop_item", stage_id: "implement_unit", parent_attempt_id: "attempt-provision",
        loop_id: "execution_plan.units", item_id: "unit-b", item_index: 1,
      },
      request: secondRequest,
    });
    const first = completedAttempt({
      pending: firstPending, output_subject: UNIT_A, request: firstRequest, settled: true,
    });
    const second = completedAttempt({ pending: secondPending, output_subject: UNIT_B, request: secondRequest });
    store.requests.set(firstPending.id, firstRequest);
    store.requests.set(secondPending.id, secondRequest);
    store.settled = [first.evidence];
    const reduction = view({
      attempts: [first.attempt, second.attempt],
      current: second.attempt,
      completed: [frontierMemberKey(first.attempt)],
    });
    const planner = new KernelStructuredSettlementPlanner({ store, now: () => NOW });

    const settlement = await planner.plan(ordinaryInput({
      attempt: second.attempt,
      checkpoint: second.checkpoint,
      result: second.result,
      view: reduction,
    }));

    expect(settlement.next_attempts.map(({ scope }) => scope)).toMatchObject([
      { kind: "loop_item", stage_id: "simplify_unit", item_id: "unit-a" },
      { kind: "loop_item", stage_id: "simplify_unit", item_id: "unit-b" },
    ]);
    expect(settlement.next_attempts.map(({ input_subject }) => input_subject)).toEqual([UNIT_A, UNIT_B]);
    expect(settlement.checkpoints.map(({ id }) => id).sort()).toEqual([
      first.checkpoint.id,
      second.checkpoint.id,
    ].sort());
    expect(settlement.next_attempts.every((attempt) =>
      attempt.context_record_ids.includes("decision-admission-promotion"))).toBe(true);
    expect(store.reads[0]).toMatchObject({
      scope_kind: "loop_item",
      parent_attempt_id: "attempt-provision",
      scope_group_id: "execution_plan.units",
      stage_ids: ["implement_unit"],
      member_ids: ["unit-a", "unit-b"],
    });
  });

  it("serializes an accepted unit into one integration Attempt", async () => {
    const store = new PlanningStore();
    const promotion = promotionDecision();
    const candidate: AttemptCheckpoint = {
      schema: ATTEMPT_CHECKPOINT_SCHEMA,
      id: "checkpoint-candidate-a",
      pipeline_run_id: "run-1",
      attempt_id: "attempt-edit-a",
      request_hash: "c".repeat(64),
      definition_bundle_hash: DEFINITIONS.manifest.definition_bundle_hash,
      input_subject: SOURCE,
      output_subject: UNIT_A,
      native_session_id: "session-edit-a",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      payload: { inline: { exact: true } },
      captured_at: NOW,
    };
    const request = requestInputs({
      records: [runtimeDelivery("create"), runtimeDelivery("start"), promotion],
      checkpoints: [candidate],
    });
    const pending = pendingAttempt({
      id: "attempt-accept-a",
      stage_id: "accept_unit",
      scope: {
        kind: "loop_item", stage_id: "accept_unit", parent_attempt_id: "attempt-provision",
        loop_id: "execution_plan.units", item_id: "unit-a", item_index: 0,
      },
      input_subject: UNIT_A,
      request,
    });
    const completed = completedAttempt({ pending, output_subject: null, request });
    store.requests.set(pending.id, request);
    const planner = new KernelStructuredSettlementPlanner({ store, now: () => NOW });

    const settlement = await planner.plan(ordinaryInput({
      attempt: completed.attempt,
      checkpoint: completed.checkpoint,
      result: completed.result,
      view: view({ attempts: [completed.attempt], current: completed.attempt }),
    }));

    expect(settlement.next_attempts).toHaveLength(1);
    expect(settlement.next_attempts[0]!.scope).toMatchObject({
      kind: "loop_item",
      stage_id: "integrate_unit",
      item_id: "unit-a",
    });
    expect(settlement.next_attempts[0]!.context_checkpoint_ids).toEqual([candidate.id]);
    expect(settlement.next_attempts[0]!.context_record_ids).toContain(promotion.id);
  });

  it("carries the complete two-link settled integration chain into a third serial integration", async () => {
    const unit = (id: string) => ({
      id,
      title: `Unit ${id}`,
      depends_on: [],
      objective: `Implement ${id}.`,
      requirements: ["Meet the contract."],
      files: [`src/${id}.ts`],
      approach: ["Implement directly."],
      tests: ["Run the focused test."],
      acceptance: ["The focused test passes."],
      verification: ["Inspect the exact result."],
    });
    const executionPlan: ExecutionPlanContractV2 = {
      ...plan(),
      units: [unit("unit-a"), unit("unit-b"), unit("unit-c")],
    };
    const taskPrompt = `Task\n\n\`\`\`json ${EXECUTION_PLAN_SCHEMA_V2}\n${JSON.stringify(executionPlan)}\n\`\`\``;
    const basePromotion = promotionDecision();
    const promotionInline = (basePromotion.payload as { inline: Record<string, unknown> }).inline;
    const promotion: DecisionRecord = {
      ...basePromotion,
      payload: { inline: { ...promotionInline, execution_plan: executionPlan } as never },
    };
    const runtime = [runtimeDelivery("create"), runtimeDelivery("start")];
    const accepted = (memberId: string, index: number, outputSubject: string) => {
      const candidate: AttemptCheckpoint = {
        schema: ATTEMPT_CHECKPOINT_SCHEMA,
        id: `checkpoint-candidate-${memberId}`,
        pipeline_run_id: "run-1",
        attempt_id: `attempt-edit-${memberId}`,
        request_hash: String(index + 5).repeat(64),
        definition_bundle_hash: DEFINITIONS.manifest.definition_bundle_hash,
        input_subject: SOURCE,
        output_subject: outputSubject,
        native_session_id: `session-edit-${memberId}`,
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
        payload: { inline: { exact: true } },
        captured_at: NOW,
      };
      const request = requestInputs({
        task_prompt: taskPrompt,
        records: [...runtime, promotion],
        checkpoints: [candidate],
      });
      const pending = pendingAttempt({
        id: `attempt-accept-${memberId}`,
        stage_id: "accept_unit",
        scope: {
          kind: "loop_item",
          stage_id: "accept_unit",
          parent_attempt_id: "attempt-provision",
          loop_id: "execution_plan.units",
          item_id: memberId,
          item_index: index,
        },
        input_subject: outputSubject,
        request,
      });
      return { candidate, ...completedAttempt({ pending, output_subject: null, request, settled: true }) };
    };
    const acceptedA = accepted("unit-a", 0, UNIT_A);
    const acceptedB = accepted("unit-b", 1, UNIT_B);
    const acceptedC = accepted("unit-c", 2, "6".repeat(40));
    const integratedA = "4".repeat(40);
    const integratedB = "5".repeat(40);
    const integration = (input: {
      memberId: string;
      index: number;
      inputSubject: string;
      outputSubject: string;
      accepted: typeof acceptedA;
      proof: readonly AttemptCheckpoint[];
      settled: boolean;
    }) => {
      const request = requestInputs({
        task_prompt: taskPrompt,
        records: [
          ...runtime,
          promotion,
          input.accepted.result,
          input.accepted.decision,
        ],
        checkpoints: [input.accepted.candidate, ...input.proof],
      });
      const pending = pendingAttempt({
        id: `attempt-integrate-${input.memberId}`,
        stage_id: "integrate_unit",
        scope: {
          kind: "loop_item",
          stage_id: "integrate_unit",
          parent_attempt_id: "attempt-provision",
          loop_id: "execution_plan.units",
          item_id: input.memberId,
          item_index: input.index,
        },
        input_subject: input.inputSubject,
        request,
      });
      return {
        request,
        ...completedAttempt({
          pending,
          output_subject: input.outputSubject,
          request,
          settled: input.settled,
          evaluated: {
            evaluator: "external/core/integrate-unit@1",
            outcome: "all_integrated",
            reason: "integrated",
          },
        }),
      };
    };
    const first = integration({
      memberId: "unit-a",
      index: 0,
      inputSubject: SOURCE,
      outputSubject: integratedA,
      accepted: acceptedA,
      proof: [],
      settled: true,
    });
    const second = integration({
      memberId: "unit-b",
      index: 1,
      inputSubject: integratedA,
      outputSubject: integratedB,
      accepted: acceptedB,
      proof: [first.checkpoint],
      settled: false,
    });
    const store = new PlanningStore();
    store.requests.set(second.attempt.id, second.request);
    store.settled = [acceptedC.evidence, first.evidence, acceptedB.evidence, acceptedA.evidence];
    const selected = stage("integrate_unit");
    if (selected.kind !== "effect") throw new Error("integration test stage is not an effect");
    const integrateDelivery = phaseDelivery("delivery-integrate-b");
    const push = githubPushDelivery("delivery-push-b", integratedB, "update");
    const planner = new KernelStructuredSettlementPlanner({ store, now: () => NOW });

    const settlement = await planner.plan({
      view: view({
        attempts: [second.attempt],
        current: second.attempt,
        current_subject: integratedA,
      }),
      stage: selected,
      attempt: second.attempt,
      checkpoint: second.checkpoint,
      result: second.result,
      bundle: DEFINITIONS.bundle,
      schedules: externalSchedules([integrateDelivery, push]),
      evaluated: {
        evaluator: "external/core/integrate-unit@1",
        outcome: "all_integrated",
        reason: "integrated",
      },
      default_plan: vi.fn(async () => { throw new Error("unexpected default plan"); }),
    });

    expect(settlement.outcome).toBe("next_integration");
    expect(settlement.next_attempts[0]!.scope).toMatchObject({
      kind: "loop_item",
      stage_id: "integrate_unit",
      item_id: "unit-c",
    });
    expect(settlement.next_attempts[0]!.context_checkpoint_ids).toEqual([
      acceptedC.candidate.id,
      first.checkpoint.id,
      second.checkpoint.id,
    ].sort());
  });

  it("turns a lead rejection into a distinct unbound edit Attempt with exact prior evidence", async () => {
    const store = new PlanningStore();
    const runtime = [runtimeDelivery("create"), runtimeDelivery("start")];
    const promotion = promotionDecision();
    const candidate: AttemptCheckpoint = {
      schema: ATTEMPT_CHECKPOINT_SCHEMA,
      id: "checkpoint-candidate-a",
      pipeline_run_id: "run-1",
      attempt_id: "attempt-edit-a",
      request_hash: "c".repeat(64),
      definition_bundle_hash: DEFINITIONS.manifest.definition_bundle_hash,
      input_subject: SOURCE,
      output_subject: UNIT_A,
      native_session_id: "session-edit-a",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      payload: { inline: { exact: true } },
      captured_at: NOW,
    };
    const request = requestInputs({ records: [...runtime, promotion], checkpoints: [candidate] });
    const pending = pendingAttempt({
      id: "attempt-accept-a",
      stage_id: "accept_unit",
      scope: {
        kind: "loop_item", stage_id: "accept_unit", parent_attempt_id: "attempt-provision",
        loop_id: "execution_plan.units", item_id: "unit-a", item_index: 0,
      },
      input_subject: UNIT_A,
      request,
    });
    const completed = completedAttempt({
      pending,
      output_subject: null,
      request,
      evaluated: {
        evaluator: "core/action-outcome@1",
        outcome: "semantic_repair_required",
        reason: "blocking_unit_finding",
      },
    });
    const leadAttempt = { ...completed.attempt, native_session_id: "session-unit-lead" };
    const leadCheckpoint = { ...completed.checkpoint, native_session_id: "session-unit-lead" };
    store.requests.set(pending.id, request);
    const planner = new KernelStructuredSettlementPlanner({ store, now: () => NOW });

    const settlement = await planner.plan(ordinaryInput({
      attempt: leadAttempt,
      checkpoint: leadCheckpoint,
      result: completed.result,
      view: view({ attempts: [leadAttempt], current: leadAttempt }),
      evaluator: "core/action-outcome@1",
      outcome: "semantic_repair_required",
      reason: "blocking_unit_finding",
    }));

    const repair = settlement.next_attempts[0]!;
    expect(repair.id).not.toBe(leadAttempt.id);
    expect(repair).toMatchObject({
      repository_authority: "edit",
      native_session_id: null,
      input_subject: UNIT_A,
      scope: {
        kind: "loop_item",
        stage_id: "repair_unit",
        item_id: "unit-a",
      },
      context_checkpoint_ids: [candidate.id],
    });
    expect(repair.native_session_id).not.toBe(leadAttempt.native_session_id);
    expect(repair.context_record_ids).toEqual([
      ...runtime.map(({ id }) => id),
      promotion.id,
      completed.result.id,
      settlement.decision.id,
    ].sort());
  });

  it("uses external delivery-citing integration evidence to unlock the next unit", async () => {
    const store = new PlanningStore();
    const promotion = promotionDecision();
    const inheritedPush = githubPushDelivery("delivery-push-d1", "1".repeat(40), "create");
    const runtime = [runtimeDelivery("create"), runtimeDelivery("start")];
    const candidate: AttemptCheckpoint = {
      schema: ATTEMPT_CHECKPOINT_SCHEMA,
      id: "checkpoint-candidate-a",
      pipeline_run_id: "run-1",
      attempt_id: "attempt-edit-a",
      request_hash: "c".repeat(64),
      definition_bundle_hash: DEFINITIONS.manifest.definition_bundle_hash,
      input_subject: SOURCE,
      output_subject: UNIT_A,
      native_session_id: "session-edit-a",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      payload: { inline: { exact: true } },
      captured_at: NOW,
    };
    const acceptanceRequest = requestInputs({ records: [...runtime, promotion], checkpoints: [candidate] });
    const acceptancePending = pendingAttempt({
      id: "attempt-accept-a",
      stage_id: "accept_unit",
      scope: {
        kind: "loop_item", stage_id: "accept_unit", parent_attempt_id: "attempt-provision",
        loop_id: "execution_plan.units", item_id: "unit-a", item_index: 0,
      },
      input_subject: UNIT_A,
      request: acceptanceRequest,
    });
    const acceptance = completedAttempt({
      pending: acceptancePending, output_subject: null, request: acceptanceRequest, settled: true,
    });
    const integrationRequest = requestInputs({
      task_prompt: "Original immutable issue prompt.",
      records: [...runtime, promotion, inheritedPush, acceptance.result, acceptance.decision],
      checkpoints: [candidate],
    });
    const integrationPending = pendingAttempt({
      id: "attempt-integrate-a",
      stage_id: "integrate_unit",
      scope: {
        kind: "loop_item", stage_id: "integrate_unit", parent_attempt_id: "attempt-provision",
        loop_id: "execution_plan.units", item_id: "unit-a", item_index: 0,
      },
      request: integrationRequest,
    });
    const integration = completedAttempt({
      pending: integrationPending,
      output_subject: INTEGRATED,
      request: integrationRequest,
      evaluated: {
        evaluator: "external/core/integrate-unit@1",
        outcome: "all_integrated",
        reason: "integrated",
      },
    });
    store.requests.set(integrationPending.id, integrationRequest);
    store.settled = [acceptance.evidence];
    const selected = stage("integrate_unit");
    if (selected.kind !== "effect") throw new Error("integration test stage is not an effect");
    const firstPhase = phaseDelivery("delivery-integrate");
    const secondPhase = githubPushDelivery("delivery-push-d2", "2".repeat(40), "update");
    const planner = new KernelStructuredSettlementPlanner({ store, now: () => NOW });
    const input: ExternalInput = {
      view: view({
        attempts: [integration.attempt],
        current: integration.attempt,
        current_subject: SOURCE,
      }),
      stage: selected,
      attempt: integration.attempt,
      checkpoint: integration.checkpoint,
      result: integration.result,
      bundle: DEFINITIONS.bundle,
      schedules: externalSchedules([firstPhase, secondPhase]),
      evaluated: {
        evaluator: "external/core/integrate-unit@1",
        outcome: "all_integrated",
        reason: "integrated",
      },
      default_plan: vi.fn(async () => {
        throw new Error("structured integration should not use the default plan");
      }),
    };

    const settlement = await planner.plan(input);

    expect(settlement.outcome).toBe("next_unit");
    expect(settlement.decision.input_record_ids).toEqual([
      integration.result.id,
      firstPhase.id,
      secondPhase.id,
    ].sort());
    expect(settlement.next_attempts).toHaveLength(1);
    expect(settlement.next_attempts[0]!.scope).toMatchObject({
      kind: "loop_item",
      stage_id: "implement_unit",
      item_id: "unit-b",
    });
    expect(settlement.next_attempts[0]!.input_subject).toBe(INTEGRATED);
    expect(settlement.next_attempts[0]!.context_checkpoint_ids).toContain(integration.checkpoint.id);
    expect(settlement.next_attempts[0]!.context_record_ids).toContain(settlement.decision.id);
    expect(settlement.next_attempts[0]!.context_record_ids).toContain(promotion.id);
    expect(settlement.next_attempts[0]!.context_record_ids).toContain(secondPhase.id);
    expect(settlement.next_attempts[0]!.context_record_ids).not.toContain(inheritedPush.id);
  });

  it("compiles five selected reviewers into a stable serial inspect frontier", async () => {
    const store = new PlanningStore();
    const push = githubPushDelivery("delivery-push-d1", "1".repeat(40), "create");
    const boundary: AttemptCheckpoint = {
      schema: ATTEMPT_CHECKPOINT_SCHEMA,
      id: "checkpoint-integrated-boundary",
      pipeline_run_id: "run-1",
      attempt_id: "attempt-integrate-all",
      request_hash: "d".repeat(64),
      definition_bundle_hash: DEFINITIONS.manifest.definition_bundle_hash,
      input_subject: SOURCE,
      output_subject: INTEGRATED,
      native_session_id: null,
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      payload: { inline: { exact: true } },
      captured_at: NOW,
    };
    const request = requestInputs({
      records: [runtimeDelivery("create"), runtimeDelivery("start"), push],
      checkpoints: [boundary],
    });
    const pending = pendingAttempt({
      id: "attempt-select-personas",
      stage_id: "select_review_personas",
      input_subject: INTEGRATED,
      request,
    });
    const completed = completedAttempt({ pending, output_subject: null, request });
    const personaStage = stage("persona_review");
    if (personaStage.kind !== "agent") throw new Error("persona review test stage is not an agent");
    const personas = personaStage.skills.slice(0, 5);
    const selectorResult: ResultRecord = {
      ...completed.result,
      payload_schema: "openthrottle.semantic-result-record/v1",
      payload: {
        inline: {
          schema: "openthrottle.semantic-result-record/v1",
          semantic_schema_id: "core/persona-selection",
          outcome: "success",
          payload: { summary: "selected exact reviewers", personas },
          transformations: [],
        },
      },
    };
    store.requests.set(pending.id, request);
    const planner = new KernelStructuredSettlementPlanner({ store, now: () => NOW });

    const settlement = await planner.plan(ordinaryInput({
      attempt: completed.attempt,
      checkpoint: completed.checkpoint,
      result: selectorResult,
      view: view({ attempts: [completed.attempt], current: completed.attempt, current_subject: INTEGRATED }),
    }));

    const canonicalPersonas = [...personas].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0);
    expect(settlement.next_attempts.map(({ scope }) => scope)).toMatchObject(canonicalPersonas.map((memberId) => ({
      kind: "fanout_member",
      stage_id: "persona_review",
      member_id: memberId,
    })));
    const scopeKeys = settlement.next_attempts.map(frontierMemberKey);
    const dependencies = settlement.next_dependencies;
    if (!dependencies) throw new Error("persona settlement omitted serial dependencies");
    expect(dependencies[scopeKeys[0]!]).toEqual([]);
    for (let index = 1; index < scopeKeys.length; index += 1) {
      expect(dependencies[scopeKeys[index]!]).toEqual([scopeKeys[index - 1]!]);
    }
    expect(settlement.next_attempts.every((attempt) =>
      attempt.context_checkpoint_ids.includes(boundary.id))).toBe(true);
    expect(settlement.next_attempts.every((attempt) =>
      attempt.context_record_ids.includes(push.id))).toBe(true);
  });

  it("anchors a divergent terminal review wave only to durable and atomically appended records", async () => {
    const store = new PlanningStore();
    const runtime = [runtimeDelivery("create"), runtimeDelivery("start")];
    const boundary = reviewBoundary("checkpoint-divergent-terminal-boundary");
    const firstRequest = requestInputs({ records: runtime, checkpoints: [boundary] });
    const secondRequest = requestInputs({ records: runtime, checkpoints: [boundary] });
    const firstPending = pendingAttempt({
      id: "attempt-review-correctness-terminal",
      stage_id: "persona_review",
      scope: {
        kind: "fanout_member", stage_id: "persona_review", parent_attempt_id: "attempt-selector",
        fanout_id: "selection.personas", member_id: "core/correctness-dataflow", member_index: 0,
      },
      input_subject: INTEGRATED,
      request: firstRequest,
    });
    const secondPending = pendingAttempt({
      id: "attempt-review-security-terminal",
      stage_id: "persona_review",
      scope: {
        kind: "fanout_member", stage_id: "persona_review", parent_attempt_id: "attempt-selector",
        fanout_id: "selection.personas", member_id: "core/security", member_index: 1,
      },
      input_subject: INTEGRATED,
      request: secondRequest,
    });
    const first = completedAttempt({
      pending: firstPending,
      output_subject: null,
      request: firstRequest,
      settled: true,
      evaluated: {
        evaluator: "core/review-outcome@1",
        outcome: "success",
        reason: "validated_semantic_result",
      },
    });
    const second = completedAttempt({
      pending: secondPending,
      output_subject: null,
      request: secondRequest,
      evaluated: {
        evaluator: "core/review-outcome@1",
        outcome: "failure",
        reason: "review_execution_failed",
      },
    });
    store.requests.set(secondPending.id, secondRequest);
    store.settled = [first.evidence];
    const planner = new KernelStructuredSettlementPlanner({ store, now: () => NOW });

    const settlement = await planner.plan(ordinaryInput({
      attempt: second.attempt,
      checkpoint: second.checkpoint,
      result: second.result,
      view: view({
        attempts: [first.attempt, second.attempt],
        current: second.attempt,
        completed: [frontierMemberKey(first.attempt)],
        current_subject: INTEGRATED,
      }),
      outcome: "failure",
      evaluator: "core/review-outcome@1",
      reason: "review_execution_failed",
    }));

    expect(settlement.outcome).toBe("failure");
    expect(settlement.decision.id).not.toBe(second.decision.id);
    expect(settlement.next_attempts).toHaveLength(1);
    expect(settlement.next_attempts[0]!.scope).toEqual({
      kind: "stage",
      stage_id: "ot_runtime_stop_failed",
    });
    expect(settlement.next_attempts[0]!.context_record_ids).toEqual([
      ...runtime.map(({ id }) => id),
      first.result.id,
      first.decision.id,
      second.result.id,
      settlement.decision.id,
    ].sort());
    expect(settlement.next_attempts[0]!.context_record_ids).not.toContain(second.decision.id);
    const authorizedAtSettlement = new Map([
      ...runtime,
      first.decision,
      ...settlement.input_records,
      settlement.decision,
    ].map((record) => [record.id, record]));
    expect(settlement.next_attempts[0]!.context_record_ids.map((id) =>
      authorizedAtSettlement.get(id)?.id)).toEqual(settlement.next_attempts[0]!.context_record_ids);
  });

  it("preserves both durable review decisions for uniform terminal routing", async () => {
    const store = new PlanningStore();
    const runtime = [runtimeDelivery("create"), runtimeDelivery("start")];
    const boundary = reviewBoundary("checkpoint-uniform-terminal-boundary");
    const firstRequest = requestInputs({ records: runtime, checkpoints: [boundary] });
    const secondRequest = requestInputs({ records: runtime, checkpoints: [boundary] });
    const firstPending = pendingAttempt({
      id: "attempt-review-correctness-uniform-terminal",
      stage_id: "persona_review",
      scope: {
        kind: "fanout_member", stage_id: "persona_review", parent_attempt_id: "attempt-selector",
        fanout_id: "selection.personas", member_id: "core/correctness-dataflow", member_index: 0,
      },
      input_subject: INTEGRATED,
      request: firstRequest,
    });
    const secondPending = pendingAttempt({
      id: "attempt-review-security-uniform-terminal",
      stage_id: "persona_review",
      scope: {
        kind: "fanout_member", stage_id: "persona_review", parent_attempt_id: "attempt-selector",
        fanout_id: "selection.personas", member_id: "core/security", member_index: 1,
      },
      input_subject: INTEGRATED,
      request: secondRequest,
    });
    const failedEvaluation = {
      evaluator: "core/review-outcome@1",
      outcome: "failure",
      reason: "review_execution_failed",
    };
    const first = completedAttempt({
      pending: firstPending,
      output_subject: null,
      request: firstRequest,
      settled: true,
      evaluated: failedEvaluation,
    });
    const second = completedAttempt({
      pending: secondPending,
      output_subject: null,
      request: secondRequest,
      evaluated: failedEvaluation,
    });
    store.requests.set(secondPending.id, secondRequest);
    store.settled = [first.evidence];
    const planner = new KernelStructuredSettlementPlanner({ store, now: () => NOW });

    const settlement = await planner.plan(ordinaryInput({
      attempt: second.attempt,
      checkpoint: second.checkpoint,
      result: second.result,
      view: view({
        attempts: [first.attempt, second.attempt],
        current: second.attempt,
        completed: [frontierMemberKey(first.attempt)],
        current_subject: INTEGRATED,
      }),
      ...failedEvaluation,
    }));

    expect(settlement.decision.id).toBe(second.decision.id);
    expect(settlement.next_attempts[0]!.scope).toEqual({
      kind: "stage",
      stage_id: "ot_runtime_stop_failed",
    });
    expect(settlement.next_attempts[0]!.context_record_ids).toEqual([
      ...runtime.map(({ id }) => id),
      first.result.id,
      first.decision.id,
      second.result.id,
      second.decision.id,
    ].sort());
  });

  it("fans review evidence into validation and preserves runtime identity for edit remediation", async () => {
    const store = new PlanningStore();
    const push = githubPushDelivery("delivery-push-d1", "1".repeat(40), "create");
    const runtime = [runtimeDelivery("create"), runtimeDelivery("start"), push];
    const boundary: AttemptCheckpoint = {
      schema: ATTEMPT_CHECKPOINT_SCHEMA,
      id: "checkpoint-integrated-boundary",
      pipeline_run_id: "run-1",
      attempt_id: "attempt-integrate-all",
      request_hash: "d".repeat(64),
      definition_bundle_hash: DEFINITIONS.manifest.definition_bundle_hash,
      input_subject: SOURCE,
      output_subject: INTEGRATED,
      native_session_id: null,
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      payload: { inline: { exact: true } },
      captured_at: NOW,
    };
    const firstRequest = requestInputs({ records: runtime, checkpoints: [boundary] });
    const secondRequest = requestInputs({ records: runtime, checkpoints: [boundary] });
    const firstPending = pendingAttempt({
      id: "attempt-review-correctness",
      stage_id: "persona_review",
      scope: {
        kind: "fanout_member", stage_id: "persona_review", parent_attempt_id: "attempt-selector",
        fanout_id: "selection.personas", member_id: "core/correctness-dataflow", member_index: 0,
      },
      input_subject: INTEGRATED,
      request: firstRequest,
    });
    const secondPending = pendingAttempt({
      id: "attempt-review-security",
      stage_id: "persona_review",
      scope: {
        kind: "fanout_member", stage_id: "persona_review", parent_attempt_id: "attempt-selector",
        fanout_id: "selection.personas", member_id: "core/security", member_index: 1,
      },
      input_subject: INTEGRATED,
      request: secondRequest,
    });
    const first = completedAttempt({
      pending: firstPending,
      output_subject: null,
      request: firstRequest,
      settled: true,
      evaluated: {
        evaluator: "core/review-outcome@1",
        outcome: "success",
        reason: "validated_semantic_result",
      },
    });
    const second = completedAttempt({
      pending: secondPending,
      output_subject: null,
      request: secondRequest,
      evaluated: {
        evaluator: "core/review-outcome@1",
        outcome: "semantic_repair_required",
        reason: "blocking_review_finding",
      },
    });
    store.requests.set(firstPending.id, firstRequest);
    store.requests.set(secondPending.id, secondRequest);
    store.settled = [first.evidence];
    const planner = new KernelStructuredSettlementPlanner({ store, now: () => NOW });
    const fanoutSettlement = await planner.plan(ordinaryInput({
      attempt: second.attempt,
      checkpoint: second.checkpoint,
      result: second.result,
      view: view({
        attempts: [first.attempt, second.attempt],
        current: second.attempt,
        completed: [frontierMemberKey(first.attempt)],
        current_subject: INTEGRATED,
      }),
      outcome: "semantic_repair_required",
      evaluator: "core/review-outcome@1",
      reason: "blocking_review_finding",
    }));
    expect(fanoutSettlement.next_attempts).toHaveLength(1);
    expect(fanoutSettlement.next_attempts[0]!.scope).toEqual({
      kind: "stage",
      stage_id: "validate_review_findings",
    });
    expect(fanoutSettlement.next_attempts[0]!.context_record_ids).toEqual(expect.arrayContaining([
      first.result.id,
      first.decision.id,
      second.result.id,
      fanoutSettlement.decision.id,
    ]));

    const validationRequest = requestInputs({
      records: [
        ...runtime,
        first.result,
        first.decision,
        second.result,
        fanoutSettlement.decision,
      ],
      checkpoints: [boundary],
    });
    const validationPending = pendingAttempt({
      id: "attempt-validate-findings",
      stage_id: "validate_review_findings",
      input_subject: INTEGRATED,
      request: validationRequest,
    });
    const validation = completedAttempt({
      pending: validationPending,
      output_subject: null,
      request: validationRequest,
      evaluated: {
        evaluator: "core/review-outcome@1",
        outcome: "semantic_repair_required",
        reason: "blocking_review_finding",
      },
    });
    store.requests.set(validationPending.id, validationRequest);
    const remediation = await planner.plan(ordinaryInput({
      attempt: validation.attempt,
      checkpoint: validation.checkpoint,
      result: validation.result,
      view: view({
        attempts: [validation.attempt],
        current: validation.attempt,
        current_subject: INTEGRATED,
      }),
      outcome: "semantic_repair_required",
      evaluator: "core/review-outcome@1",
      reason: "blocking_review_finding",
    }));
    expect(remediation.next_attempts[0]!.scope).toEqual({ kind: "stage", stage_id: "final_repair" });
    expect(remediation.next_attempts[0]).toMatchObject({
      repository_authority: "edit",
      native_session_id: null,
      input_subject: INTEGRATED,
      context_checkpoint_ids: [boundary.id],
    });
    expect(remediation.next_attempts[0]!.context_record_ids).toEqual([
      ...runtime.map(({ id }) => id),
      validation.result.id,
      remediation.decision.id,
    ].sort());
  });
});
