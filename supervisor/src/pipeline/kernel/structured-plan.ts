import {
  EXECUTION_PLAN_SCHEMA_V2,
  validateEvalDefinition,
  validateExecutionPlanContractV2,
  type CompiledPipelineManifest,
  type DefinitionBundle,
  type ExecutionPlanContractV2,
  type ResultRecord,
} from "@openthrottle/contracts";
import { SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA } from "./evaluator-registry.js";

const FENCE_PATTERN = /```([^\n`]*)\n([\s\S]*?)```/g;
const EXECUTION_PLAN_SCHEMA_PROPERTY_PATTERN = new RegExp(
  `"schema"\\s*:\\s*${JSON.stringify(EXECUTION_PLAN_SCHEMA_V2).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
);

/**
 * Linear preserves fenced JSON bodies but may normalize an info string down to
 * `json`. Restore only blocks that still carry the exact execution-plan schema
 * property. Deliberately do not parse here: a malformed same-schema rival must
 * remain visible to the canonical parser so admission fails closed.
 */
export function restoreExecutionPlanFenceMarkers(markdown: string): string {
  return markdown.replace(FENCE_PATTERN, (block, rawMarker: string, body: string) => {
    if (rawMarker.trim() !== "json" || !EXECUTION_PLAN_SCHEMA_PROPERTY_PATTERN.test(body)) {
      return block;
    }
    return `\`\`\`json ${EXECUTION_PLAN_SCHEMA_V2}\n${body}\`\`\``;
  });
}

function executionPlanBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  for (const match of markdown.matchAll(FENCE_PATTERN)) {
    const marker = match[1]?.trim().split(/\s+/) ?? [];
    if (!marker.includes(EXECUTION_PLAN_SCHEMA_V2)) continue;
    const json = match[2]?.trim() ?? "";
    let value: unknown;
    try {
      value = JSON.parse(json) as unknown;
    } catch {
      throw new Error(`${EXECUTION_PLAN_SCHEMA_V2} block must contain valid JSON`);
    }
    const schema = value && typeof value === "object" && !Array.isArray(value)
      ? (value as { schema?: unknown }).schema
      : undefined;
    if (schema !== EXECUTION_PLAN_SCHEMA_V2) {
      throw new Error(
        `${EXECUTION_PLAN_SCHEMA_V2} block payload schema must be ${EXECUTION_PLAN_SCHEMA_V2}`,
      );
    }
    blocks.push(json);
  }
  return blocks;
}

export function parseStructuredExecutionPlan(
  taskPrompt: string,
  expectedPipelineId: string,
): ExecutionPlanContractV2 {
  const blocks = executionPlanBlocks(taskPrompt);
  if (blocks.length !== 1) {
    throw new Error(`structured execution requires exactly one ${EXECUTION_PLAN_SCHEMA_V2} block`);
  }
  const plan = validateExecutionPlanContractV2(JSON.parse(blocks[0]!) as unknown, {
    source: "structured.execution_plan",
  }).value;
  if (plan.pipeline_id !== expectedPipelineId) {
    throw new Error("structured execution plan names another compiled pipeline");
  }
  return plan;
}

export function selectedStructuredReviewPersonas(input: {
  result: ResultRecord;
  bundle: DefinitionBundle;
  manifest: CompiledPipelineManifest;
  selector_stage_id: string;
  fanout_stage_id: string;
}): string[] {
  const selector = input.manifest.stages.find(({ id }) => id === input.selector_stage_id);
  const fanout = input.manifest.stages.find(({ id }) => id === input.fanout_stage_id);
  if (selector?.kind !== "agent" || selector.eval !== "core/persona-selection") {
    throw new Error("structured persona selector is not bound to core/persona-selection");
  }
  if (fanout?.kind !== "agent" || fanout.repository_authority !== "inspect" || !fanout.loop) {
    throw new Error("structured persona fanout is not a bounded inspect loop");
  }
  const evalEntry = input.bundle.entries.find((entry) =>
    entry.definition_kind === "eval" && entry.definition_id === selector.eval);
  if (!evalEntry) throw new Error("structured persona selector omitted its sealed eval definition");
  const evaluation = validateEvalDefinition(evalEntry.normalized_payload, {
    source: `definition_bundle.eval:${selector.eval}`,
  }).value;
  const personaField = evaluation.result.payload.personas;
  if (!personaField || personaField.type !== "string_list" || personaField.max_items === undefined) {
    throw new Error("structured persona eval has no bounded personas field");
  }
  if (
    input.result.payload_schema !== SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA ||
    !("inline" in input.result.payload) || !input.result.payload.inline ||
    typeof input.result.payload.inline !== "object" || Array.isArray(input.result.payload.inline)
  ) throw new Error("structured persona selector result is not materialized semantic evidence");
  const semantic = input.result.payload.inline as Record<string, unknown>;
  const payload = semantic.payload;
  if (
    semantic.schema !== SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA ||
    semantic.semantic_schema_id !== selector.eval ||
    !payload || typeof payload !== "object" || Array.isArray(payload)
  ) throw new Error("structured persona selector result uses another semantic schema");
  const personas = (payload as Record<string, unknown>).personas;
  if (!Array.isArray(personas) || personas.length === 0 || personas.some((id) => typeof id !== "string")) {
    throw new Error("structured persona selection must contain reviewer IDs");
  }
  const selected = personas as string[];
  if (new Set(selected).size !== selected.length) {
    throw new Error("structured persona selection contains duplicate reviewer IDs");
  }
  const maximum = personaField.max_items;
  if (selected.length > maximum) {
    throw new Error(`structured persona selection exceeds its sealed bound of ${maximum}`);
  }
  const roster = new Set(fanout.skills);
  const unknown = selected.find((id) => !roster.has(id));
  if (unknown) throw new Error(`structured persona selection names unknown reviewer ${unknown}`);
  const selectedSet = new Set(selected);
  return fanout.skills.filter((id) => selectedSet.has(id));
}
