import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { posix } from "node:path";
import type * as Yaml from "yaml";
import { digestNormalized } from "./canonical.js";
import {
  reverifyCompilerEnvironment,
  type TrustedCompilerEnvironment,
} from "./compiler-environment.js";
import {
  VIRTUAL_DEFINITION_MAX_FILE_BYTES,
  VIRTUAL_DEFINITION_MAX_FILES,
  VIRTUAL_DEFINITION_MAX_TOTAL_BYTES,
  type TrustedRepositoryDefinitionSource,
  type VirtualDefinitionFileMap,
} from "./definition-source.js";
import {
  reverifyPlatformDefinitionSource,
  type TrustedPlatformDefinitionSource,
} from "./platform-definition-catalog.js";
import {
  DEFINITION_BUNDLE_SCHEMA,
  definitionEntryContentHash,
  definitionEntryIdentity,
  validateDefinitionBundle,
  type DefinitionBundle,
  type DefinitionBundleEntry,
  type DefinitionKind,
  type TrustedPlatformDefinitionHashes,
} from "./definition-bundle.js";
import { validateEvalDefinition, type EvalDefinition } from "./eval.js";
import {
  COMPILED_PIPELINE_MANIFEST_SCHEMA,
  validateCompiledPipelineManifest,
  validatePipelineDefinition,
  validatePipelineLoopDefinition,
  type CompiledPipelineManifest,
  type CompiledPipelineStage,
  type PipelineDefinition,
  type PipelineLoopDefinition,
} from "./pipeline.js";
import {
  expandCompiledRuntimeLifecycle,
} from "./runtime-lifecycle.js";
import { validateFilesystemConfigContract, type FilesystemConfigContract } from "./config.js";
import {
  GIT_SUBJECT,
  IDENTIFIER,
  fail,
  jsonValueAt,
  objectAt,
  recordAt,
  stringAt,
  type JsonValue,
  type ValidatedContract,
} from "./validation.js";

export const DEFINITION_YAML_MAX_BYTES = 256 * 1024;

export {
  VIRTUAL_DEFINITION_MAX_FILE_BYTES,
  VIRTUAL_DEFINITION_MAX_FILES,
  VIRTUAL_DEFINITION_MAX_TOTAL_BYTES,
} from "./definition-source.js";
export type {
  TrustedRepositoryDefinitionSource,
  VirtualDefinitionFile,
  VirtualDefinitionFileMap,
} from "./definition-source.js";
export type { TrustedPlatformDefinitionSource } from "./platform-definition-catalog.js";

export interface DefinitionCompilerInput {
  readonly repository: TrustedRepositoryDefinitionSource;
  readonly platform?: TrustedPlatformDefinitionSource;
  readonly compiler_environment: TrustedCompilerEnvironment;
  /** If present, asserts the config-selected pipeline rather than overriding it. */
  readonly selected_pipeline?: string;
}

export interface DefinitionCompilation {
  readonly bundle: ValidatedContract<DefinitionBundle>;
  readonly manifest: ValidatedContract<CompiledPipelineManifest>;
}

export interface DefinitionBundleManifestInput {
  readonly bundle: DefinitionBundle;
  readonly compiler_environment: TrustedCompilerEnvironment;
  readonly trusted_platform_definitions: TrustedPlatformDefinitionHashes;
}

export interface PlatformDefinitionHashesInput {
  readonly platform: TrustedPlatformDefinitionSource;
  readonly compiler_environment: TrustedCompilerEnvironment;
}

type DefinitionOrigin = "platform" | "repository";

interface LoadedFile {
  path: string;
  text: string;
  bytes: number;
  origin: DefinitionOrigin;
  sourceCommit: string | null;
}

interface DefinitionDescriptor {
  kind: DefinitionKind;
  id: string;
  file: LoadedFile;
  pipelineId?: string;
  loopFile?: string;
}

interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
}

interface SkillPackageFile {
  path: string;
  content_hash: string;
  content: string;
}

interface SkillPayload {
  frontmatter: SkillFrontmatter;
  instructions: string;
  files: SkillPackageFile[];
}

const CONFIG_PATH = ".openthrottle/config.yml";
const SAFE_VIRTUAL_PATH = /^[A-Za-z0-9._/-]+$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLATFORM_NAMESPACE = "core/";
const PACKAGE_DIRECTORIES = new Set(["assets", "references", "scripts"]);
const require = createRequire(import.meta.url);

function isCoreRepositoryPath(path: string): boolean {
  return /^\.openthrottle\/(?:agents|pipelines|skills|evals)\/core(?:\/|$)/.test(path);
}

