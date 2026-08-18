import {
  EXECUTION_PLAN_SCHEMA_V2,
  EXECUTION_PLAN_SCHEMAS,
  canonicalJson,
  digestNormalized,
  parseAnyExecutionPlanContract,
  type ExecutionPlanContractV2,
  type RepositoryConfigContract,
} from "@openthrottle/contracts";
import type { Agent, TaskType } from "../pipeline/types.js";
import type { RepositorySkillPackage } from "../pipeline/manifest.js";
import { extractJsonBlocks, extractJsonBlocksAny } from "../pipeline/markdown.js";
import type { RepositoryDirectorySnapshot } from "./ports.js";

const EXECUTION_PLAN_FENCE = "openthrottle.execution-plan/v1";
const SHIP_SELECTION_FENCE = "openthrottle.ship-selection/v1";
const AUTOMATIC_SIMPLE_REF = "core/simple@1";
const AUTOMATIC_STRUCTURED_REF = "core/structured@3";
const REPOSITORY_SKILL_PACKAGE_SCHEMA = "openthrottle.repository-skill-package/v1";
export const DEFAULT_ADMISSION_PLANNER_SKILL = "builtin://admission-plan@1";
export const DEFAULT_ADMISSION_REVIEWER_SKILL = "builtin://review-admission-plan@1";

export interface AdmissionCandidate {
  graph_id: "simple" | "structured";
  graph_ref: typeof AUTOMATIC_SIMPLE_REF | typeof AUTOMATIC_STRUCTURED_REF;
}

export type AdmissionAuthority =
  | {
      kind: "direct";
      graph_id: string;
      execution_plan?: ExecutionPlanContractV2;
      explicit: boolean;
    }
  | {
      kind: "automatic";
      candidates: [AdmissionCandidate, AdmissionCandidate];
      lock: AdmissionCandidate | null;
    };

export interface AdmissionBasisInput {
  schema: "openthrottle.admission-basis/v1";
  source: {
    ticket_id: string;
    session_id: string;
    generation: number;
    task_type: "implement";
    context: string;
  };
  candidates: Array<AdmissionCandidate & { manifest_digest: string }>;
  lock: AdmissionCandidate | null;
  skills: {
    planner: { reference: string; package_digest: string | null };
    reviewer: { reference: string; package_digest: string | null };
  };
  repository: {
    name: string;
    base_commit: string;
    config_digest: string;
  };
  runtime: {
    release: string;
    capability_digest: string;
  };
  engine: {
    agent: Agent;
    model: string | null;
    reasoning_effort: string | null;
  };
}

export interface AdmissionBasisContract {
  value: AdmissionBasisInput;
  normalized: string;
  digest: string;
}

export interface ResolvedAdmissionSkillBinding {
  configured_reference: string;
  producer_reference: string;
  invocation: string;
  package_digest: string | null;
  package?: RepositorySkillPackage;
}

function repositorySkillFrontmatterName(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") throw new Error("repository skill SKILL.md is missing frontmatter");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error("repository skill SKILL.md frontmatter is unterminated");
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^name:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]{0,127})["']?\s*$/);
    if (match) return match[1];
  }
  throw new Error("repository skill SKILL.md frontmatter is missing name");
}

export async function resolvePinnedRepositorySkillPackage(input: {
  id: string;
  config: RepositoryConfigContract;
  readPinnedDirectory: (path: string) => Promise<RepositoryDirectorySnapshot>;
}): Promise<RepositorySkillPackage> {
  const declaration = (input.config.skills ?? []).find((skill) => skill.id === input.id);
  if (!declaration) throw new Error(`repository skill repo://${input.id} is not declared in repository config skills`);
  const snapshot = await input.readPinnedDirectory(declaration.path);
  if (snapshot.directory !== declaration.path) {
    throw new Error(`repository skill ${input.id} resolved to unexpected directory ${snapshot.directory}`);
  }
  const skillFile = snapshot.files.find((file) => file.path === `${declaration.path}/SKILL.md`);
  if (!skillFile) throw new Error(`repository skill ${input.id} package is missing SKILL.md`);
  if (repositorySkillFrontmatterName(skillFile.content) !== input.id) {
    throw new Error(`repository skill ${input.id} SKILL.md name does not match the configured invocation`);
  }
  const files = snapshot.files.map((file) => ({
    path: file.path,
    blobSha: file.blobSha,
    digest: digestNormalized(file.content),
  }));
  const unsigned = {
    schema: REPOSITORY_SKILL_PACKAGE_SCHEMA as "openthrottle.repository-skill-package/v1",
    reference: `repo://${snapshot.repository}@${snapshot.commit}#${declaration.path}`,
    invocation: input.id,
    directory: declaration.path,
    commit: snapshot.commit,
    files,
  };
  return { ...unsigned, packageDigest: digestNormalized(canonicalJson(unsigned)) };
}

