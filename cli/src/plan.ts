import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseExecutionPlanContractV2,
  validateFilesystemConfigContract,
  type DefinitionCompilation,
  type ExecutionPlanContractV2,
  type FilesystemConfigContract,
  type ValidatedContract,
} from "@openthrottle/contracts";
import { compileLocalPipeline } from "./definition-compilation.js";
import { getErrorMessage } from "./util.js";

export const EXECUTION_PLAN_FENCE = "openthrottle.execution-plan/v2";

export interface ExecutionPlanBlock {
  json: string;
  schema: string;
  start: number;
  end: number;
}

export interface ValidationResult {
  plan: ValidatedContract<ExecutionPlanContractV2>;
  coverage: {
    units: number;
    commands: string[];
    schema: typeof EXECUTION_PLAN_FENCE;
    requirement_count: number;
    file_count: number;
    test_count: number;
    acceptance_count: number;
    verification_count: number;
  };
}

export interface LocalPipelineSelection {
  compilation: DefinitionCompilation;
  config: ValidatedContract<FilesystemConfigContract>;
  pipelineId: string;
  consumesUnits: boolean;
}

export interface PipelinePlanValidation {
  pipeline: LocalPipelineSelection;
  plan?: ValidationResult;
}

export interface CompileLocalPipelineInput {
  repositoryRoot?: string;
  expectedPipeline?: string;
}

export type LocalPipelineCompiler = (input?: CompileLocalPipelineInput) => DefinitionCompilation;

export interface PrepareRunnerInput {
  engine: "claude" | "codex" | "opencode";
  model?: string;
  prompt: string;
  directory: string;
  targetFile?: string;
}

export type PrepareRunner = (input: PrepareRunnerInput) => SpawnSyncReturns<Buffer>;