function assertSafePath(path: unknown, source: string): asserts path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 500) {
    fail(source, "must be a relative POSIX path containing at most 500 characters");
  }
  if (
    path.startsWith("/") || path.endsWith("/") || path.includes("\\") ||
    !SAFE_VIRTUAL_PATH.test(path)
  ) {
    fail(source, "must be a safe relative POSIX path");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(source, "path traversal and ambiguous path segments are forbidden");
  }
  if (!path.toLowerCase().startsWith(".openthrottle/")) {
    fail(source, "must be inside .openthrottle/");
  }
}

function decodeText(content: string | Uint8Array, path: string): { text: string; bytes: number } {
  const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
  if (bytes > VIRTUAL_DEFINITION_MAX_FILE_BYTES) {
    fail(path, `file exceeds ${VIRTUAL_DEFINITION_MAX_FILE_BYTES} UTF-8 bytes`);
  }
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      fail(path, "must contain valid UTF-8 text");
    }
  }
  if (text.includes("\0")) fail(path, "must not contain NUL bytes");
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  return { text: text.replace(/\r\n?/g, "\n"), bytes };
}

function snapshotContent(content: string | Uint8Array): string | Uint8Array {
  return typeof content === "string" ? content : new Uint8Array(content);
}

function rawContentEquals(left: string | Uint8Array, right: string | Uint8Array): boolean {
  const leftBytes = typeof left === "string" ? Buffer.from(left, "utf8") : Buffer.from(left);
  const rightBytes = typeof right === "string" ? Buffer.from(right, "utf8") : Buffer.from(right);
  return leftBytes.equals(rightBytes);
}

function loadFiles(input: DefinitionCompilerInput): Map<string, LoadedFile> {
  const loaded = new Map<string, LoadedFile>();
  const casePaths = new Map<string, string>();
  let fileCount = 0;
  let totalBytes = 0;
  const platform = input.platform === undefined
    ? undefined
    : reverifyPlatformDefinitionSource(input.platform);
  const platformFiles = platform?.files;
  const channels: Array<{
    origin: DefinitionOrigin;
    sourceCommit: string | null;
    files: VirtualDefinitionFileMap;
  }> = [
    {
      origin: "repository",
      sourceCommit: stringAt(input.repository.source_commit, "repository.source_commit", {
        pattern: GIT_SUBJECT,
      }),
      files: input.repository.files,
    },
    ...(platform === undefined
      ? []
      : [{ origin: "platform" as const, sourceCommit: null, files: platform.files }]),
  ];

  for (const channel of channels) {
    if (!channel.files || typeof channel.files.entries !== "function") {
      fail(`${channel.origin}.files`, "must be a ReadonlyMap");
    }
    let channelFileCount = 0;
    let channelTotalBytes = 0;
    for (const [rawPath, virtualFile] of channel.files.entries()) {
      const pathSource = `${channel.origin}.files`;
      assertSafePath(rawPath, pathSource);
      channelFileCount += 1;
      if (channelFileCount > VIRTUAL_DEFINITION_MAX_FILES) {
        fail(`${channel.origin}.files`, `file count exceeds ${VIRTUAL_DEFINITION_MAX_FILES}`);
      }
      if (!virtualFile || virtualFile.type !== "file") {
        fail(rawPath, "must be a regular file; symlinks and non-files are forbidden");
      }
      // Snapshot an accessor-backed or shared-buffer input once. Validation,
      // core-mirror comparison, and retained compiler bytes must all observe
      // the same value.
      const content = snapshotContent(virtualFile.content);
      const contentBytes = typeof content === "string"
        ? Buffer.byteLength(content, "utf8")
        : content.byteLength;
      if (contentBytes > VIRTUAL_DEFINITION_MAX_FILE_BYTES) {
        fail(rawPath, `file exceeds ${VIRTUAL_DEFINITION_MAX_FILE_BYTES} UTF-8 bytes`);
      }
      channelTotalBytes += contentBytes;
      if (channelTotalBytes > VIRTUAL_DEFINITION_MAX_TOTAL_BYTES) {
        fail(`${channel.origin}.files`, `total bytes exceed ${VIRTUAL_DEFINITION_MAX_TOTAL_BYTES}`);
      }
      if (channel.origin === "repository" && isCoreRepositoryPath(rawPath)) {
        const released = platformFiles?.get(rawPath);
        if (
          released?.type !== "file" ||
          !rawContentEquals(content, released.content)
        ) {
          fail(
            rawPath,
            "repository definitions cannot change or add files in the reserved core namespace",
          );
        }
        // OpenThrottle dogfoods the same checked-in core tree used to build the
        // release catalog. Exact byte mirrors are repository evidence only;
        // compile the independently verified platform copy so its origin and
        // release trust remain authoritative.
        continue;
      }
      fileCount += 1;
      if (fileCount > VIRTUAL_DEFINITION_MAX_FILES) {
        fail("definition_files", `unique file count exceeds ${VIRTUAL_DEFINITION_MAX_FILES}`);
      }
      totalBytes += contentBytes;
      if (totalBytes > VIRTUAL_DEFINITION_MAX_TOTAL_BYTES) {
        fail("definition_files", `unique bytes exceed ${VIRTUAL_DEFINITION_MAX_TOTAL_BYTES}`);
      }
      const caseKey = rawPath.toLowerCase();
      const casePath = casePaths.get(caseKey);
      if (casePath !== undefined && casePath !== rawPath) {
        fail("definition_files", `case-colliding paths are forbidden: ${casePath} and ${rawPath}`);
      }
      casePaths.set(caseKey, rawPath);
      if (loaded.has(rawPath)) {
        fail(rawPath, "implicit override of an existing definition file is forbidden");
      }
      const decoded = decodeText(content, rawPath);
      loaded.set(rawPath, {
        path: rawPath,
        text: decoded.text,
        bytes: decoded.bytes,
        origin: channel.origin,
        sourceCommit: channel.sourceCommit,
      });
    }
  }
  return loaded;
}

