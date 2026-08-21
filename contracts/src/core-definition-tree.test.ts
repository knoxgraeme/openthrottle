import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RELEASE_COMPILER_ENVIRONMENT_DIGEST,
  RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
  compileDefinitionBundle,
  deriveTrustedPlatformDefinitionHashes,
  verifyCompilerEnvironment,
  verifyPlatformDefinitionSource,
  type CompilerEnvironmentDescriptor,
  type DefinitionBundleEntry,
  type DefinitionCompilation,
  type PlatformDefinitionCatalog,
  type TrustedPlatformDefinitionSource,
  type VirtualDefinitionFile,
} from "./index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const definitionRoot = join(repositoryRoot, ".openthrottle");
const sourceCommit = "a".repeat(40);
const generatedRoot = join(repositoryRoot, "contracts/generated");
const platformCatalog = JSON.parse(readFileSync(
  join(generatedRoot, "platform-definition-catalog.json"),
  "utf8",
)) as PlatformDefinitionCatalog;
const compilerEnvironmentDescriptor = JSON.parse(readFileSync(
  join(generatedRoot, "compiler-environment.json"),
  "utf8",
)) as CompilerEnvironmentDescriptor;
const parityGolden = JSON.parse(readFileSync(
  join(repositoryRoot, "contracts/fixtures/definition-compiler/committed-golden.json"),
  "utf8",
)) as {
  source_commit: string;
  bundle_digest: string;
  manifest_digest: string;
};

const agentIds = [
  "admission-planner",
  "admission-reviewer",
  "investigator",
  "ordinary-worker",
  "reviewer",
  "unit-lead",
  "unit-worker",
] as const;

const pipelineIds = ["implement", "investigate", "structured", "admission"] as const;

const skillIds = [
  "accept-unit",
  "admission-plan",
  "agent-native-contracts",
  "correctness-dataflow",
  "data-migration",
  "final-repair",
  "implement-plan",
  "implement-unit",
  "investigate",
  "performance",
  "project-standards",
  "reliability-adversarial",
  "repair-unit",
  "review-admission-plan",
  "review-change",
  "security",
  "select-review-personas",
  "simplify-change",
  "simplify-unit",
  "tests-contracts",
  "validate-review-findings",
] as const;

function filesBelow(root: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error(`${path}: definition fixtures must contain only regular files`);
    }
  };
  visit(root);
  return paths;
}

function definitionFiles(): Map<string, VirtualDefinitionFile> {
  return new Map(filesBelow(definitionRoot).map((path) => [
    `.openthrottle/${relative(definitionRoot, path)}`,
    { type: "file", content: readFileSync(path) },
  ]));
}

function sealedPlatform(files = definitionFiles()): TrustedPlatformDefinitionSource {
  files.delete(".openthrottle/config.yml");
  return verifyPlatformDefinitionSource(
    platformCatalog,
    files,
    RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
  );
}

function compile(pipelineId: (typeof pipelineIds)[number]) {
  const files = definitionFiles();
  const configPath = ".openthrottle/config.yml";
  const authoredConfig = files.get(configPath);
  if (!authoredConfig || authoredConfig.type !== "file") throw new Error(`${configPath}: missing regular file`);
  const config = Buffer.from(authoredConfig.content).toString("utf8");
  const selectedConfig = config.replace(/^pipeline: .*$/m, `pipeline: core/${pipelineId}`);
  if (selectedConfig === config && pipelineId !== "implement") {
    throw new Error(`${configPath}: did not contain an overridable pipeline selection`);
  }
  const repository = new Map<string, VirtualDefinitionFile>([[
    configPath,
    { type: "file", content: selectedConfig },
  ]]);
  return compileDefinitionBundle({
    repository: { source_commit: sourceCommit, files: repository },
    platform: sealedPlatform(files),
    compiler_environment: verifyCompilerEnvironment(
      compilerEnvironmentDescriptor,
      RELEASE_COMPILER_ENVIRONMENT_DIGEST,
    ),
    selected_pipeline: `core/${pipelineId}`,
  });
}