async function resolveAdmissionSkill(
  reference: string,
  config: RepositoryConfigContract,
  readPinnedDirectory: (path: string) => Promise<RepositoryDirectorySnapshot>
): Promise<ResolvedAdmissionSkillBinding> {
  if (reference.startsWith("builtin://")) {
    return {
      configured_reference: reference,
      producer_reference: reference,
      invocation: reference.slice("builtin://".length).replace(/@\d+$/, ""),
      package_digest: null,
    };
  }
  const id = reference.slice("repo://".length);
  const resolved = await resolvePinnedRepositorySkillPackage({ id, config, readPinnedDirectory });
  return {
    configured_reference: reference,
    producer_reference: resolved.reference,
    invocation: resolved.invocation,
    package_digest: resolved.packageDigest,
    package: resolved,
  };
}

export async function resolveAdmissionSkillBindings(input: {
  config: RepositoryConfigContract;
  readPinnedDirectory: (path: string) => Promise<RepositoryDirectorySnapshot>;
}): Promise<{ planner: ResolvedAdmissionSkillBinding; reviewer: ResolvedAdmissionSkillBinding }> {
  const intent = input.config.intents?.implement;
  const plannerReference = intent?.planner_skill ?? DEFAULT_ADMISSION_PLANNER_SKILL;
  const reviewerReference = intent?.reviewer_skill ?? DEFAULT_ADMISSION_REVIEWER_SKILL;
  const plannerPromise = resolveAdmissionSkill(plannerReference, input.config, input.readPinnedDirectory);
  const reviewerPromise = reviewerReference === plannerReference
    ? plannerPromise
    : resolveAdmissionSkill(reviewerReference, input.config, input.readPinnedDirectory);
  const [planner, reviewer] = await Promise.allSettled([plannerPromise, reviewerPromise]);
  if (planner.status === "rejected") throw planner.reason;
  if (reviewer.status === "rejected") throw reviewer.reason;
  return { planner: planner.value, reviewer: reviewer.value };
}

function extractShipSelectionGraphId(context: string): string | undefined {
  const blocks = extractJsonBlocks(context, SHIP_SELECTION_FENCE);
  if (blocks.length === 0) return undefined;
  if (blocks.length > 1) {
    throw new Error(`expected at most one ${SHIP_SELECTION_FENCE} block, found ${blocks.length}`);
  }
  const parsed = JSON.parse(blocks[0]!) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${SHIP_SELECTION_FENCE}: must be an object`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema !== SHIP_SELECTION_FENCE) {
    throw new Error(`${SHIP_SELECTION_FENCE}.schema: must be ${SHIP_SELECTION_FENCE}`);
  }
  if (typeof record.graph_id !== "string" || record.graph_id.length === 0) {
    throw new Error(`${SHIP_SELECTION_FENCE}.graph_id: must be a non-empty string`);
  }
  const unknown = Object.keys(record).find((key) => key !== "schema" && key !== "graph_id");
  if (unknown) throw new Error(`${SHIP_SELECTION_FENCE}.${unknown}: unknown field`);
  return record.graph_id;
}

function assertNoUnfencedControlJson(context: string): void {
  for (const schema of [SHIP_SELECTION_FENCE, ...EXECUTION_PLAN_SCHEMAS]) {
    const outsideCanonicalFence = context.replace(
      /```([^\n`]*)\n[\s\S]*?```/g,
      (block, marker: string) => marker.trim().split(/\s+/).includes(schema) ? "" : block
    );
    const escaped = schema.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`"schema"\\s*:\\s*"${escaped}"`).test(outsideCanonicalFence)) {
      throw new Error(
        `found ${schema} control JSON outside its canonical \`\`\`json ${schema} fenced block`
      );
    }
  }
}

