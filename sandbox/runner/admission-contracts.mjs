import { createHash } from "node:crypto";
import { canonicalJson } from "./capabilities.mjs";

export const ADMISSION_EXECUTION_PLAN_ARTIFACT_MAX_BYTES = 320 * 1024;
export const EXECUTION_PLAN_V2_MAX_BYTES = 256 * 1024;

const COMMAND_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const COMMAND_NAME_MAX_LENGTH = 80;

const STRING_ARRAY_SCHEMA = {
  type: "array",
  items: { type: "string" },
};

const EXECUTION_PLAN_UNIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "title", "depends_on", "objective", "requirements", "files",
    "approach", "tests", "acceptance", "verification",
  ],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    depends_on: STRING_ARRAY_SCHEMA,
    objective: { type: "string" },
    requirements: STRING_ARRAY_SCHEMA,
    files: STRING_ARRAY_SCHEMA,
    approach: STRING_ARRAY_SCHEMA,
    tests: STRING_ARRAY_SCHEMA,
    acceptance: STRING_ARRAY_SCHEMA,
    verification: STRING_ARRAY_SCHEMA,
  },
};

function executionPlanCommandSchema(commandNames) {
  const name = commandNames.length === 0
    ? { type: "string" }
    : { type: "string", enum: commandNames };
  return {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["name", "unit"],
        properties: {
          name,
          unit: { type: "string" },
        },
      },
    ],
  };
}

function executionPlanSchema(commandNames) {
  const commands = {
    type: "array",
    items: executionPlanCommandSchema(commandNames),
    ...(commandNames.length === 0 ? { maxItems: 0 } : {}),
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["schema", "graph_id", "plan_id", "units", "commands"],
    properties: {
      schema: { type: "string", enum: ["openthrottle.execution-plan/v2"] },
      graph_id: { type: "string" },
      plan_id: { type: "string" },
      units: { type: "array", items: EXECUTION_PLAN_UNIT_SCHEMA },
      commands,
    },
  };
}

// Provider-native structured output only shapes the model response. The
// executor's validators below remain authoritative for bounds, identifiers,
// graph integrity, cross-field rules, sanitization, and canonicalization.
export function admissionPlannerSemanticOutputSchema(commandNames = []) {
  if (!Array.isArray(commandNames)) throw new Error("admission command names must be an array");
  const allowedCommandNames = [...new Set(commandNames)].sort();
  if (allowedCommandNames.some((name) =>
    typeof name !== "string" || name.length > COMMAND_NAME_MAX_LENGTH || !COMMAND_NAME.test(name))) {
    throw new Error("admission command names must contain only valid configured command keys");
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["route", "rationale", "questions", "execution_plan"],
    properties: {
      route: { type: "string", enum: ["simple", "structured", "needs_human"] },
      rationale: { type: "string" },
      questions: STRING_ARRAY_SCHEMA,
      execution_plan: { anyOf: [{ type: "null" }, executionPlanSchema(allowedCommandNames)] },
    },
  };
}

const REVIEW_FINDING_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["severity", "message"],
      properties: {
        severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        message: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["severity", "message", "path"],
      properties: {
        severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        message: { type: "string" },
        path: { type: "string" },
      },
    },
  ],
};

export const ADMISSION_REVIEWER_SEMANTIC_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings", "questions"],
  properties: {
    verdict: { type: "string", enum: ["approved", "rejected", "needs_human"] },
    summary: { type: "string" },
    findings: { type: "array", items: REVIEW_FINDING_SCHEMA },
    questions: STRING_ARRAY_SCHEMA,
  },
});

export function admissionSemanticOutputSchema(stageId, commandNames = []) {
  if (stageId === "admission_planner") return admissionPlannerSemanticOutputSchema(commandNames);
  if (stageId === "admission_reviewer") return ADMISSION_REVIEWER_SEMANTIC_OUTPUT_SCHEMA;
  throw new Error(`unsupported admission semantic stage ${stageId}`);
}

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PRODUCER_SKILL_REFERENCE = /^(?:builtin:\/\/[a-z][a-z0-9]*(?:[._/@-][a-z0-9]+)*@\d+|repo:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}#(?:(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+\/)*(?!\.{1,2}$)[A-Za-z0-9._-]+)$/;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function objectAt(value, path, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, "unknown field");
  }
  return value;
}