const FENCE_PATTERN = /```([^\n`]*)\n([\s\S]*?)```/g;
const PREPARE_RUNNER_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export function resolvePrepareSkillPath(moduleUrl = import.meta.url): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const packaged = join(moduleDirectory, "skills", "planning", "prepare-execution-plan", "SKILL.md");
  if (existsSync(packaged)) return packaged;
  return resolve(moduleDirectory, "..", "..", "skills", "planning", "prepare-execution-plan", "SKILL.md");
}

function prepareSkillReferencePath(skillPath: string): string {
  return join(dirname(skillPath), "references", "execution-plan.md");
}

function redactCommand(command: string, args: string[], prompt?: string): string {
  return [command, ...args]
    .map((part) => prompt && part === prompt ? "<prompt>" : part)
    .map((part) => /\s/.test(part) ? JSON.stringify(part) : part)
    .join(" ");
}

export function extractExecutionPlanBlocks(markdown: string): ExecutionPlanBlock[] {
  const blocks: ExecutionPlanBlock[] = [];
  for (const match of markdown.matchAll(FENCE_PATTERN)) {
    const marker = match[1]?.trim().split(/\s+/) ?? [];
    if (!marker.includes(EXECUTION_PLAN_FENCE)) continue;
    const json = match[2]?.trim() ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch {
      throw new Error(`${EXECUTION_PLAN_FENCE} block must contain valid JSON`);
    }
    const payloadSchema = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { schema?: unknown }).schema
      : undefined;
    if (payloadSchema !== EXECUTION_PLAN_FENCE) {
      throw new Error(`${EXECUTION_PLAN_FENCE} block payload schema must be ${EXECUTION_PLAN_FENCE}`);
    }
    blocks.push({
      json,
      schema: EXECUTION_PLAN_FENCE,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  return blocks;
}

function coverageFor(plan: ExecutionPlanContractV2): ValidationResult["coverage"] {
  return {
    schema: EXECUTION_PLAN_FENCE,
    units: plan.units.length,
    requirement_count: plan.units.reduce((count, unit) => count + unit.requirements.length, 0),
    file_count: plan.units.reduce((count, unit) => count + unit.files.length, 0),
    test_count: plan.units.reduce((count, unit) => count + unit.tests.length, 0),
    acceptance_count: plan.units.reduce((count, unit) => count + unit.acceptance.length, 0),
    verification_count: plan.units.reduce((count, unit) => count + unit.verification.length, 0),
    commands: plan.commands.map((command) => command.name),
  };
}

export function readExecutionPlanFromMarkdown(
  markdown: string,
  source = "plan",
): ValidationResult {
  const blocks = extractExecutionPlanBlocks(markdown);
  if (blocks.length !== 1) {
    throw new Error(`${source}: expected exactly one execution-plan block, found ${blocks.length}`);
  }
  const plan = parseExecutionPlanContractV2(blocks[0]!.json, {
    source: `${source}.execution_plan`,
  });
  return { plan, coverage: coverageFor(plan.value) };
}

function configFromCompilation(
  compilation: DefinitionCompilation,
): ValidatedContract<FilesystemConfigContract> {
  const entry = compilation.bundle.value.entries.find((candidate) =>
    candidate.definition_kind === "config" && candidate.definition_id === "repository");
  if (!entry) throw new Error("compiled definition bundle is missing repository config");
  return validateFilesystemConfigContract(entry.normalized_payload, {
    source: ".openthrottle/config.yml",
  });
}

export function validateLocalPipelineSelection(
  options: {
    pipelineId?: string;
    directory?: string;
    compiler?: LocalPipelineCompiler;
  } = {},
): LocalPipelineSelection {
  const directory = options.directory ?? process.cwd();
  const compilation = (options.compiler ?? compileLocalPipeline)({
    repositoryRoot: directory,
    ...(options.pipelineId === undefined ? {} : { expectedPipeline: options.pipelineId }),
  });
  const config = configFromCompilation(compilation);
  const pipelineId = compilation.manifest.value.pipeline_id;
  if (config.value.pipeline !== pipelineId) {
    throw new Error(`compiled pipeline ${pipelineId} does not match config pipeline ${config.value.pipeline}`);
  }
  return {
    compilation,
    config,
    pipelineId,
    consumesUnits: compilation.manifest.value.stages.some(
      (stage) => stage.loop?.over === "execution_plan.units",
    ),
  };
}

export function validatePlanContentForPipeline(
  markdown: string,
  source: string,
  pipeline: LocalPipelineSelection,
): ValidationResult | undefined {
  const blocks = extractExecutionPlanBlocks(markdown);
  if (!pipeline.consumesUnits) {
    if (blocks.length > 0) {
      throw new Error(
        `${source}: pipeline ${pipeline.pipelineId} does not consume execution_plan.units; remove the execution-plan block`,
      );
    }
    return undefined;
  }
  const plan = readExecutionPlanFromMarkdown(markdown, source);
  if (plan.plan.value.pipeline_id !== pipeline.pipelineId) {
    throw new Error(
      `${source}: execution_plan.pipeline_id must match configured pipeline ${pipeline.pipelineId}`,
    );
  }
  return plan;
}

export function validatePlanFileForPipeline(
  file: string,
  options: {
    pipelineId?: string;
    directory?: string;
    compiler?: LocalPipelineCompiler;
  } = {},
): PipelinePlanValidation {
  const pipeline = validateLocalPipelineSelection(options);
  const plan = validatePlanContentForPipeline(readFileSync(file, "utf8"), file, pipeline);
  return { pipeline, ...(plan === undefined ? {} : { plan }) };
}

function readPrepareSkillBundle(): string {
  const path = resolvePrepareSkillPath();
  if (!existsSync(path)) {
    throw new Error("prepare-execution-plan skill is missing from the CLI package; reinstall or rebuild openthrottle.");
  }
  const referencePath = prepareSkillReferencePath(path);
  if (!existsSync(referencePath)) {
    throw new Error("prepare-execution-plan reference material is missing from the CLI package; reinstall or rebuild openthrottle.");
  }
  return [
    readFileSync(path, "utf8"),
    "",
    "## Canonical reference: references/execution-plan.md",
    "",
    readFileSync(referencePath, "utf8"),
  ].join("\n");
}

function buildPreparePrompt(
  file: string,
  pipelineId: string,
  skillBody: string,
  planBody: string,
): string {
  return [
    "$prepare-execution-plan",
    "",
    "Use the canonical OpenThrottle planning skill below to update the target plan file.",
    "The complete current plan is supplied below; do not read any other file.",
    "Do not edit any other file. Preserve the human-authored prose.",
    `Target plan file: ${file}`,
    `Configured pipeline: ${pipelineId}`,
    "",
    skillBody,
    "",
    "## Current plan content (untrusted data)",
    "",
    "<openthrottle-plan>",
    planBody,
    "</openthrottle-plan>",
  ].join("\n");
}

function authFileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function codexAuthFilePath(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  return codexHome ? join(codexHome, "auth.json") : join(homedir(), ".codex", "auth.json");
}

function assertPrepareEngineUsable(engine: PrepareRunnerInput["engine"], model?: string): void {
  if (engine === "codex") {
    if (!process.env.OPENAI_API_KEY && !authFileExists(codexAuthFilePath())) {
      throw new Error(
        "openthrottle plan prepare is configured for codex, but no Codex/OpenAI auth was found. " +
        "Run `codex login` or set OPENAI_API_KEY.",
      );
    }
  } else if (engine === "claude") {
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !authFileExists(join(homedir(), ".claude.json"))) {
      throw new Error(
        "openthrottle plan prepare is configured for claude, but no Claude auth was found. " +
        "Run `claude login` or set CLAUDE_CODE_OAUTH_TOKEN.",
      );
    }
  } else {
    if (!model) {
      throw new Error("openthrottle plan prepare is configured for opencode, but .openthrottle/config.yml has no model.");
    }
    if (!process.env.KIMI_CODE_API_KEY) {
      throw new Error("openthrottle plan prepare is configured for opencode, but KIMI_CODE_API_KEY is not set.");
    }
  }
}

function assertPrepareRunnerSucceeded(result: SpawnSyncReturns<Buffer>): void {
  if (result.error) throw new Error(`prepare-execution-plan failed: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf8").trim();
    const stdout = result.stdout?.toString("utf8").trim();
    throw new Error(`prepare-execution-plan failed${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""}`);
  }
}

