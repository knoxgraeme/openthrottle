import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_COMPILER_ENVIRONMENT_DIGEST,
  RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
  compileDefinitionBundle,
  validatePlatformDefinitionCatalog,
  verifyCompilerEnvironment,
  verifyPlatformDefinitionSource,
  type DefinitionCompilation,
  type PlatformDefinitionCatalog,
  type TrustedCompilerEnvironment,
  type TrustedPlatformDefinitionSource,
  type TrustedRepositoryDefinitionSource,
  type VirtualDefinitionFile,
  type VirtualDefinitionFileMap,
} from "@openthrottle/contracts";
import { readLocalDefinitionFiles } from "./definition-files.js";

const FULL_GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SAFE_DEFINITION_PATH = /^\.openthrottle\/[A-Za-z0-9._/-]+$/;

export interface DefinitionGitCommand {
  cwd: string;
  args: readonly string[];
  input?: Uint8Array;
}

export type DefinitionGitRunner = (command: DefinitionGitCommand) => Uint8Array;

export interface DefinitionReleaseInputs {
  platform: TrustedPlatformDefinitionSource;
  compiler_environment: TrustedCompilerEnvironment;
}

interface GitDefinitionEntry {
  path: string;
  mode: "100644" | "100755";
  objectId: string;
}

const defaultGitRunner: DefinitionGitRunner = ({ cwd, args, input }) => new Uint8Array(
  execFileSync("git", [...args], {
    cwd,
    encoding: "buffer",
    input: input === undefined ? undefined : Buffer.from(input),
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }),
);

function utf8(bytes: Uint8Array, source: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${source}: Git returned invalid UTF-8`);
  }
}

function fullObjectId(bytes: Uint8Array, source: string): string {
  const value = utf8(bytes, source).trim();
  if (!FULL_GIT_OBJECT_ID.test(value)) {
    throw new Error(`${source}: expected a full lowercase Git object ID`);
  }
  return value;
}

function assertDefinitionPath(path: string, source: string): void {
  if (
    path.length > 500 ||
    !SAFE_DEFINITION_PATH.test(path) ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${source}: unsafe definition path ${JSON.stringify(path)}`);
  }
}

function nulRecords(bytes: Uint8Array, source: string): Uint8Array[] {
  const records: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index === start) throw new Error(`${source}: Git returned an empty record`);
    records.push(bytes.slice(start, index));
    start = index + 1;
  }
  if (start !== bytes.byteLength) throw new Error(`${source}: Git output was not NUL terminated`);
  return records;
}

function parseHeadTree(bytes: Uint8Array): GitDefinitionEntry[] {
  return nulRecords(bytes, "git ls-tree").map((record) => {
    const text = utf8(record, "git ls-tree");
    const match = /^(\d{6}) ([^ ]+) ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t(.+)$/.exec(text);
    if (!match) throw new Error("git ls-tree: malformed definition entry");
    const [, rawMode, type, objectId, path] = match;
    assertDefinitionPath(path!, "git ls-tree");
    if (type !== "blob" || (rawMode !== "100644" && rawMode !== "100755")) {
      throw new Error(`${path}: definitions in HEAD must be regular Git files`);
    }
    return { path: path!, mode: rawMode, objectId: objectId! };
  });
}

function parseIndex(bytes: Uint8Array): GitDefinitionEntry[] {
  return nulRecords(bytes, "git ls-files").map((record) => {
    const text = utf8(record, "git ls-files");
    const match = /^(\d{6}) ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([0-3])\t(.+)$/.exec(text);
    if (!match) throw new Error("git ls-files: malformed definition entry");
    const [, rawMode, objectId, stage, path] = match;
    assertDefinitionPath(path!, "git ls-files");
    if (stage !== "0") throw new Error(`${path}: definitions have an unresolved index entry`);
    if (rawMode !== "100644" && rawMode !== "100755") {
      throw new Error(`${path}: definitions in the index must be regular Git files`);
    }
    return { path: path!, mode: rawMode, objectId: objectId! };
  });
}