function stringAt(value, path, { max = 512, pattern, sanitize }) {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
  const sanitized = sanitize(value).trim();
  if (!sanitized) fail(path, "must be a non-empty string");
  if (sanitized.length > max) fail(path, `must be at most ${max} characters`);
  if (pattern && !pattern.test(sanitized)) fail(path, "has an invalid format");
  return sanitized;
}

function arrayAt(value, path, parse, { min = 0, max }) {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length < min || value.length > max) fail(path, `must contain between ${min} and ${max} entries`);
  return value.map((entry, index) => parse(entry, `${path}[${index}]`));
}

function enumAt(value, path, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) fail(path, `must be one of: ${allowed.join(", ")}`);
  return value;
}

function nullable(value, parse) {
  return value === null ? null : parse(value);
}

function normalizedContract(value) {
  const normalized = canonicalJson(value);
  return { value, normalized, digest: digest(normalized) };
}

function digestAt(value, path, sanitize) {
  return stringAt(value, path, { pattern: SHA256, sanitize });
}

function textList(value, path, options, sanitize) {
  return arrayAt(value, path, (entry, entryPath) => stringAt(entry, entryPath, {
    max: options.itemMax,
    sanitize,
  }), options);
}

function identifierList(value, path, options, sanitize) {
  const identifiers = arrayAt(value, path, (entry, entryPath) => stringAt(entry, entryPath, {
    pattern: IDENTIFIER,
    sanitize,
  }), options);
  if (new Set(identifiers).size !== identifiers.length) fail(path, "must not contain duplicates");
  return identifiers;
}

function assertDistinctDigests(value, path) {
  if (value.effective_manifest_digest === value.admission_basis_digest) {
    fail(`${path}.effective_manifest_digest`, "must be distinct from admission_basis_digest");
  }
  if (value.generated_plan_digest !== null && (
    value.generated_plan_digest === value.admission_basis_digest ||
    value.generated_plan_digest === value.effective_manifest_digest
  )) {
    fail(`${path}.generated_plan_digest`, "must be distinct from admission_basis_digest and effective_manifest_digest");
  }
}

function validatorOptions(options) {
  return {
    source: options.source,
    sanitize: options.sanitize ?? ((value) => String(value)),
  };
}

export function validateAdmissionDecision(value, options = {}) {
  const { source = "admission_decision", sanitize } = validatorOptions(options);
  const input = objectAt(value, source, [
    "schema", "route", "rationale", "questions", "admission_basis_digest",
    "effective_manifest_digest", "generated_plan_digest",
  ]);
  if (input.schema !== "openthrottle.admission-decision/v1") {
    fail(`${source}.schema`, "must be openthrottle.admission-decision/v1");
  }
  const decision = {
    schema: "openthrottle.admission-decision/v1",
    route: enumAt(input.route, `${source}.route`, ["simple", "structured", "needs_human"]),
    rationale: stringAt(input.rationale, `${source}.rationale`, { max: 4_000, sanitize }),
    questions: textList(input.questions, `${source}.questions`, { max: 16, itemMax: 1_000 }, sanitize),
    admission_basis_digest: digestAt(input.admission_basis_digest, `${source}.admission_basis_digest`, sanitize),
    effective_manifest_digest: digestAt(input.effective_manifest_digest, `${source}.effective_manifest_digest`, sanitize),
    generated_plan_digest: nullable(input.generated_plan_digest, (entry) =>
      digestAt(entry, `${source}.generated_plan_digest`, sanitize)),
  };
  assertDistinctDigests(decision, source);
  if ((decision.route === "structured") !== (decision.generated_plan_digest !== null)) {
    fail(`${source}.generated_plan_digest`, `is inconsistent with route ${decision.route}`);
  }
  if ((decision.route === "needs_human") !== (decision.questions.length > 0)) {
    fail(`${source}.questions`, `are inconsistent with route ${decision.route}`);
  }
  return normalizedContract(decision);
}

function reviewFindings(value, path, sanitize) {
  return arrayAt(value, path, (entry, entryPath) => {
    const input = objectAt(entry, entryPath, ["severity", "message", "path"]);
    return {
      severity: enumAt(input.severity, `${entryPath}.severity`, ["P0", "P1", "P2", "P3"]),
      message: stringAt(input.message, `${entryPath}.message`, { max: 2_000, sanitize }),
      ...(input.path === undefined ? {} : {
        path: stringAt(input.path, `${entryPath}.path`, { max: 300, sanitize }),
      }),
    };
  }, { max: 64 });
}