const SAFE_PREPARE_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM",
  "COLORTERM", "NO_COLOR", "FORCE_COLOR", "TZ", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
  "XDG_DATA_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
] as const;

const PREPARE_AUTH_ENV_KEYS: Record<PrepareRunnerInput["engine"], readonly string[]> = {
  codex: ["OPENAI_API_KEY", "CODEX_HOME"],
  claude: ["CLAUDE_CODE_OAUTH_TOKEN"],
  opencode: ["KIMI_CODE_API_KEY"],
};

function prepareRunnerEnvironment(engine: PrepareRunnerInput["engine"]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...SAFE_PREPARE_ENV_KEYS, ...PREPARE_AUTH_ENV_KEYS[engine]]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function createOpenCodeConfig(model?: string): string {
  if (model !== "kimi-code/kimi-for-coding") {
    throw new Error(`Unsupported OpenCode model '${model ?? ""}'. Supported model: kimi-code/kimi-for-coding`);
  }
  const configDir = mkdtempSync(join(tmpdir(), "openthrottle-opencode-"));
  const config = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    permission: { "*": "deny", edit: "allow" },
    provider: {
      "kimi-code": {
        npm: "@ai-sdk/openai-compatible",
        name: "Kimi Code",
        options: {
          baseURL: "https://api.kimi.com/coding/v1",
          apiKey: "{env:KIMI_CODE_API_KEY}",
        },
        models: {
          "kimi-for-coding": {
            name: "kimi-for-coding",
            limit: { context: 262_144, output: 65_536 },
          },
        },
      },
    },
  };
  try {
    writeFileSync(join(configDir, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return configDir;
  } catch (error) {
    rmSync(configDir, { recursive: true, force: true });
    throw error;
  }
}

export const defaultPrepareRunner: PrepareRunner = ({ engine, model, prompt, directory }) => {
  let command: string;
  let args: string[];
  let input: string | undefined;
  if (engine === "codex") {
    command = "codex";
    args = [
      "exec", "--json", "--sandbox", "workspace-write",
      "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "shell_snapshot",
      "--disable", "apps", "--disable", "browser_use", "--disable", "in_app_browser",
      "--disable", "multi_agent", "--ignore-user-config", "--ignore-rules", "--ephemeral",
      "--skip-git-repo-check", "-C", directory, ...(model ? ["-m", model] : []), "-",
    ];
    input = prompt;
  } else if (engine === "claude") {
    command = "claude";
    args = [
      "-p", prompt, "--output-format", "stream-json", "--verbose", "--safe-mode",
      "--no-session-persistence", "--permission-mode", "acceptEdits", "--tools", "Edit",
      ...(model ? ["--model", model] : []),
    ];
  } else {
    command = "opencode";
    args = ["run", "--format", "json", "--model", model ?? "", "--dir", directory, "--auto", prompt];
  }
  const env = prepareRunnerEnvironment(engine);
  const engineHome = mkdtempSync(join(tmpdir(), "openthrottle-engine-home-"));
  env.HOME = engineHome;
  if (engine === "codex") {
    const sourceAuth = codexAuthFilePath();
    const isolatedCodexHome = join(engineHome, ".codex");
    mkdirSync(isolatedCodexHome, { recursive: true, mode: 0o700 });
    if (authFileExists(sourceAuth)) {
      writeFileSync(join(isolatedCodexHome, "auth.json"), readFileSync(sourceAuth), { mode: 0o600 });
    }
    env.CODEX_HOME = isolatedCodexHome;
  } else if (
    engine === "claude" && !env.CLAUDE_CODE_OAUTH_TOKEN && authFileExists(join(homedir(), ".claude.json"))
  ) {
    writeFileSync(join(engineHome, ".claude.json"), readFileSync(join(homedir(), ".claude.json")), {
      mode: 0o600,
    });
  }
  const openCodeConfigDir = engine === "opencode" ? createOpenCodeConfig(model) : undefined;
  if (openCodeConfigDir) env.OPENCODE_CONFIG_DIR = openCodeConfigDir;
  let result: SpawnSyncReturns<Buffer>;
  try {
    result = spawnSync(command, args, {
      cwd: directory,
      env,
      input,
      maxBuffer: PREPARE_RUNNER_MAX_BUFFER_BYTES,
      timeout: 30 * 60 * 1000,
    });
  } finally {
    if (openCodeConfigDir) rmSync(openCodeConfigDir, { recursive: true, force: true });
    rmSync(engineHome, { recursive: true, force: true });
  }
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error(
      `openthrottle plan prepare could not find ${command} on PATH; install the configured local engine or change engine in .openthrottle/config.yml.`,
    );
  }
  try {
    assertPrepareRunnerSucceeded(result);
  } catch {
    const stderr = result.stderr?.toString("utf8").trim();
    const stdout = result.stdout?.toString("utf8").trim();
    throw new Error(
      `prepare-execution-plan failed via ${redactCommand(command, args, prompt)}` +
      `${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""}`,
    );
  }
  return result;
};