function sortedEntries(entries: readonly GitDefinitionEntry[]): GitDefinitionEntry[] {
  return [...entries].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function assertUniqueEntries(entries: readonly GitDefinitionEntry[], source: string): void {
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.path === entries[index]!.path) {
      throw new Error(`${source}: duplicate definition path ${entries[index]!.path}`);
    }
  }
}

function entrySnapshot(entries: readonly GitDefinitionEntry[]): string {
  return entries.map(({ mode, objectId, path }) => `${mode} ${objectId}\t${path}\0`).join("");
}

function fileMapSnapshot(files: VirtualDefinitionFileMap): string {
  return [...files.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([path, file]) => {
      if (file.type !== "file") throw new Error(`${path}: local definition reader returned a non-file`);
      const bytes = typeof file.content === "string"
        ? Buffer.from(file.content, "utf8")
        : Buffer.from(file.content);
      return `${path}\0${bytes.toString("base64")}\0`;
    })
    .join("");
}

function worktreeModeSnapshot(
  repositoryRoot: string,
  entries: readonly GitDefinitionEntry[],
): string {
  return entries.map((entry) => {
    const stat = lstatSync(join(repositoryRoot, ...entry.path.split("/")));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${entry.path}: definition worktree entry must be a regular file`);
    }
    const mode = (stat.mode & 0o111) === 0 ? "100644" : "100755";
    if (mode !== entry.mode) {
      throw new Error(`${entry.path}: executable mode does not match HEAD; commit definitions first`);
    }
    return `${mode}\t${entry.path}\0`;
  }).join("");
}

function assertIndexMatchesHead(
  headEntries: readonly GitDefinitionEntry[],
  indexEntries: readonly GitDefinitionEntry[],
): void {
  if (entrySnapshot(headEntries) !== entrySnapshot(indexEntries)) {
    throw new Error(".openthrottle definitions in the index do not match HEAD; commit definitions first");
  }
}

function readJson(path: string, source: string): unknown {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(`${source}: could not read ${path}`, { cause: error });
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`${source}: must contain valid JSON`, { cause: error });
  }
}

function selectedCatalogFiles(
  repositoryRoot: string,
  catalog: PlatformDefinitionCatalog,
): VirtualDefinitionFileMap {
  const available = readLocalDefinitionFiles(repositoryRoot);
  const selected = new Map<string, VirtualDefinitionFile>();
  for (const { path } of catalog.files) {
    const file = available.get(path);
    if (file !== undefined) selected.set(path, file);
  }
  return selected;
}

/** Load and verify the immutable definition release shipped beside the CLI. */
export function loadCliDefinitionRelease(moduleUrl = import.meta.url): DefinitionReleaseInputs {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const packagedRoot = join(moduleDirectory, "platform-definitions");
  let packagedRootStat: ReturnType<typeof lstatSync> | undefined;
  try {
    packagedRootStat = lstatSync(packagedRoot);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  let definitionRoot: string;
  let catalogPath: string;
  let environmentPath: string;

  if (packagedRootStat !== undefined) {
    if (packagedRootStat.isSymbolicLink() || !packagedRootStat.isDirectory()) {
      throw new Error("packaged platform-definitions must be a real directory");
    }
    definitionRoot = packagedRoot;
    catalogPath = join(packagedRoot, "catalog.json");
    environmentPath = join(packagedRoot, "compiler-environment.json");
  } else {
    const repositoryRoot = resolve(moduleDirectory, "..", "..");
    definitionRoot = repositoryRoot;
    catalogPath = join(repositoryRoot, "contracts", "generated", "platform-definition-catalog.json");
    environmentPath = join(repositoryRoot, "contracts", "generated", "compiler-environment.json");
  }

  const catalog = validatePlatformDefinitionCatalog(
    readJson(catalogPath, "platform definition catalog"),
  ).value;
  const platform = verifyPlatformDefinitionSource(
    catalog,
    selectedCatalogFiles(definitionRoot, catalog),
    RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
  );
  const compiler_environment = verifyCompilerEnvironment(
    readJson(environmentPath, "compiler environment"),
    RELEASE_COMPILER_ENVIRONMENT_DIGEST,
  );
  return { platform, compiler_environment };
}

/**
 * Snapshot definitions only when their path set, raw bytes, mode, and index all
 * represent one unchanged exact HEAD commit. Unrelated repository dirt is not
 * part of this authority check.
 */
export function readCommittedLocalDefinitionSource(
  repositoryRoot: string,
  gitRunner: DefinitionGitRunner = defaultGitRunner,
): TrustedRepositoryDefinitionSource {
  const run = (args: readonly string[], input?: Uint8Array): Uint8Array =>
    gitRunner({ cwd: repositoryRoot, args, ...(input === undefined ? {} : { input }) });
  let sourceCommit: string;
  try {
    sourceCommit = fullObjectId(
      run(["rev-parse", "--verify", "HEAD^{commit}"]),
      "git rev-parse HEAD",
    );
  } catch (error) {
    throw new Error("repository definitions require an existing exact HEAD commit", { cause: error });
  }

  const headEntries = sortedEntries(parseHeadTree(
    run(["ls-tree", "-rz", "--full-tree", sourceCommit, "--", ".openthrottle"]),
  ));
  assertUniqueEntries(headEntries, "git ls-tree");
  const indexBefore = sortedEntries(parseIndex(
    run(["ls-files", "-s", "-z", "--", ".openthrottle"]),
  ));
  assertUniqueEntries(indexBefore, "git ls-files");
  assertIndexMatchesHead(headEntries, indexBefore);

  const files = readLocalDefinitionFiles(repositoryRoot);
  const filePaths = [...files.keys()].sort();
  const headPaths = headEntries.map(({ path }) => path);
  if (JSON.stringify(filePaths) !== JSON.stringify(headPaths)) {
    throw new Error(".openthrottle definition paths do not match HEAD; commit definitions first");
  }
  const modesBefore = worktreeModeSnapshot(repositoryRoot, headEntries);

  for (const entry of headEntries) {
    const file = files.get(entry.path);
    if (file?.type !== "file") throw new Error(`${entry.path}: definition file is missing`);
    const content = typeof file.content === "string"
      ? new Uint8Array(Buffer.from(file.content, "utf8"))
      : new Uint8Array(file.content);
    const objectId = fullObjectId(
      run(["hash-object", "--stdin"], content),
      `git hash-object ${entry.path}`,
    );
    if (objectId !== entry.objectId) {
      throw new Error(`${entry.path}: raw definition bytes do not match HEAD; commit definitions first`);
    }
  }

  const filesAfter = readLocalDefinitionFiles(repositoryRoot);
  const indexAfter = sortedEntries(parseIndex(
    run(["ls-files", "-s", "-z", "--", ".openthrottle"]),
  ));
  const endingCommit = fullObjectId(
    run(["rev-parse", "--verify", "HEAD^{commit}"]),
    "git rev-parse HEAD",
  );
  if (
    endingCommit !== sourceCommit ||
    entrySnapshot(indexAfter) !== entrySnapshot(indexBefore) ||
    fileMapSnapshot(filesAfter) !== fileMapSnapshot(files) ||
    worktreeModeSnapshot(repositoryRoot, headEntries) !== modesBefore
  ) {
    throw new Error("repository definitions changed during snapshot; retry after committing them");
  }

  return { source_commit: sourceCommit, files };
}

export function compileLocalPipeline(options: {
  repositoryRoot?: string;
  expectedPipeline?: string;
  moduleUrl?: string;
  gitRunner?: DefinitionGitRunner;
} = {}): DefinitionCompilation {
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const release = loadCliDefinitionRelease(options.moduleUrl ?? import.meta.url);
  return compileDefinitionBundle({
    repository: readCommittedLocalDefinitionSource(repositoryRoot, options.gitRunner),
    platform: release.platform,
    compiler_environment: release.compiler_environment,
    ...(options.expectedPipeline === undefined
      ? {}
      : { selected_pipeline: options.expectedPipeline }),
  });
}