function extractExecutionPlan(context: string): ExecutionPlanContractV2 | undefined {
  const blocks = extractJsonBlocksAny(context, EXECUTION_PLAN_SCHEMAS);
  if (blocks.length === 0) return undefined;
  if (blocks.length > 1) throw new Error(`expected at most one execution-plan block, found ${blocks.length}`);
  const plan = parseAnyExecutionPlanContract(blocks[0]!, { source: "issue.execution_plan" }).value;
  if (plan.schema !== EXECUTION_PLAN_SCHEMA_V2) {
    throw new Error(`fresh structured admission requires ${EXECUTION_PLAN_SCHEMA_V2}; ${EXECUTION_PLAN_FENCE} is replay-only`);
  }
  return plan;
}

function automaticCandidates(config: RepositoryConfigContract): [AdmissionCandidate, AdmissionCandidate] {
  const intent = config.intents?.implement;
  const allowed = new Set(intent?.allowed_graphs ?? [config.default_graph]);
  const simple = config.graphs.find((entry) =>
    entry.id === "simple" && entry.kind === "builtin" && entry.ref === AUTOMATIC_SIMPLE_REF
  );
  const structured = config.graphs.find((entry) =>
    entry.id === "structured" && entry.kind === "builtin" && entry.ref === AUTOMATIC_STRUCTURED_REF
  );
  if (!simple || !allowed.has(simple.id)) {
    throw new Error(`automatic admission requires allowed graph simple backed by ${AUTOMATIC_SIMPLE_REF}`);
  }
  if (!structured || !allowed.has(structured.id)) {
    throw new Error(`automatic admission requires allowed graph structured backed by ${AUTOMATIC_STRUCTURED_REF}`);
  }
  return [
    { graph_id: "simple", graph_ref: AUTOMATIC_SIMPLE_REF },
    { graph_id: "structured", graph_ref: AUTOMATIC_STRUCTURED_REF },
  ];
}

export function resolveAdmissionAuthority(input: {
  config: RepositoryConfigContract;
  taskType: TaskType;
  context: string;
}): AdmissionAuthority {
  assertNoUnfencedControlJson(input.context);
  const selected = extractShipSelectionGraphId(input.context);
  const executionPlan = extractExecutionPlan(input.context);
  const planned = executionPlan?.graph_id;
  if (selected && planned && selected !== planned) {
    throw new Error(`ship selection graph_id ${selected} does not match execution_plan.graph_id ${planned}`);
  }
  if (input.taskType !== "implement" && (selected || executionPlan)) {
    throw new Error(`graph selection is not supported for ${input.taskType} tickets`);
  }

  const intent = input.config.intents?.implement;
  const graphId = selected ?? planned ?? intent?.default_graph ?? input.config.default_graph;
  const allowedGraphs = intent?.allowed_graphs ?? [input.config.default_graph];
  if (!allowedGraphs.includes(graphId)) {
    throw new Error(`graph ${graphId} is not allowed for implement; allowed: ${allowedGraphs.join(", ")}`);
  }
  const graph = input.config.graphs.find((entry) => entry.id === graphId);
  if (!graph) throw new Error(`graph ${graphId} is not declared in repository config`);
  if (graph.ref === AUTOMATIC_SIMPLE_REF && executionPlan) {
    throw new Error("simple graph selection cannot carry an execution plan");
  }

  const automatic = intent?.admission_mode === "automatic";
  if (automatic && !selected && !executionPlan) {
    return { kind: "automatic", candidates: automaticCandidates(input.config), lock: null };
  }
  if (
    automatic && selected && !executionPlan && graph.id === "structured" &&
    graph.kind === "builtin" && graph.ref === AUTOMATIC_STRUCTURED_REF
  ) {
    const candidates = automaticCandidates(input.config);
    return { kind: "automatic", candidates, lock: candidates[1] };
  }
  return {
    kind: "direct",
    graph_id: graphId,
    ...(executionPlan === undefined ? {} : { execution_plan: executionPlan }),
    explicit: selected !== undefined || executionPlan !== undefined,
  };
}

export function buildAdmissionBasis(input: AdmissionBasisInput): AdmissionBasisContract {
  const normalized = canonicalJson(input);
  return { value: JSON.parse(normalized) as AdmissionBasisInput, normalized, digest: digestNormalized(normalized) };
}