function skillEntryFiles(entry: DefinitionBundleEntry): Array<{ path: string; content: string }> {
  const payload = entry.normalized_payload as { files?: Array<{ path: string; content: string }> };
  return (payload.files ?? []).map(({ path, content }) => ({ path, content }));
}

function agentBindings(result: DefinitionCompilation): Array<[string, string, string]> {
  return result.manifest.value.stages.flatMap((stage) => stage.kind === "agent"
    ? [[stage.id, stage.agent_id, stage.repository_authority]]
    : []);
}

describe("root .openthrottle definition tree", () => {
  it("contains exactly the canonical filesystem inventory and no retired root config", () => {
    const actual = filesBelow(definitionRoot)
      .map((path) => relative(definitionRoot, path));
    const expected = [
      "config.yml",
      ...platformCatalog.files.map(({ path }) => path.slice(".openthrottle/".length)),
    ].sort();

    expect(actual).toEqual(expected);
    expect(existsSync(join(repositoryRoot, ".openthrottle.yml"))).toBe(false);
  });

  it("matches the release-sealed catalog before interpreting any platform definition", () => {
    const trusted = sealedPlatform();
    const actual = new Set([...trusted.files.keys()].map((path) => path.slice(".openthrottle/".length)));
    expect(trusted.catalog.files).toHaveLength(49);
    expect([...actual].filter((path) => path.startsWith("agents/") && path.endsWith("/instructions.md")))
      .toEqual(agentIds.map((id) => `agents/core/${id}/instructions.md`));
    expect([...actual].filter((path) => path.endsWith("/pipeline.yml")))
      .toEqual([...pipelineIds].sort().map((id) => `pipelines/core/${id}/pipeline.yml`));
    expect([...actual].filter((path) => path.endsWith("/eval.yml")))
      .toEqual([
        "evals/core/action-result/eval.yml",
        "evals/core/admission-result/eval.yml",
        "evals/core/admission-review-result/eval.yml",
        "evals/core/persona-selection/eval.yml",
        "evals/core/review-result/eval.yml",
        "evals/core/unit-result/eval.yml",
      ]);
    expect([...actual].filter((path) => path.endsWith("/SKILL.md")))
      .toEqual(skillIds.map((id) => `skills/core/${id}/SKILL.md`));
    expect(actual.has("pipelines/core/structured/loops/unit-cycle.yml")).toBe(true);
    expect([...actual].some((path) => path.includes("/agents/openai.yaml"))).toBe(false);
    expect(actual.has("config.yml")).toBe(false);
  });

  it("derives recovery trust from every normalized release definition", () => {
    const trusted = sealedPlatform();
    const hashes = deriveTrustedPlatformDefinitionHashes({
      platform: trusted,
      compiler_environment: verifyCompilerEnvironment(
        compilerEnvironmentDescriptor,
        RELEASE_COMPILER_ENVIRONMENT_DIGEST,
      ),
    });

    expect(hashes.size).toBe(39);
    for (const result of pipelineIds.map((id) => compile(id))) {
      for (const definition of result.bundle.value.entries) {
        if (definition.origin.kind !== "platform") continue;
        expect(hashes.get(`${definition.definition_kind}:${definition.definition_id}`))
          .toBe(definition.content_hash);
      }
    }
  });

  it("keeps built-in skill craft free of legacy model-authored result protocols", () => {
    const skillRoot = join(definitionRoot, "skills/core");
    const forbidden = [
      { label: "receipt terminology", pattern: /receipt/i },
      { label: "stage-proposal schema", pattern: /openthrottle\.stage-proposal/i },
      { label: "stage-result tool", pattern: /ot-stage-result/i },
      { label: "stage-proposal output path", pattern: /ot_stage_proposal_file/i },
      {
        label: "executor-owned identity field",
        pattern: /\b(?:request_hash|definition_bundle_hash|native_session_id|assurance|producer)\b/i,
      },
      { label: "model-authored output envelope", pattern: /\breturn exactly\b/i },
    ];
    const matches = filesBelow(skillRoot).flatMap((path) => {
      const content = readFileSync(path, "utf8");
      return forbidden
        .filter(({ pattern }) => pattern.test(content))
        .map(({ label }) => `${relative(skillRoot, path)}: ${label}`);
    });

    expect(matches).toEqual([]);
  });

  it("compiles all four pipeline selections from the actual tree", () => {
    const results = pipelineIds.map((id) => compile(id));
    expect(results.map((result) => result.bundle.value.pipeline_id)).toEqual([
      "core/implement",
      "core/investigate",
      "core/structured",
      "core/admission",
    ]);
    for (const result of results) {
      const config = result.bundle.value.entries.find((entry) => entry.definition_kind === "config");
      expect(config?.origin).toEqual({ kind: "repository", source_commit: sourceCommit });
      expect(result.bundle.value.entries.filter((entry) => entry.definition_kind !== "config")
        .every((entry) => entry.origin.kind === "platform" && entry.origin.source_commit === null))
        .toBe(true);
      expect(result.manifest.value.definition_bundle_hash).toBe(result.bundle.digest);

      const evalEntries = new Map(result.bundle.value.entries
        .filter((entry) => entry.definition_kind === "eval")
        .map((entry) => [entry.definition_id, entry.normalized_payload as {
          evaluator: string;
          result: unknown;
        }]));
      for (const stage of result.manifest.value.stages) {
        if (stage.kind !== "agent") continue;
        const evaluation = evalEntries.get(stage.eval);
        expect(evaluation, `${stage.id} eval ${stage.eval}`).toBeDefined();
        const outcomes = new Set((evaluation!.result as { outcomes: string[] }).outcomes);
        expect([...Object.keys(stage.on)].sort(), `${stage.id} outcomes`)
          .toEqual([...outcomes].sort());
      }

      for (const entry of result.bundle.value.entries.filter((candidate) => candidate.definition_kind === "skill")) {
        const copiedDirectory = join(definitionRoot, entry.path.slice(".openthrottle/".length, -"SKILL.md".length));
        const supportFiles = filesBelow(copiedDirectory)
          .filter((path) => !path.endsWith("/SKILL.md"))
          .map((path) => ({
            path: relative(copiedDirectory, path),
            content: readFileSync(path, "utf8"),
          }));
        expect(skillEntryFiles(entry)).toEqual(supportFiles);
      }
    }

    // Admission definitions are selected only by the admission pipeline, not
    // ambient dependencies of an executable task pipeline.
    const selectedIdentities = new Set(results.flatMap((result) => result.bundle.value.entries)
      .map((entry) => `${entry.definition_kind}:${entry.definition_id}`));
    expect(selectedIdentities.has("agent:core/admission-planner")).toBe(true);
    expect(selectedIdentities.has("agent:core/admission-reviewer")).toBe(true);
    expect(selectedIdentities.has("skill:core/admission-plan")).toBe(true);
    expect(selectedIdentities.has("skill:core/review-admission-plan")).toBe(true);

    const evals = new Map(results.flatMap((result) => result.bundle.value.entries)
      .filter((entry) => entry.definition_kind === "eval")
      .map((entry) => [entry.definition_id, entry.normalized_payload as {
        evaluator: string;
        result: unknown;
      }]));
    expect([...evals].map(([id, evaluation]) => [id, evaluation.evaluator]).sort())
      .toEqual([
        ["core/action-result", "core/action-outcome@1"],
        ["core/admission-result", "core/admission-outcome@1"],
        ["core/admission-review-result", "core/admission-review-outcome@1"],
        ["core/persona-selection", "core/action-outcome@1"],
        ["core/review-result", "core/review-outcome@1"],
        ["core/unit-result", "core/unit-outcome@1"],
      ]);

    expect(agentBindings(results[0]!)).toEqual([
      ["implement", "core/ordinary-worker", "edit"],
      ["repair", "core/ordinary-worker", "edit"],
      ["review", "core/reviewer", "inspect"],
      ["simplify", "core/ordinary-worker", "edit"],
      ["post_simplify_review", "core/reviewer", "inspect"],
    ]);
    expect(agentBindings(results[1]!)).toEqual([
      ["investigate", "core/investigator", "edit"],
    ]);
    expect(agentBindings(results[2]!)).toEqual([
      ["implement_unit", "core/unit-worker", "edit"],
      ["simplify_unit", "core/unit-worker", "edit"],
      ["accept_unit", "core/unit-lead", "inspect"],
      ["repair_unit", "core/unit-worker", "edit"],
      ["select_review_personas", "core/reviewer", "inspect"],
      ["persona_review", "core/reviewer", "inspect"],
      ["validate_review_findings", "core/reviewer", "inspect"],
      ["final_repair", "core/ordinary-worker", "edit"],
    ]);
    expect(agentBindings(results[3]!)).toEqual([
      ["plan", "core/admission-planner", "inspect"],
      ["review", "core/admission-reviewer", "inspect"],
    ]);
    const structured = results[2]!;
    expect(structured.manifest.value.stages.find((stage) => stage.id === "accept_unit"))
      .toMatchObject({ eval: "core/action-result" });
    expect(structured.manifest.value.stages.find((stage) => stage.id === "select_review_personas"))
      .toMatchObject({ eval: "core/persona-selection" });
    expect(results.map((result) => result.manifest.value.stages
      .filter((stage) => !stage.id.startsWith("ot_runtime_"))
      .flatMap((stage) =>
      stage.kind === "effect" ? [stage.effect] : stage.kind === "wait" ? [stage.wait] : [])))
      .toEqual([
        ["core/publish@1", "core/provider-wait@1"],
        ["core/publish@1", "core/provider-wait@1"],
        ["core/integrate-unit@1", "core/publish@1", "core/provider-wait@1"],
        ["kernel/promote-admission@1"],
      ]);
    for (const result of results) {
      expect(result.manifest.value.entry_stage).toBe("ot_runtime_provision");
      expect(result.manifest.value.stages.find(({ id }) => id === "ot_runtime_provision"))
        .toMatchObject({ kind: "effect", effect: "core/daytona-provision@1" });
      expect(result.manifest.value.stages.some((stage) =>
        stage.kind === "effect" && stage.effect === "core/daytona-stop@1")).toBe(true);
      expect(result.manifest.value.stages.some((stage) =>
        stage.kind === "effect" && stage.effect === "core/daytona-cleanup@1")).toBe(true);
    }
    expect(structured.manifest.value.stages.find((stage) => stage.id === "implement_unit")?.loop)
      .toMatchObject({
        over: "execution_plan.units",
        body: [
          "implement_unit",
          "simplify_unit",
          "unit_test",
          "unit_lint",
          "unit_build",
          "accept_unit",
          "repair_unit",
          "integrate_unit",
        ],
      });
    const personaReview = structured.manifest.value.stages.find((stage) => stage.id === "persona_review");
    expect(personaReview).not.toHaveProperty("entry_skill");
    expect(personaReview).toMatchObject({
      kind: "agent",
      skills: [
        "core/correctness-dataflow",
        "core/tests-contracts",
        "core/reliability-adversarial",
        "core/agent-native-contracts",
        "core/security",
        "core/data-migration",
        "core/performance",
        "core/project-standards",
      ],
      loop: { over: "selection.personas", body: ["persona_review"] },
    });
  });

  it("matches the committed cross-environment compiler golden", () => {
    const config = readFileSync(join(
      repositoryRoot,
      "contracts/fixtures/definition-compiler/committed-repository/.openthrottle/config.yml",
    ));
    const result = compileDefinitionBundle({
      repository: {
        source_commit: parityGolden.source_commit,
        files: new Map([[".openthrottle/config.yml", { type: "file", content: config }]]),
      },
      platform: sealedPlatform(),
      compiler_environment: verifyCompilerEnvironment(
        compilerEnvironmentDescriptor,
        RELEASE_COMPILER_ENVIRONMENT_DIGEST,
      ),
    });

    expect(result.bundle.digest).toBe(parityGolden.bundle_digest);
    expect(result.manifest.digest).toBe(parityGolden.manifest_digest);
  });
});
