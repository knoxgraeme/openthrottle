import {
  closeSync,
  constants as filesystemConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";
import {
  VIRTUAL_DEFINITION_MAX_FILE_BYTES,
  VIRTUAL_DEFINITION_MAX_FILES,
  VIRTUAL_DEFINITION_MAX_TOTAL_BYTES,
  compareCodeUnits,
  type VirtualDefinitionFileMap,
} from "@openthrottle/contracts";

const DEFINITION_ROOT = ".openthrottle";
const SAFE_VIRTUAL_PATH = /^[A-Za-z0-9._/-]+$/;

interface LocalDefinitionFile {
  absolutePath: string;
  virtualPath: string;
  size: number;
  snapshot: BigIntStats;
}

function assertSafeVirtualPath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 500 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    !SAFE_VIRTUAL_PATH.test(path) ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    !path.toLowerCase().startsWith(`${DEFINITION_ROOT}/`)
  ) {
    throw new Error(`${path}: must be a safe relative POSIX path inside ${DEFINITION_ROOT}/`);
  }
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.isFile() === right.isFile();
}

function missingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Read the repository's complete `.openthrottle/` authoring tree without
 * interpreting or filtering it. Compilation decides which paths are valid
 * definitions and whether an authored namespace is permitted.
 */
export function readLocalDefinitionFiles(repositoryRoot: string): VirtualDefinitionFileMap {
  let repositoryEntries: string[];
  try {
    repositoryEntries = readdirSync(repositoryRoot);
  } catch (error) {
    if (missingPath(error)) return new Map();
    throw error;
  }
  const rootVariants = repositoryEntries
    .filter((entry) => entry.toLowerCase() === DEFINITION_ROOT)
    .sort(compareCodeUnits);
  if (rootVariants.length === 0) return new Map();
  if (rootVariants.length > 1) {
    throw new Error(
      `definition files: case-colliding roots are forbidden: ${rootVariants.join(" and ")}`,
    );
  }
  if (rootVariants[0] !== DEFINITION_ROOT) {
    throw new Error(
      `${rootVariants[0]}: definition root must use the exact ${DEFINITION_ROOT} casing`,
    );
  }

  const definitionRoot = join(repositoryRoot, DEFINITION_ROOT);
  let rootSnapshot: BigIntStats;
  try {
    rootSnapshot = lstatSync(definitionRoot, { bigint: true });
  } catch (error) {
    if (missingPath(error)) return new Map();
    throw error;
  }
  if (rootSnapshot.isSymbolicLink()) {
    throw new Error(`${DEFINITION_ROOT}: definition root must not be a symlink`);
  }
  if (!rootSnapshot.isDirectory()) {
    throw new Error(`${DEFINITION_ROOT}: definition root must be a directory`);
  }

  const discovered: LocalDefinitionFile[] = [];
  const casePaths = new Map<string, string>();
  let totalBytes = 0;

  const visit = (absoluteDirectory: string, relativeDirectory: string): void => {
    const names = readdirSync(absoluteDirectory).sort(compareCodeUnits);
    for (const name of names) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const virtualPath = `${DEFINITION_ROOT}/${relativePath}`;
      assertSafeVirtualPath(virtualPath);

      const caseKey = virtualPath.toLowerCase();
      const existingCase = casePaths.get(caseKey);
      if (existingCase !== undefined) {
        if (existingCase === virtualPath) {
          throw new Error(`${virtualPath}: duplicate definition path is forbidden`);
        }
        throw new Error(
          `definition files: case-colliding paths are forbidden: ${existingCase} and ${virtualPath}`,
        );
      }
      casePaths.set(caseKey, virtualPath);

      const absolutePath = join(absoluteDirectory, name);
      const snapshot = lstatSync(absolutePath, { bigint: true });
      if (snapshot.isSymbolicLink()) {
        throw new Error(`${virtualPath}: symlinks are forbidden`);
      }
      if (snapshot.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (!snapshot.isFile()) {
        throw new Error(`${virtualPath}: must be a regular file`);
      }

      if (snapshot.size > BigInt(VIRTUAL_DEFINITION_MAX_FILE_BYTES)) {
        throw new Error(
          `${virtualPath}: file exceeds ${VIRTUAL_DEFINITION_MAX_FILE_BYTES} bytes`,
        );
      }
      if (discovered.length >= VIRTUAL_DEFINITION_MAX_FILES) {
        throw new Error(
          `definition files: file count exceeds ${VIRTUAL_DEFINITION_MAX_FILES}`,
        );
      }
      const size = Number(snapshot.size);
      totalBytes += size;
      if (totalBytes > VIRTUAL_DEFINITION_MAX_TOTAL_BYTES) {
        throw new Error(
          `definition files: total bytes exceed ${VIRTUAL_DEFINITION_MAX_TOTAL_BYTES}`,
        );
      }
      discovered.push({ absolutePath, virtualPath, size, snapshot });
    }
  };

  visit(definitionRoot, "");
  discovered.sort((left, right) => compareCodeUnits(left.virtualPath, right.virtualPath));

  const files = new Map<string, { type: "file"; content: Uint8Array }>();
  let bytesRead = 0;
  for (const file of discovered) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        file.absolutePath,
        filesystemConstants.O_RDONLY | filesystemConstants.O_NOFOLLOW,
      );
      const beforeRead = fstatSync(descriptor, { bigint: true });
      if (!sameFileSnapshot(file.snapshot, beforeRead)) {
        throw new Error(`${file.virtualPath}: file changed after definition preflight`);
      }
      const content = readFileSync(descriptor);
      const afterRead = fstatSync(descriptor, { bigint: true });
      const afterPath = lstatSync(file.absolutePath, { bigint: true });
      if (
        !sameFileSnapshot(file.snapshot, afterRead) ||
        !sameFileSnapshot(file.snapshot, afterPath) ||
        content.byteLength !== file.size
      ) {
        throw new Error(`${file.virtualPath}: file changed while being read`);
      }
      bytesRead += content.byteLength;
      if (bytesRead > VIRTUAL_DEFINITION_MAX_TOTAL_BYTES) {
        throw new Error(
          `definition files: total bytes exceed ${VIRTUAL_DEFINITION_MAX_TOTAL_BYTES}`,
        );
      }
      files.set(file.virtualPath, {
        type: "file",
        content: new Uint8Array(content),
      });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  return files;
}
