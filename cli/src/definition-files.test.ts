import { createServer } from "node:net";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VIRTUAL_DEFINITION_MAX_FILE_BYTES,
  VIRTUAL_DEFINITION_MAX_FILES,
} from "@openthrottle/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { readLocalDefinitionFiles } from "./definition-files.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "ot-def-"));
  directories.push(directory);
  return directory;
}

function definitionFile(
  files: ReturnType<typeof readLocalDefinitionFiles>,
  path: string,
): Uint8Array {
  const file = files.get(path);
  expect(file?.type).toBe("file");
  if (!file || file.type !== "file" || typeof file.content === "string") {
    throw new Error(`expected raw definition bytes for ${path}`);
  }
  return file.content;
}

describe("local definition files", () => {
  it("returns an empty map when the definition root is missing", () => {
    expect([...readLocalDefinitionFiles(temporaryProject()).entries()]).toEqual([]);
  });

  it("reads every regular file as raw bytes under full, code-unit-sorted virtual paths", () => {
    const project = temporaryProject();
    mkdirSync(join(project, ".openthrottle", "agents", "z-agent"), { recursive: true });
    mkdirSync(join(project, ".openthrottle", "skills", "core", "kept"), { recursive: true });
    writeFileSync(join(project, ".openthrottle", "config.yml"), Buffer.from([0xff, 0x00, 0x0a]));
    writeFileSync(
      join(project, ".openthrottle", "agents", "z-agent", "instructions.md"),
      "standing instructions\n",
    );
    const executable = join(project, ".openthrottle", "skills", "core", "kept", "SKILL.md");
    writeFileSync(executable, "core paths are reader data\n");
    chmodSync(executable, 0o755);

    const files = readLocalDefinitionFiles(project);

    expect([...files.keys()]).toEqual([
      ".openthrottle/agents/z-agent/instructions.md",
      ".openthrottle/config.yml",
      ".openthrottle/skills/core/kept/SKILL.md",
    ]);
    expect([...definitionFile(files, ".openthrottle/config.yml")]).toEqual([0xff, 0x00, 0x0a]);
    expect(Buffer.from(definitionFile(files, ".openthrottle/skills/core/kept/SKILL.md")).toString())
      .toBe("core paths are reader data\n");
  });

  it("rejects symlinks, non-files, and compiler-unsafe paths", async () => {
    const symlinkProject = temporaryProject();
    const outside = temporaryProject();
    mkdirSync(join(outside, "definitions"));
    symlinkSync(join(outside, "definitions"), join(symlinkProject, ".openthrottle"), "dir");
    expect(() => readLocalDefinitionFiles(symlinkProject)).toThrow(/symlink/i);

    const unsafeProject = temporaryProject();
    mkdirSync(join(unsafeProject, ".openthrottle"));
    writeFileSync(join(unsafeProject, ".openthrottle", "bad name.yml"), "unsafe\n");
    expect(() => readLocalDefinitionFiles(unsafeProject)).toThrow(/safe relative POSIX path/);

    const socketProject = temporaryProject();
    mkdirSync(join(socketProject, ".openthrottle"));
    const socketPath = join(socketProject, ".openthrottle", "d.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      expect(() => readLocalDefinitionFiles(socketProject)).toThrow(/regular file/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("rejects case-colliding paths on case-sensitive filesystems", () => {
    const project = temporaryProject();
    const root = join(project, ".openthrottle");
    mkdirSync(root);
    writeFileSync(join(root, "CONFIG.yml"), "upper\n");
    writeFileSync(join(root, "config.yml"), "lower\n");
    if (readdirSync(root).length < 2) return;

    expect(() => readLocalDefinitionFiles(project)).toThrow(/case-colliding paths/);
  });

  it("requires the exact root casing and rejects duplicate case-variant roots", () => {
    const variantProject = temporaryProject();
    mkdirSync(join(variantProject, ".OpenThrottle"));
    expect(() => readLocalDefinitionFiles(variantProject)).toThrow(
      /definition root must use the exact \.openthrottle casing/,
    );

    const duplicateProject = temporaryProject();
    mkdirSync(join(duplicateProject, ".openthrottle"));
    mkdirSync(join(duplicateProject, ".OpenThrottle"), { recursive: true });
    const variants = readdirSync(duplicateProject)
      .filter((entry) => entry.toLowerCase() === ".openthrottle");
    if (variants.length < 2) return;
    expect(() => readLocalDefinitionFiles(duplicateProject)).toThrow(/case-colliding roots/);
  });

  it("preflights the shared file, count, and aggregate byte limits", () => {
    const oversizedProject = temporaryProject();
    mkdirSync(join(oversizedProject, ".openthrottle"));
    writeFileSync(join(oversizedProject, ".openthrottle", "large.yml"), "");
    truncateSync(
      join(oversizedProject, ".openthrottle", "large.yml"),
      VIRTUAL_DEFINITION_MAX_FILE_BYTES + 1,
    );
    expect(() => readLocalDefinitionFiles(oversizedProject)).toThrow(
      new RegExp(`exceeds ${VIRTUAL_DEFINITION_MAX_FILE_BYTES}`),
    );

    const crowdedProject = temporaryProject();
    const crowdedRoot = join(crowdedProject, ".openthrottle");
    mkdirSync(crowdedRoot);
    for (let index = 0; index <= VIRTUAL_DEFINITION_MAX_FILES; index += 1) {
      writeFileSync(join(crowdedRoot, `file-${String(index).padStart(3, "0")}.yml`), "");
    }
    expect(() => readLocalDefinitionFiles(crowdedProject)).toThrow(
      new RegExp(`file count exceeds ${VIRTUAL_DEFINITION_MAX_FILES}`),
    );

    const aggregateProject = temporaryProject();
    const aggregateRoot = join(aggregateProject, ".openthrottle");
    mkdirSync(aggregateRoot);
    for (let index = 0; index < 9; index += 1) {
      const path = join(aggregateRoot, `file-${index}.yml`);
      writeFileSync(path, "");
      truncateSync(path, VIRTUAL_DEFINITION_MAX_FILE_BYTES);
    }
    expect(() => readLocalDefinitionFiles(aggregateProject)).toThrow(/total bytes exceed 4194304/);
  });
});