function yamlIssueCode(issue: unknown): string {
  if (issue && typeof issue === "object" && "code" in issue && typeof issue.code === "string") {
    return issue.code;
  }
  return "YAML_ERROR";
}

function parseStrictYaml(
  text: string,
  path: string,
  sourceBytes = Buffer.byteLength(text, "utf8"),
): JsonValue {
  if (sourceBytes > DEFINITION_YAML_MAX_BYTES) {
    fail(path, `YAML exceeds ${DEFINITION_YAML_MAX_BYTES} UTF-8 bytes`);
  }
  // Keep the parser lazy so consumers using only the dependency-free canonical
  // helpers do not need to resolve the compiler's YAML peer at module load.
  const { parseDocument } = require("yaml") as typeof Yaml;
  const document = parseDocument(text, {
    prettyErrors: false,
    schema: "core",
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length > 0) {
    fail(path, `invalid YAML (${yamlIssueCode(document.errors[0])})`);
  }
  if (document.warnings.length > 0) {
    fail(path, `YAML warning (${yamlIssueCode(document.warnings[0])})`);
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    fail(path, "YAML aliases are disabled");
  }
  return jsonValueAt(value, path, {
    maxDepth: 24,
    maxEntries: 4_096,
    maxKeyLength: 240,
    rejectCarriageReturns: true,
  });
}

function identifier(value: string, path: string): string {
  return stringAt(value, path, { max: 160, pattern: IDENTIFIER });
}

function descriptorFor(file: LoadedFile): DefinitionDescriptor | null {
  if (file.path === CONFIG_PATH) return { kind: "config", id: "repository", file };
  const agent = /^\.openthrottle\/agents\/(.+)\/instructions\.md$/.exec(file.path);
  if (agent) return { kind: "agent", id: identifier(agent[1]!, file.path), file };
  const pipeline = /^\.openthrottle\/pipelines\/(.+)\/pipeline\.yml$/.exec(file.path);
  if (pipeline) return { kind: "pipeline", id: identifier(pipeline[1]!, file.path), file };
  const loopPrefix = ".openthrottle/pipelines/";
  const loopMarker = "/loops/";
  if (file.path.startsWith(loopPrefix) && /\.ya?ml$/.test(file.path)) {
    const markerIndex = file.path.lastIndexOf(loopMarker);
    if (markerIndex > loopPrefix.length) {
      const pipelineId = identifier(file.path.slice(loopPrefix.length, markerIndex), file.path);
      const loopFile = file.path.slice(markerIndex + 1);
      const rawLoopId = loopFile.slice("loops/".length).replace(/\.ya?ml$/, "");
      if (rawLoopId.includes("/")) fail(file.path, "pipeline-local loop files cannot be nested");
      const loopId = identifier(rawLoopId, file.path);
      return {
        kind: "loop",
        id: `${pipelineId}/${loopId}`,
        file,
        pipelineId,
        loopFile,
      };
    }
  }
  const skill = /^\.openthrottle\/skills\/(.+)\/SKILL\.md$/.exec(file.path);
  if (skill) return { kind: "skill", id: identifier(skill[1]!, file.path), file };
  const evaluation = /^\.openthrottle\/evals\/(.+)\/eval\.yml$/.exec(file.path);
  if (evaluation) return { kind: "eval", id: identifier(evaluation[1]!, file.path), file };
  return null;
}

function indexDefinitions(files: ReadonlyMap<string, LoadedFile>): {
  definitions: Map<string, DefinitionDescriptor>;
  skillFiles: Map<string, LoadedFile[]>;
} {
  const definitions = new Map<string, DefinitionDescriptor>();
  const supportFiles: LoadedFile[] = [];
  for (const file of files.values()) {
    const descriptor = descriptorFor(file);
    if (descriptor === null) {
      if (file.path.startsWith(".openthrottle/skills/")) supportFiles.push(file);
      else fail(file.path, "is not a recognized definition path");
      continue;
    }
    if (
      descriptor.file.origin === "platform" && descriptor.kind !== "config" &&
      descriptor.id !== "core" && !descriptor.id.startsWith(PLATFORM_NAMESPACE)
    ) {
      fail(file.path, "platform definitions must use the core namespace");
    }
    const identity = definitionEntryIdentity(descriptor.kind, descriptor.id);
    if (definitions.has(identity)) {
      fail(file.path, `duplicate definition ${identity} creates an implicit override`);
    }
    definitions.set(identity, descriptor);
  }

  const skillDescriptors = [...definitions.values()]
    .filter((descriptor) => descriptor.kind === "skill")
    .sort((left, right) => right.file.path.length - left.file.path.length);
  const skillFiles = new Map<string, LoadedFile[]>();
  for (const descriptor of skillDescriptors) skillFiles.set(descriptor.id, []);
  for (const file of supportFiles) {
    const owner = skillDescriptors.find((descriptor) => {
      const root = descriptor.file.path.slice(0, -"SKILL.md".length);
      return file.path.startsWith(root);
    });
    if (!owner) fail(file.path, "skill package file has no owning SKILL.md");
    if (owner.file.origin !== file.origin) {
      fail(file.path, "skill package files cannot implicitly override or mix definition origins");
    }
    const root = owner.file.path.slice(0, -"SKILL.md".length);
    const relative = file.path.slice(root.length);
    const directory = relative.split("/")[0]!;
    if (!PACKAGE_DIRECTORIES.has(directory)) {
      fail(file.path, "skill package files must be under assets/, references/, or scripts/");
    }
    skillFiles.get(owner.id)!.push(file);
  }
  for (const packageFiles of skillFiles.values()) {
    packageFiles.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  }
  return { definitions, skillFiles };
}

function requiredDefinition(
  definitions: ReadonlyMap<string, DefinitionDescriptor>,
  kind: DefinitionKind,
  id: string,
  source: string,
): DefinitionDescriptor {
  const found = definitions.get(definitionEntryIdentity(kind, id));
  if (!found) fail(source, `${kind} ${id} was not found`);
  return found;
}

function parseFrontmatter(value: JsonValue, path: string, expectedName: string): SkillFrontmatter {
  const input = objectAt(value, path, [
    "name", "description", "license", "compatibility", "metadata",
  ]);
  const name = stringAt(input.name, `${path}.name`, { max: 64, pattern: SKILL_NAME });
  if (name !== expectedName) fail(`${path}.name`, `must be ${expectedName}`);
  return {
    name,
    description: stringAt(input.description, `${path}.description`, { max: 1_024 }),
    ...(input.license === undefined
      ? {}
      : { license: stringAt(input.license, `${path}.license`, { max: 200 }) }),
    ...(input.compatibility === undefined
      ? {}
      : { compatibility: stringAt(input.compatibility, `${path}.compatibility`, { max: 500 }) }),
    ...(input.metadata === undefined
      ? {}
      : {
        metadata: recordAt(
          input.metadata,
          `${path}.metadata`,
          (entry, entryPath) => stringAt(entry, entryPath, { max: 500 }),
          { max: 32, keyMax: 80, keyPattern: /^[A-Za-z0-9._-]+$/ },
        ),
      }),
  };
}

function splitSkill(file: LoadedFile, id: string): { frontmatter: SkillFrontmatter; instructions: string } {
  const lines = file.text.split("\n");
  if (lines[0] !== "---") fail(file.path, "must begin with Agent Skills YAML frontmatter");
  const closing = lines.indexOf("---", 1);
  if (closing < 0) fail(file.path, "must close Agent Skills YAML frontmatter with ---");
  const expectedName = id.slice(id.lastIndexOf("/") + 1);
  const frontmatter = parseFrontmatter(
    parseStrictYaml(lines.slice(1, closing).join("\n"), `${file.path}.frontmatter`),
    `${file.path}.frontmatter`,
    expectedName,
  );
  const instructions = lines.slice(closing + 1).join("\n");
  if (instructions.trim().length === 0) fail(file.path, "must contain non-empty skill instructions");
  return { frontmatter, instructions };
}

interface SkillReference {
  target: string;
  rootRelative: boolean;
}

function referencedSkillPaths(instructions: string): SkillReference[] {
  const paths: SkillReference[] = [];
  const links = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of instructions.matchAll(links)) {
    let target = match[1]!.trim();
    if (target.startsWith("<")) {
      const closing = target.indexOf(">");
      if (closing > 0) target = target.slice(1, closing);
    } else {
      target = target.split(/\s+/, 1)[0]!;
    }
    target = target.split(/[?#]/, 1)[0]!;
    if (!target || target.startsWith("#") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) continue;
    paths.push({ target, rootRelative: /^(?:assets|references|scripts)\//.test(target) });
  }
  const packagePaths = /(?:^|[^A-Za-z0-9._/-])((?:assets|references|scripts)\/[A-Za-z0-9._/-]+)(?=$|[^A-Za-z0-9._/-])/g;
  for (const match of instructions.matchAll(packagePaths)) {
    paths.push({ target: match[1]!, rootRelative: true });
  }
  return paths;
}

function skillPayload(descriptor: DefinitionDescriptor, packageFiles: readonly LoadedFile[]): SkillPayload {
  const parsed = splitSkill(descriptor.file, descriptor.id);
  const root = descriptor.file.path.slice(0, -"SKILL.md".length);
  const byRelativePath = new Map(packageFiles.map((file) => [file.path.slice(root.length), file]));
  const resolveReference = (reference: SkillReference, from: string): string => {
    const target = reference.target;
    if (target.includes("\\") || target.startsWith("/")) {
      fail(descriptor.file.path, `skill reference ${target} escapes its package`);
    }
    const normalized = posix.normalize(
      reference.rootRelative ? target : posix.join(posix.dirname(from), target),
    );
    if (
      normalized === "." || normalized === ".." || normalized.startsWith("../") ||
      !PACKAGE_DIRECTORIES.has(normalized.split("/")[0]!)
    ) {
      fail(descriptor.file.path, `skill reference ${target} escapes its package`);
    }
    return normalized;
  };
  const sources = [
    { path: "SKILL.md", text: parsed.instructions },
    ...packageFiles.map((file) => ({ path: file.path.slice(root.length), text: file.text })),
  ];
  const referencesBySource = new Map<string, string[]>();
  for (const source of sources) {
    const targets: string[] = [];
    for (const reference of referencedSkillPaths(source.text)) {
      const relative = resolveReference(reference, source.path);
      if (!byRelativePath.has(relative)) {
        fail(descriptor.file.path, `referenced package file ${relative} is missing`);
      }
      targets.push(relative);
    }
    referencesBySource.set(source.path, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (path: string): void => {
    if (visiting.has(path)) fail(descriptor.file.path, `skill package references contain a cycle at ${path}`);
    if (visited.has(path)) return;
    visiting.add(path);
    for (const target of referencesBySource.get(path) ?? []) visit(target);
    visiting.delete(path);
    visited.add(path);
  };
  for (const source of sources) {
    visit(source.path);
  }
  return {
    frontmatter: parsed.frontmatter,
    instructions: parsed.instructions,
    files: packageFiles.map((file) => ({
      path: file.path.slice(root.length),
      content_hash: digestNormalized(file.text),
      content: file.text,
    })),
  };
}

function entry(
  descriptor: DefinitionDescriptor,
  normalizedPayload: unknown,
): DefinitionBundleEntry {
  return {
    definition_kind: descriptor.kind,
    definition_id: descriptor.id,
    origin: {
      kind: descriptor.file.origin,
      source_commit: descriptor.file.sourceCommit,
    },
    path: descriptor.file.path,
    content_hash: definitionEntryContentHash(normalizedPayload),
    normalized_payload: normalizedPayload,
  };
}

/**
 * Normalizes every release-sealed platform definition into the same identity
 * and content hash used by DefinitionBundles. Recovery uses this independently
 * derived map to authenticate stored bundles; trusting hashes copied from the
 * bundle itself would make the platform-origin fence circular.
 */
export function deriveTrustedPlatformDefinitionHashes(
  input: PlatformDefinitionHashesInput,
): TrustedPlatformDefinitionHashes {
  const compilerEnvironment = reverifyCompilerEnvironment(input.compiler_environment);
  const files = loadFiles({
    repository: { source_commit: "0".repeat(40), files: new Map() },
    platform: input.platform,
    compiler_environment: input.compiler_environment,
  });
  const { definitions, skillFiles } = indexDefinitions(files);
  const evaluatorPrimitives = new Set(compilerEnvironment.evaluator_primitives);
  const hashes = new Map<string, string>();
  for (const descriptor of [...definitions.values()].sort((left, right) => {
    const leftIdentity = definitionEntryIdentity(left.kind, left.id);
    const rightIdentity = definitionEntryIdentity(right.kind, right.id);
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
  })) {
    if (descriptor.file.origin !== "platform" || descriptor.kind === "config") {
      fail(descriptor.file.path, "trusted platform source contains a non-platform definition");
    }
    const normalizedPayload = descriptor.kind === "agent"
      ? descriptor.file.text
      : descriptor.kind === "pipeline"
        ? parsePipeline(descriptor)
        : descriptor.kind === "loop"
          ? parseLoop(descriptor)
          : descriptor.kind === "skill"
            ? skillPayload(descriptor, skillFiles.get(descriptor.id) ?? [])
            : parseEval(descriptor, evaluatorPrimitives);
    hashes.set(
      definitionEntryIdentity(descriptor.kind, descriptor.id),
      definitionEntryContentHash(normalizedPayload),
    );
  }
  return hashes;
}

function parsePipeline(descriptor: DefinitionDescriptor): PipelineDefinition {
  const pipeline = validatePipelineDefinition(parseStrictYaml(
    descriptor.file.text,
    descriptor.file.path,
    descriptor.file.bytes,
  ), {
    source: descriptor.file.path,
  }).value;
  if (pipeline.id !== descriptor.id) {
    fail(`${descriptor.file.path}.id`, `must match path-derived pipeline id ${descriptor.id}`);
  }
  return pipeline;
}

function parseLoop(descriptor: DefinitionDescriptor): PipelineLoopDefinition {
  const loop = validatePipelineLoopDefinition(parseStrictYaml(
    descriptor.file.text,
    descriptor.file.path,
    descriptor.file.bytes,
  ), {
    source: descriptor.file.path,
  }).value;
  if (loop.id !== descriptor.id) {
    fail(`${descriptor.file.path}.id`, `must match path-derived loop id ${descriptor.id}`);
  }
  return loop;
}

function parseEval(
  descriptor: DefinitionDescriptor,
  evaluatorPrimitives: ReadonlySet<string>,
): EvalDefinition {
  const evaluation = validateEvalDefinition(parseStrictYaml(
    descriptor.file.text,
    descriptor.file.path,
    descriptor.file.bytes,
  ), {
    source: descriptor.file.path,
  }).value;
  if (evaluation.id !== descriptor.id) {
    fail(`${descriptor.file.path}.id`, `must match path-derived eval id ${descriptor.id}`);
  }
  if (!evaluatorPrimitives.has(evaluation.evaluator)) {
    fail(`${descriptor.file.path}.evaluator`, `evaluator ${evaluation.evaluator} is not registered`);
  }
  return evaluation;
}

function compileStages(
  pipeline: PipelineDefinition,
  config: FilesystemConfigContract,
  definitions: ReadonlyMap<string, DefinitionDescriptor>,
  selectedEntries: Map<string, DefinitionBundleEntry>,
  skillFiles: ReadonlyMap<string, readonly LoadedFile[]>,
  evaluatorPrimitives: ReadonlySet<string>,
): CompiledPipelineStage[] {
  const compiled: CompiledPipelineStage[] = [];
  for (const [index, stage] of pipeline.stages.entries()) {
    let loop = stage.loop;
    if (loop?.file !== undefined) {
      const loopPath = `.openthrottle/pipelines/${pipeline.id}/${loop.file}`;
      const loopDescriptor = [...definitions.values()].find((candidate) => candidate.file.path === loopPath);
      if (!loopDescriptor || loopDescriptor.kind !== "loop" || loopDescriptor.pipelineId !== pipeline.id) {
        fail(`${pipeline.id}.stages[${index}].loop.file`, `loop file ${loop.file} was not found`);
      }
      const definition = parseLoop(loopDescriptor);
      selectedEntries.set(
        definitionEntryIdentity("loop", loopDescriptor.id),
        entry(loopDescriptor, definition),
      );
      loop = {
        over: loop.over,
        max_parallel: loop.max_parallel,
        max_rounds: loop.max_rounds,
        body: definition.body,
      };
    }
    if (stage.kind === "agent") {
      const agent = requiredDefinition(definitions, "agent", stage.agent_id, `${pipeline.id}.stages[${index}].agent_id`);
      if (agent.file.text.trim().length === 0) fail(agent.file.path, "agent instructions must not be empty");
      selectedEntries.set(definitionEntryIdentity("agent", agent.id), entry(agent, agent.file.text));
      for (const [skillIndex, skillId] of stage.skills.entries()) {
        const skill = requiredDefinition(
          definitions,
          "skill",
          skillId,
          `${pipeline.id}.stages[${index}].skills[${skillIndex}]`,
        );
        const payload = skillPayload(skill, skillFiles.get(skill.id) ?? []);
        selectedEntries.set(definitionEntryIdentity("skill", skill.id), entry(skill, payload));
      }
      const evaluation = requiredDefinition(
        definitions,
        "eval",
        stage.eval,
        `${pipeline.id}.stages[${index}].eval`,
      );
      selectedEntries.set(
        definitionEntryIdentity("eval", evaluation.id),
        entry(evaluation, parseEval(evaluation, evaluatorPrimitives)),
      );
      compiled.push({ ...stage, ...(loop === undefined ? {} : { loop }), engine: config.engine });
      continue;
    }
    if (stage.kind === "command" && !Object.hasOwn(config.commands ?? {}, stage.command)) {
      fail(`${pipeline.id}.stages[${index}].command`, `command ${stage.command} is not defined by config`);
    }
    compiled.push({ ...stage, ...(loop === undefined ? {} : { loop }) });
  }
  return compiled;
}

export function compileDefinitionBundle(input: DefinitionCompilerInput): DefinitionCompilation {
  const compilerEnvironment = reverifyCompilerEnvironment(input.compiler_environment);
  const files = loadFiles(input);
  const { definitions, skillFiles } = indexDefinitions(files);
  const configDescriptor = requiredDefinition(definitions, "config", "repository", "config");
  if (configDescriptor.file.origin !== "repository") {
    fail(configDescriptor.file.path, "config must come from the trusted repository channel");
  }
  const config = validateFilesystemConfigContract(
    parseStrictYaml(configDescriptor.file.text, configDescriptor.file.path, configDescriptor.file.bytes),
    { source: configDescriptor.file.path },
  ).value;
  const selectedPipeline = input.selected_pipeline ?? config.pipeline;
  const pipelineDescriptor = requiredDefinition(
    definitions,
    "pipeline",
    selectedPipeline,
    input.selected_pipeline === undefined ? "config.pipeline" : "selected_pipeline",
  );
  const pipeline = parsePipeline(pipelineDescriptor);
  const evaluatorPrimitives = new Set(compilerEnvironment.evaluator_primitives);
  const selectedEntries = new Map<string, DefinitionBundleEntry>();
  selectedEntries.set(
    definitionEntryIdentity("config", "repository"),
    entry(configDescriptor, config),
  );
  selectedEntries.set(
    definitionEntryIdentity("pipeline", pipelineDescriptor.id),
    entry(pipelineDescriptor, pipeline),
  );
  const stages = compileStages(
    pipeline,
    config,
    definitions,
    selectedEntries,
    skillFiles,
    evaluatorPrimitives,
  );
  const trustedPlatformDefinitions = new Map(
    [...selectedEntries.values()]
      .filter((definition) => definition.origin.kind === "platform")
      .map((definition) => [
        definitionEntryIdentity(definition.definition_kind, definition.definition_id),
        definition.content_hash,
      ]),
  );
  const bundle = validateDefinitionBundle({
    schema: DEFINITION_BUNDLE_SCHEMA,
    compiler_version: compilerEnvironment.compiler_version,
    runtime_capability_digest: compilerEnvironment.runtime_capability_digest,
    source_commit: input.repository.source_commit,
    pipeline_id: pipeline.id,
    pipeline_selection: input.selected_pipeline === undefined ? "config" : "explicit",
    entries: [...selectedEntries.values()],
  }, { trustedPlatformDefinitions });
  const runtimeLifecycle = expandCompiledRuntimeLifecycle({
    entry_stage: pipeline.entry,
    stages,
  });
  const manifest = validateCompiledPipelineManifest({
    schema: COMPILED_PIPELINE_MANIFEST_SCHEMA,
    pipeline_id: pipeline.id,
    pipeline_version: pipeline.version,
    entry_stage: runtimeLifecycle.entry_stage,
    definition_bundle_hash: bundle.digest,
    compiler_version: compilerEnvironment.compiler_version,
    runtime_capability_digest: compilerEnvironment.runtime_capability_digest,
    stages: runtimeLifecycle.stages,
  });
  return { bundle, manifest };
}

/**
 * Reconstructs the private runtime protocol from the immutable bundle stored
 * on the run. This deliberately does not read the repository, platform files,
 * or a process-local manifest cache: restart recovery has exactly the same
 * behavior identity as admission.
 */
export function compileManifestFromDefinitionBundle(
  input: DefinitionBundleManifestInput,
): ValidatedContract<CompiledPipelineManifest> {
  const compilerEnvironment = reverifyCompilerEnvironment(input.compiler_environment);
  const bundle = validateDefinitionBundle(input.bundle, {
    source: "definition_bundle",
    trustedPlatformDefinitions: input.trusted_platform_definitions,
  });
  if (bundle.value.compiler_version !== compilerEnvironment.compiler_version) {
    fail(
      "definition_bundle.compiler_version",
      "does not match the pinned compiler environment",
    );
  }
  if (bundle.value.runtime_capability_digest !== compilerEnvironment.runtime_capability_digest) {
    fail(
      "definition_bundle.runtime_capability_digest",
      "does not match the pinned compiler environment",
    );
  }

  const entries = new Map(bundle.value.entries.map((definition) => [
    definitionEntryIdentity(definition.definition_kind, definition.definition_id),
    definition,
  ]));
  const used = new Set<string>();
  const requireEntry = (kind: DefinitionKind, id: string, source: string): DefinitionBundleEntry => {
    const identity = definitionEntryIdentity(kind, id);
    const definition = entries.get(identity);
    if (!definition) fail(source, `${kind} ${id} is absent from the pinned DefinitionBundle`);
    used.add(identity);
    return definition;
  };

  const configEntry = requireEntry("config", "repository", "definition_bundle.entries");
  if (configEntry.origin.kind !== "repository") {
    fail("definition_bundle.entries.config:repository.origin", "config must be repository-owned");
  }
  const config = validateFilesystemConfigContract(configEntry.normalized_payload, {
    source: configEntry.path,
  }).value;
  if (bundle.value.pipeline_selection === "config" && config.pipeline !== bundle.value.pipeline_id) {
    fail("definition_bundle.pipeline_id", "does not match the bundled config selection");
  }

  const pipelineEntry = requireEntry(
    "pipeline",
    bundle.value.pipeline_id,
    "definition_bundle.pipeline_id",
  );
  const pipeline = validatePipelineDefinition(pipelineEntry.normalized_payload, {
    source: pipelineEntry.path,
  }).value;
  if (pipeline.id !== pipelineEntry.definition_id) {
    fail(`${pipelineEntry.path}.id`, "does not match its DefinitionBundle identity");
  }

  const evaluatorPrimitives = new Set(compilerEnvironment.evaluator_primitives);
  const compiled: CompiledPipelineStage[] = [];
  for (const [index, stage] of pipeline.stages.entries()) {
    let loop = stage.loop;
    if (loop?.file !== undefined) {
      const expectedPath = `.openthrottle/pipelines/${pipeline.id}/${loop.file}`;
      const loopEntry = bundle.value.entries.find((candidate) =>
        candidate.definition_kind === "loop" && candidate.path === expectedPath);
      if (!loopEntry) {
        fail(`${pipeline.id}.stages[${index}].loop.file`, `loop file ${loop.file} is absent from the pinned DefinitionBundle`);
      }
      requireEntry("loop", loopEntry.definition_id, `${pipeline.id}.stages[${index}].loop.file`);
      const definition = validatePipelineLoopDefinition(loopEntry.normalized_payload, {
        source: loopEntry.path,
      }).value;
      if (definition.id !== loopEntry.definition_id) {
        fail(`${loopEntry.path}.id`, "does not match its DefinitionBundle identity");
      }
      loop = {
        over: loop.over,
        max_parallel: loop.max_parallel,
        max_rounds: loop.max_rounds,
        body: definition.body,
      };
    }
    if (stage.kind === "agent") {
      const agent = requireEntry(
        "agent",
        stage.agent_id,
        `${pipeline.id}.stages[${index}].agent_id`,
      );
      if (typeof agent.normalized_payload !== "string" || agent.normalized_payload.trim() === "") {
        fail(agent.path, "agent instructions must be a non-empty string");
      }
      for (const [skillIndex, skillId] of stage.skills.entries()) {
        requireEntry(
          "skill",
          skillId,
          `${pipeline.id}.stages[${index}].skills[${skillIndex}]`,
        );
      }
      const evaluation = requireEntry(
        "eval",
        stage.eval,
        `${pipeline.id}.stages[${index}].eval`,
      );
      const parsedEvaluation = validateEvalDefinition(evaluation.normalized_payload, {
        source: evaluation.path,
      }).value;
      if (parsedEvaluation.id !== evaluation.definition_id) {
        fail(`${evaluation.path}.id`, "does not match its DefinitionBundle identity");
      }
      if (!evaluatorPrimitives.has(parsedEvaluation.evaluator)) {
        fail(`${evaluation.path}.evaluator`, `evaluator ${parsedEvaluation.evaluator} is not registered`);
      }
      compiled.push({ ...stage, ...(loop === undefined ? {} : { loop }), engine: config.engine });
      continue;
    }
    if (stage.kind === "command" && !Object.hasOwn(config.commands ?? {}, stage.command)) {
      fail(`${pipeline.id}.stages[${index}].command`, `command ${stage.command} is not defined by config`);
    }
    compiled.push({ ...stage, ...(loop === undefined ? {} : { loop }) });
  }

  if (used.size !== entries.size) {
    const unused = [...entries.keys()].filter((identity) => !used.has(identity)).sort();
    fail(
      "definition_bundle.entries",
      `contains definitions outside the selected transitive closure: ${unused.join(", ")}`,
    );
  }
  const runtimeLifecycle = expandCompiledRuntimeLifecycle({
    entry_stage: pipeline.entry,
    stages: compiled,
  });
  return validateCompiledPipelineManifest({
    schema: COMPILED_PIPELINE_MANIFEST_SCHEMA,
    pipeline_id: pipeline.id,
    pipeline_version: pipeline.version,
    entry_stage: runtimeLifecycle.entry_stage,
    definition_bundle_hash: bundle.digest,
    compiler_version: compilerEnvironment.compiler_version,
    runtime_capability_digest: compilerEnvironment.runtime_capability_digest,
    stages: runtimeLifecycle.stages,
  });
}