function normalizedPlanProse(markdown: string): string {
  let prose = markdown;
  for (const block of [...extractExecutionPlanBlocks(markdown)].reverse()) {
    prose = prose.slice(0, block.start) + prose.slice(block.end);
  }
  return prose.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

function preservesPlanProse(before: string, after: string, hadPlan: boolean): boolean {
  const expected = normalizedPlanProse(before);
  const actual = normalizedPlanProse(after);
  if (actual === expected) return true;
  if (hadPlan) return false;
  return actual.replace(/(?:^|\n)## Execution Plan\s*$/, "").trim() === expected;
}

export function prepareExecutionPlanFile(
  file: string,
  options: {
    pipelineId?: string;
    directory?: string;
    compiler?: LocalPipelineCompiler;
    runner?: PrepareRunner;
  } = {},
): ValidationResult {
  const directory = options.directory ?? process.cwd();
  const pipeline = validateLocalPipelineSelection({
    directory,
    ...(options.pipelineId === undefined ? {} : { pipelineId: options.pipelineId }),
    ...(options.compiler === undefined ? {} : { compiler: options.compiler }),
  });
  if (!pipeline.consumesUnits) {
    throw new Error(
      `pipeline ${pipeline.pipelineId} does not consume execution_plan.units; configure a structured pipeline before plan prepare`,
    );
  }
  const { engine, model } = pipeline.config.value;
  assertPrepareEngineUsable(engine, model);
  const runner = options.runner ?? defaultPrepareRunner;
  const original = readFileSync(file, "utf8");
  const before = extractExecutionPlanBlocks(original);
  if (before.length > 1) {
    throw new Error(`${file}: expected at most one execution-plan block before prepare, found ${before.length}`);
  }
  const isolatedDirectory = mkdtempSync(join(tmpdir(), "openthrottle-prepare-"));
  const isolatedFile = join(isolatedDirectory, basename(file));
  writeFileSync(isolatedFile, original, { mode: 0o600 });
  const prompt = buildPreparePrompt(
    isolatedFile,
    pipeline.pipelineId,
    readPrepareSkillBundle(),
    original,
  );
  try {
    assertPrepareRunnerSucceeded(runner({
      engine,
      ...(model === undefined ? {} : { model }),
      prompt,
      directory: isolatedDirectory,
      targetFile: isolatedFile,
    }));
    const prepared = readFileSync(isolatedFile, "utf8");
    if (!preservesPlanProse(original, prepared, before.length === 1)) {
      throw new Error(`${file}: prepare modified content outside the execution-plan block`);
    }
    const result = readExecutionPlanFromMarkdown(prepared, file);
    if (result.plan.value.pipeline_id !== pipeline.pipelineId) {
      throw new Error(
        `${file}: execution_plan.pipeline_id must match configured pipeline ${pipeline.pipelineId}`,
      );
    }
    writeFileSync(file, prepared);
    return result;
  } finally {
    rmSync(isolatedDirectory, { recursive: true, force: true });
  }
}

function printValidation(
  result: PipelinePlanValidation | { pipelineId: string; plan: ValidationResult },
  json: boolean,
): void {
  const pipelineId = "pipeline" in result ? result.pipeline.pipelineId : result.pipelineId;
  const plan = result.plan;
  const body = {
    ok: true,
    pipeline_id: pipelineId,
    schema: plan?.plan.value.schema ?? null,
    digest: plan?.plan.digest ?? null,
    coverage: plan?.coverage ?? null,
  };
  if (json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  console.log(`ok pipeline=${pipelineId}`);
  if (!plan) {
    console.log("execution-plan not required");
    return;
  }
  console.log(`schema ${plan.plan.value.schema}`);
  console.log(`digest ${plan.plan.digest}`);
  const coverage = `coverage units=${plan.coverage.units} requirements=${plan.coverage.requirement_count} files=${plan.coverage.file_count} tests=${plan.coverage.test_count} acceptance=${plan.coverage.acceptance_count} verification=${plan.coverage.verification_count}`;
  console.log(coverage);
}

function exitWithError(message: string, json: boolean): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(message);
  process.exit(1);
}

export function parsePlanArgs(args: string[]): {
  command?: string;
  file?: string;
  pipelineId?: string;
  json: boolean;
} {
  const parsed: { command?: string; file?: string; pipelineId?: string; json: boolean } = {
    command: args[0],
    json: false,
  };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") parsed.json = true;
    else if (arg === "--pipeline") {
      parsed.pipelineId = args[++index];
      if (!parsed.pipelineId) throw new Error("--pipeline requires a pipeline ID");
    } else if (!parsed.file) parsed.file = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return parsed;
}

export async function plan(args: string[]): Promise<void> {
  let parsed: ReturnType<typeof parsePlanArgs>;
  try {
    parsed = parsePlanArgs(args);
    if (!parsed.command || !["prepare", "validate"].includes(parsed.command) || !parsed.file) {
      throw new Error(
        "Usage: openthrottle plan <prepare|validate> <file.md> [--pipeline <id>] [--json]",
      );
    }
    if (parsed.command === "prepare") {
      const prepared = prepareExecutionPlanFile(parsed.file, {
        ...(parsed.pipelineId === undefined ? {} : { pipelineId: parsed.pipelineId }),
      });
      printValidation({ pipelineId: prepared.plan.value.pipeline_id, plan: prepared }, parsed.json);
    } else {
      const validated = validatePlanFileForPipeline(parsed.file, {
        ...(parsed.pipelineId === undefined ? {} : { pipelineId: parsed.pipelineId }),
      });
      printValidation(validated, parsed.json);
    }
  } catch (error) {
    exitWithError(getErrorMessage(error), args.includes("--json"));
  }
}

export async function validate(args: string[]): Promise<void> {
  await plan(["validate", ...args]);
}