export function validateAdmissionReview(value, options = {}) {
  const { source = "admission_review", sanitize } = validatorOptions(options);
  const input = objectAt(value, source, [
    "schema", "verdict", "summary", "findings", "questions",
    "admission_basis_digest", "effective_manifest_digest", "generated_plan_digest",
  ]);
  if (input.schema !== "openthrottle.admission-review/v1") {
    fail(`${source}.schema`, "must be openthrottle.admission-review/v1");
  }
  const review = {
    schema: "openthrottle.admission-review/v1",
    verdict: enumAt(input.verdict, `${source}.verdict`, ["approved", "rejected", "needs_human"]),
    summary: stringAt(input.summary, `${source}.summary`, { max: 4_000, sanitize }),
    findings: reviewFindings(input.findings, `${source}.findings`, sanitize),
    questions: textList(input.questions, `${source}.questions`, { max: 16, itemMax: 1_000 }, sanitize),
    admission_basis_digest: digestAt(input.admission_basis_digest, `${source}.admission_basis_digest`, sanitize),
    effective_manifest_digest: digestAt(input.effective_manifest_digest, `${source}.effective_manifest_digest`, sanitize),
    generated_plan_digest: digestAt(input.generated_plan_digest, `${source}.generated_plan_digest`, sanitize),
  };
  assertDistinctDigests(review, source);
  if (review.verdict === "approved" && (review.findings.length !== 0 || review.questions.length !== 0)) {
    fail(`${source}.verdict`, "approved reviews must have no findings or questions");
  }
  if (review.verdict === "rejected" && review.findings.length === 0) {
    fail(`${source}.findings`, "must contain between 1 and 64 entries for rejected");
  }
  if ((review.verdict === "needs_human") !== (review.questions.length > 0)) {
    fail(`${source}.questions`, `are inconsistent with verdict ${review.verdict}`);
  }
  return normalizedContract(review);
}

function parseExecutionPlanUnit(value, path, sanitize) {
  const input = objectAt(value, path, [
    "id", "title", "depends_on", "objective", "requirements", "files",
    "approach", "tests", "acceptance", "verification",
  ]);
  return {
    id: stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER, sanitize }),
    title: stringAt(input.title, `${path}.title`, { max: 160, sanitize }),
    depends_on: identifierList(input.depends_on, `${path}.depends_on`, { max: 32 }, sanitize),
    objective: stringAt(input.objective, `${path}.objective`, { max: 2_000, sanitize }),
    requirements: textList(input.requirements, `${path}.requirements`, { min: 1, max: 32, itemMax: 2_000 }, sanitize),
    files: textList(input.files, `${path}.files`, { min: 1, max: 64, itemMax: 512 }, sanitize),
    approach: textList(input.approach, `${path}.approach`, { min: 1, max: 32, itemMax: 2_000 }, sanitize),
    tests: textList(input.tests, `${path}.tests`, { min: 1, max: 32, itemMax: 2_000 }, sanitize),
    acceptance: textList(input.acceptance, `${path}.acceptance`, { min: 1, max: 32, itemMax: 2_000 }, sanitize),
    verification: textList(input.verification, `${path}.verification`, { min: 1, max: 32, itemMax: 2_000 }, sanitize),
  };
}

function assertAcyclic(units, source) {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) fail(source, "must be acyclic");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const unit of units) visit(unit.id);
}

export function validateExecutionPlanV2(value, options = {}) {
  const { source = "execution_plan", sanitize } = validatorOptions(options);
  const input = objectAt(value, source, ["schema", "graph_id", "plan_id", "units", "commands"]);
  if (input.schema !== "openthrottle.execution-plan/v2") {
    fail(`${source}.schema`, "must be openthrottle.execution-plan/v2");
  }
  const plan = {
    schema: "openthrottle.execution-plan/v2",
    graph_id: stringAt(input.graph_id, `${source}.graph_id`, { pattern: IDENTIFIER, sanitize }),
    plan_id: stringAt(input.plan_id, `${source}.plan_id`, { pattern: IDENTIFIER, sanitize }),
    units: arrayAt(input.units, `${source}.units`, (entry, entryPath) =>
      parseExecutionPlanUnit(entry, entryPath, sanitize), { min: 1, max: 64 }),
    commands: arrayAt(input.commands, `${source}.commands`, (entry, entryPath) => {
      const command = objectAt(entry, entryPath, ["name", "unit"]);
      return {
        name: stringAt(command.name, `${entryPath}.name`, { max: 80, pattern: COMMAND_NAME, sanitize }),
        ...(command.unit === undefined ? {} : {
          unit: stringAt(command.unit, `${entryPath}.unit`, { pattern: IDENTIFIER, sanitize }),
        }),
      };
    }, { max: 16 }),
  };
  const units = new Map(plan.units.map((unit) => [unit.id, unit]));
  if (units.size !== plan.units.length) fail(`${source}.units`, "must not contain duplicate IDs");
  for (const unit of plan.units) {
    for (const dependency of unit.depends_on) {
      if (!units.has(dependency)) fail(`${source}.units.${unit.id}.depends_on`, "references an unknown unit");
    }
  }
  for (const command of plan.commands) {
    if (command.unit && !units.has(command.unit)) fail(`${source}.commands.${command.name}.unit`, "references an unknown unit");
  }
  assertAcyclic(plan.units, `${source}.units`);
  const validated = normalizedContract(plan);
  if (Buffer.byteLength(validated.normalized, "utf8") > EXECUTION_PLAN_V2_MAX_BYTES) {
    fail(source, `canonical JSON must contain at most ${EXECUTION_PLAN_V2_MAX_BYTES} UTF-8 bytes`);
  }
  return validated;
}

