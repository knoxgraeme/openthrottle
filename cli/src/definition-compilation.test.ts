import { execFileSync } from "node:child_process";
import {
  cpSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compileDefinitionBundle } from "@openthrottle/contracts";
import {
  compileLocalPipeline,
  loadCliDefinitionRelease,
  readCommittedLocalDefinitionSource,
  type DefinitionGitRunner,
} from "./definition-compilation.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const parityFixtureRoot = join(
  repositoryRoot,
  "contracts",
  "fixtures",
  "definition-compiler",
  "committed-repository",
);
const parityGolden = JSON.parse(readFileSync(
  join(repositoryRoot, "contracts", "fixtures", "definition-compiler", "committed-golden.json"),
  "utf8",
)) as {
  source_commit: string;
  bundle_digest: string;
  manifest_digest: string;
};
const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(directory: string, args: readonly string[], input?: Uint8Array): Uint8Array {
  return new Uint8Array(execFileSync("git", [...args], {
    cwd: directory,
    encoding: "buffer",
    input: input === undefined ? undefined : Buffer.from(input),
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "OpenThrottle Fixture",
      GIT_AUTHOR_EMAIL: "fixture@openthrottle.invalid",
      GIT_COMMITTER_NAME: "OpenThrottle Fixture",
      GIT_COMMITTER_EMAIL: "fixture@openthrottle.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  }));
}

const gitRunner: DefinitionGitRunner = ({ cwd, args, input }) => git(cwd, args, input);

function initializeRepository(options: {
  attributes?: string;
  gitignore?: string;
  objectFormat?: "sha1" | "sha256";
} = {}): string {
  const directory = temporaryDirectory("openthrottle-definitions-");
  cpSync(join(parityFixtureRoot, ".openthrottle"), join(directory, ".openthrottle"), {
    recursive: true,
  });
  cpSync(join(parityFixtureRoot, "README.md"), join(directory, "README.md"));
  if (options.attributes !== undefined) {
    writeFileSync(join(directory, ".gitattributes"), options.attributes);
  }
  if (options.gitignore !== undefined) {
    writeFileSync(join(directory, ".gitignore"), options.gitignore);
  }
  git(directory, ["init", "-q", ...(options.objectFormat === undefined
    ? []
    : [`--object-format=${options.objectFormat}`])]);
  git(directory, ["add", "."]);
  git(directory, ["commit", "-q", "-m", "fixture"]);
  return directory;
}

function fullHead(directory: string): string {
  return Buffer.from(git(directory, ["rev-parse", "HEAD"])).toString("utf8").trim();
}

function buildPackagedRelease(): string {
  const moduleDirectory = join(temporaryDirectory("openthrottle-cli-package-"), "dist");
  const releaseRoot = join(moduleDirectory, "platform-definitions");
  mkdirSync(releaseRoot, { recursive: true });
  cpSync(
    join(repositoryRoot, "contracts", "generated", "platform-definition-catalog.json"),
    join(releaseRoot, "catalog.json"),
  );
  cpSync(
    join(repositoryRoot, "contracts", "generated", "compiler-environment.json"),
    join(releaseRoot, "compiler-environment.json"),
  );
  const catalog = JSON.parse(readFileSync(join(releaseRoot, "catalog.json"), "utf8")) as {
    files: Array<{ path: string }>;
  };
  for (const { path } of catalog.files) {
    const destination = join(releaseRoot, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(repositoryRoot, ...path.split("/")), destination);
  }
  return pathToFileURL(join(moduleDirectory, "definition-compilation.js")).href;
}

describe("committed local definition source", () => {
  it("binds clean definition bytes to the exact HEAD while allowing unrelated dirt", () => {
    const directory = initializeRepository();
    writeFileSync(join(directory, "README.md"), "unrelated dirt\n");

    const source = readCommittedLocalDefinitionSource(directory, gitRunner);

    expect(source.source_commit).toBe(fullHead(directory));
    expect(source.source_commit).toBe(parityGolden.source_commit);
    expect([...source.files.keys()]).toEqual([".openthrottle/config.yml"]);
  });

  it.each([
    ["modified", (directory: string) => {
      writeFileSync(join(directory, ".openthrottle", "config.yml"), "changed\n");
    }],
    ["untracked", (directory: string) => {
      writeFileSync(join(directory, ".openthrottle", "extra.yml"), "extra\n");
    }],
    ["deleted", (directory: string) => {
      rmSync(join(directory, ".openthrottle", "config.yml"));
    }],
  ])("rejects %s definition state", (_name, mutate) => {
    const directory = initializeRepository();
    mutate(directory);
    expect(() => readCommittedLocalDefinitionSource(directory, gitRunner))
      .toThrow(/commit definitions first/);
  });

  it("rejects ignored definition files because the complete filesystem path set differs", () => {
    const directory = initializeRepository({ gitignore: ".openthrottle/ignored.yml\n" });
    writeFileSync(join(directory, ".openthrottle", "ignored.yml"), "ignored\n");

    expect(() => readCommittedLocalDefinitionSource(directory, gitRunner))
      .toThrow(/definition paths do not match HEAD/);
  });

  it("rejects staged-only definition changes even when worktree bytes match HEAD", () => {
    const directory = initializeRepository();
    const path = join(directory, ".openthrottle", "config.yml");
    const headBytes = git(directory, ["show", "HEAD:.openthrottle/config.yml"]);
    writeFileSync(path, "staged change\n");
    git(directory, ["add", ".openthrottle/config.yml"]);
    writeFileSync(path, headBytes);

    expect(() => readCommittedLocalDefinitionSource(directory, gitRunner))
      .toThrow(/index do not match HEAD/);
  });

  it("rejects filtered worktree bytes that do not exactly equal the committed blob", () => {
    const directory = initializeRepository({ attributes: "*.yml text eol=lf\n" });
    const path = join(directory, ".openthrottle", "config.yml");
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("\n", "\r\n"));

    expect(() => readCommittedLocalDefinitionSource(directory, gitRunner))
      .toThrow(/raw definition bytes do not match HEAD/);
  });

  it("rejects an executable-mode change", () => {
    const directory = initializeRepository();
    chmodSync(join(directory, ".openthrottle", "config.yml"), 0o755);

    expect(() => readCommittedLocalDefinitionSource(directory, gitRunner))
      .toThrow(/executable mode does not match HEAD/);
  });

  it("accepts full SHA-256 repository object IDs", () => {
    const directory = initializeRepository({ objectFormat: "sha256" });

    const source = readCommittedLocalDefinitionSource(directory, gitRunner);

    expect(source.source_commit).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a HEAD change across the snapshot fence", () => {
    const directory = initializeRepository();
    let revisions = 0;
    const racingRunner: DefinitionGitRunner = (command) => {
      const result = git(command.cwd, command.args, command.input);
      if (command.args[0] === "rev-parse" && ++revisions === 2) {
        return new Uint8Array(Buffer.from(`${"f".repeat(fullHead(directory).length)}\n`));
      }
      return result;
    };

    expect(() => readCommittedLocalDefinitionSource(directory, racingRunner))
      .toThrow(/changed during snapshot/);
  });
});

describe("CLI definition compilation", () => {
  it("loads equivalent source and packaged releases", () => {
    const directory = initializeRepository();
    const source = readCommittedLocalDefinitionSource(directory, gitRunner);
    const development = loadCliDefinitionRelease();
    const packaged = loadCliDefinitionRelease(buildPackagedRelease());

    const developmentCompilation = compileDefinitionBundle({
      repository: source,
      platform: development.platform,
      compiler_environment: development.compiler_environment,
    });
    const packagedCompilation = compileDefinitionBundle({
      repository: source,
      platform: packaged.platform,
      compiler_environment: packaged.compiler_environment,
    });

    expect(packagedCompilation.bundle.normalized).toBe(developmentCompilation.bundle.normalized);
    expect(packagedCompilation.manifest.normalized).toBe(developmentCompilation.manifest.normalized);
    expect(developmentCompilation.bundle.digest).toBe(parityGolden.bundle_digest);
    expect(developmentCompilation.manifest.digest).toBe(parityGolden.manifest_digest);
  });

  it("fails a partial packaged release without falling back to source assets", () => {
    const moduleDirectory = join(temporaryDirectory("openthrottle-partial-package-"), "dist");
    const releaseRoot = join(moduleDirectory, "platform-definitions");
    mkdirSync(releaseRoot, { recursive: true });
    cpSync(
      join(repositoryRoot, "contracts", "generated", "platform-definition-catalog.json"),
      join(releaseRoot, "catalog.json"),
    );
    cpSync(
      join(repositoryRoot, "contracts", "generated", "compiler-environment.json"),
      join(releaseRoot, "compiler-environment.json"),
    );

    expect(() => loadCliDefinitionRelease(
      pathToFileURL(join(moduleDirectory, "definition-compilation.js")).href,
    )).toThrow(/missing catalog file/);
  });

  it("selects an explicit pipeline without changing committed config", () => {
    const directory = initializeRepository();

    const result = compileLocalPipeline({
      repositoryRoot: directory,
      expectedPipeline: "core/implement",
      gitRunner,
    });
    expect(result.manifest.value.pipeline_id).toBe("core/implement");
    expect(result.bundle.value.pipeline_selection).toBe("explicit");
    const structured = compileLocalPipeline({
      repositoryRoot: directory,
      expectedPipeline: "core/structured",
      gitRunner,
    });
    expect(structured.manifest.value.pipeline_id).toBe("core/structured");
    expect(structured.bundle.value.pipeline_selection).toBe("explicit");
  });
});