function parseProducer(value, path, sanitize) {
  const input = objectAt(value, path, ["skill", "capability_digest", "skill_package_digest"]);
  const producer = {
    skill: stringAt(input.skill, `${path}.skill`, { max: 320, pattern: PRODUCER_SKILL_REFERENCE, sanitize }),
    capability_digest: digestAt(input.capability_digest, `${path}.capability_digest`, sanitize),
    skill_package_digest: nullable(input.skill_package_digest, (entry) =>
      digestAt(entry, `${path}.skill_package_digest`, sanitize)),
  };
  if (producer.skill.startsWith("builtin://") && producer.skill_package_digest !== null) {
    fail(`${path}.skill_package_digest`, "must be null for builtin skills");
  }
  if (producer.skill.startsWith("repo://") && producer.skill_package_digest === null) {
    fail(`${path}.skill_package_digest`, "must be present for repository skills");
  }
  return producer;
}

export function validateAdmissionExecutionPlanArtifact(value, options = {}) {
  const { source = "admission_execution_plan_artifact", sanitize } = validatorOptions(options);
  const input = objectAt(value, source, [
    "schema", "execution_plan", "generated_plan_digest", "producer", "assurance", "source",
  ]);
  if (input.schema !== "openthrottle.admission-execution-plan-artifact/v1") {
    fail(`${source}.schema`, "must be openthrottle.admission-execution-plan-artifact/v1");
  }
  const plan = validateExecutionPlanV2(input.execution_plan, {
    source: `${source}.execution_plan`,
    sanitize,
  });
  if (plan.value.graph_id !== "structured") fail(`${source}.execution_plan.graph_id`, "must be structured");
  const sourceInput = objectAt(input.source, `${source}.source`, [
    "admission_basis_digest", "effective_manifest_digest", "request_hash",
  ]);
  const artifact = {
    schema: "openthrottle.admission-execution-plan-artifact/v1",
    execution_plan: plan.value,
    generated_plan_digest: digestAt(input.generated_plan_digest, `${source}.generated_plan_digest`, sanitize),
    producer: parseProducer(input.producer, `${source}.producer`, sanitize),
    assurance: enumAt(input.assurance, `${source}.assurance`, ["semantic_attested", "executor_verified"]),
    source: {
      admission_basis_digest: digestAt(sourceInput.admission_basis_digest, `${source}.source.admission_basis_digest`, sanitize),
      effective_manifest_digest: digestAt(sourceInput.effective_manifest_digest, `${source}.source.effective_manifest_digest`, sanitize),
      request_hash: digestAt(sourceInput.request_hash, `${source}.source.request_hash`, sanitize),
    },
  };
  if (artifact.generated_plan_digest !== plan.digest) {
    fail(`${source}.generated_plan_digest`, "does not match the canonical execution plan digest");
  }
  assertDistinctDigests({
    admission_basis_digest: artifact.source.admission_basis_digest,
    effective_manifest_digest: artifact.source.effective_manifest_digest,
    generated_plan_digest: artifact.generated_plan_digest,
  }, `${source}.source`);
  const validated = normalizedContract(artifact);
  if (Buffer.byteLength(validated.normalized, "utf8") > ADMISSION_EXECUTION_PLAN_ARTIFACT_MAX_BYTES) {
    fail(source, `canonical JSON must contain at most ${ADMISSION_EXECUTION_PLAN_ARTIFACT_MAX_BYTES} UTF-8 bytes`);
  }
  return validated;
}
