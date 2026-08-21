import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMPILER_ENVIRONMENT_SCHEMA,
  COMPILER_ENVIRONMENT_VERSION,
  DEFINITION_YAML_MAX_BYTES,
  PLATFORM_DEFINITION_CATALOG_SCHEMA,
  PLATFORM_DEFINITION_CATALOG_VERSION,
  VIRTUAL_DEFINITION_MAX_FILE_BYTES,
  VIRTUAL_DEFINITION_MAX_FILES,
  VIRTUAL_DEFINITION_MAX_TOTAL_BYTES,
  compileDefinitionBundle,
  compileManifestFromDefinitionBundle,
  definitionEntryContentHash,
  digestCanonicalJson,
  digestNormalized,
  runtimeCapabilityDigest,
  verifyCompilerEnvironment,
  verifyPlatformDefinitionSource,
  type CompilerEnvironmentDescriptor,
  type DefinitionBundle,
  type PlatformDefinitionCatalog,
  type TrustedCompilerEnvironment,
  type TrustedPlatformDefinitionSource,
  type VirtualDefinitionFile,
  type VirtualDefinitionFileMap,
} from "./index.js";

interface FixtureFile {
  content: string;
  blob_sha: string;
}

interface CompilerFixture {
  source_commit: string;
  repository: Record<string, FixtureFile>;
  platform: Record<string, FixtureFile>;
}

const fixturePath = fileURLToPath(
  new URL("../fixtures/definition-compiler/golden-source.json", import.meta.url),
);
const sourceFixture = JSON.parse(readFileSync(fixturePath, "utf8")) as CompilerFixture;
const evaluatorPrimitives = new Set([
  "core/action-outcome@1",
  "core/review-outcome@1",
  "core/unit-outcome@1",
]);
const runtimeManifestDigest = "b".repeat(64);
const validatorArtifactSetDigest = "d".repeat(64);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function virtualFiles(files: Record<string, FixtureFile>): VirtualDefinitionFileMap {
  return new Map(Object.entries(files).map(([path, file]) => [
    path,
    { type: "file", content: file.content, blob_sha: file.blob_sha } satisfies VirtualDefinitionFile,
  ]));
}

function compilerEnvironment(options: {
  compiler_version?: string;
  runtime_manifest_digest?: string;
  evaluator_primitives?: readonly string[];
} = {}): TrustedCompilerEnvironment {
  const primitives = [...(options.evaluator_primitives ?? evaluatorPrimitives)].sort();
  const runtimeCapabilityInputs = {
    runtime_manifest_digest: options.runtime_manifest_digest ?? runtimeManifestDigest,
    validator_artifact_set_digest: validatorArtifactSetDigest,
  };
  const content = {
    schema: COMPILER_ENVIRONMENT_SCHEMA,
    version: COMPILER_ENVIRONMENT_VERSION,
    compiler_version: options.compiler_version ?? "definition-compiler/v1",
    runtime_capability_inputs: runtimeCapabilityInputs,
    runtime_capability_digest: runtimeCapabilityDigest({
      ...runtimeCapabilityInputs,
      evaluator_primitives: primitives,
    }),
    evaluator_primitives: primitives,
  };
  const descriptor: CompilerEnvironmentDescriptor = {
    ...content,
    environment_digest: digestCanonicalJson(content),
  };
  return verifyCompilerEnvironment(descriptor, descriptor.environment_digest);
}

function trustedPlatform(files: Record<string, FixtureFile>) {
  const rawFiles = new Map(Object.entries(files).map(([path, file]) => [
    path,
    { type: "file" as const, content: Buffer.from(file.content, "utf8"), blob_sha: file.blob_sha },
  ]));
  const inventory = [...rawFiles].map(([path, file]) => ({
    path,
    byte_size: file.content.byteLength,
    sha256: digestNormalized(file.content),
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const content = {
    schema: PLATFORM_DEFINITION_CATALOG_SCHEMA,
    version: PLATFORM_DEFINITION_CATALOG_VERSION,
    files: inventory,
  };
  const catalog: PlatformDefinitionCatalog = {
    ...content,
    catalog_digest: digestCanonicalJson(content),
  };
  return verifyPlatformDefinitionSource(catalog, rawFiles, catalog.catalog_digest);
}

function compile(
  fixture: CompilerFixture = sourceFixture,
  overrides: {
    compiler_version?: string;
    runtime_manifest_digest?: string;
    evaluator_primitives?: readonly string[];
  } = {},
) {
  return compileDefinitionBundle({
    repository: {
      source_commit: fixture.source_commit,
      files: virtualFiles(fixture.repository),
    },
    ...(Object.keys(fixture.platform).length === 0 ? {} : { platform: trustedPlatform(fixture.platform) }),
    compiler_environment: compilerEnvironment(overrides),
  });
}

function platformHashes(bundle: DefinitionBundle): Map<string, string> {
  return new Map(bundle.entries
    .filter((entry) => entry.origin.kind === "platform")
    .map((entry) => [
      `${entry.definition_kind}:${entry.definition_id}`,
      entry.content_hash,
    ]));
}

function replaceFile(
  fixture: CompilerFixture,
  channel: "repository" | "platform",
  path: string,
  content: string,
): CompilerFixture {
  const updated = clone(fixture);
  updated[channel][path] = { ...updated[channel][path]!, content };
  return updated;
}

function repositoryAuthoredFixture(): CompilerFixture {
  const fixture = clone(sourceFixture);
  const replacements = [
    ["core/review/review-cycle", "review/review-cycle"],
    ["core/review-change", "review-change"],
    ["core/review-result", "review-result"],
    ["core/reviewer", "reviewer"],
    ["core/review", "review"],
  ] as const;
  fixture.repository[".openthrottle/config.yml"]!.content =
    fixture.repository[".openthrottle/config.yml"]!.content.replace("core/review", "review");
  const pathReplacements = [
    [".openthrottle/agents/core/reviewer/instructions.md", ".openthrottle/agents/reviewer/instructions.md"],
    [".openthrottle/pipelines/core/review/pipeline.yml", ".openthrottle/pipelines/review/pipeline.yml"],
    [".openthrottle/pipelines/core/review/loops/review-cycle.yml", ".openthrottle/pipelines/review/loops/review-cycle.yml"],
    [".openthrottle/skills/core/review-change/SKILL.md", ".openthrottle/skills/review-change/SKILL.md"],
    [".openthrottle/skills/core/review-change/references/rubric.md", ".openthrottle/skills/review-change/references/rubric.md"],
    [".openthrottle/evals/core/review-result/eval.yml", ".openthrottle/evals/review-result/eval.yml"],
  ] as const;
  for (const [sourcePath, targetPath] of pathReplacements) {
    const file = fixture.platform[sourcePath]!;
    let content = file.content;
    for (const [from, to] of replacements) content = content.replaceAll(from, to);
    content = content.replace("evaluator: review-outcome@1", "evaluator: core/review-outcome@1");
    fixture.repository[targetPath] = { ...file, content };
  }
  fixture.platform = {};
  return fixture;
}

describe("filesystem definition compiler", () => {
  it("reconstructs the byte-identical private manifest from only the pinned bundle", () => {
    const admitted = compile();
    const recovered = compileManifestFromDefinitionBundle({
      bundle: structuredClone(admitted.bundle.value),
      compiler_environment: compilerEnvironment(),
      trusted_platform_definitions: platformHashes(admitted.bundle.value),
    });

    expect(recovered.normalized).toBe(admitted.manifest.normalized);
    expect(recovered.digest).toBe(admitted.manifest.digest);
  });

  it("seals normalized GitHub provider evidence into compilation and cold recovery", () => {
    const configWith = (observations: string) => `${sourceFixture.repository[".openthrottle/config.yml"]!.content}provider_evidence:\n  github:\n    required_observations:\n${observations}`;
    const first = compile(replaceFile(
      sourceFixture,
      "repository",
      ".openthrottle/config.yml",
      configWith([
        "      - kind: commit_status",
        "        context: coverage",
        "        creator_login: coverage-bot",
        "      - kind: check_run",
        "        name: quality",
        "        app_slug: github-actions",
      ].join("\n") + "\n"),
    ));
    const reordered = compile(replaceFile(
      sourceFixture,
      "repository",
      ".openthrottle/config.yml",
      configWith([
        "      - app_slug: github-actions",
        "        name: quality",
        "        kind: check_run",
        "      - creator_login: coverage-bot",
        "        context: coverage",
        "        kind: commit_status",
      ].join("\n") + "\n"),
    ));
    const configEntry = first.bundle.value.entries.find((entry) =>
      entry.definition_kind === "config" && entry.definition_id === "repository")!;

    expect(configEntry.normalized_payload).toMatchObject({
      provider_evidence: {
        github: {
          required_observations: [
            { kind: "check_run", name: "quality", app_slug: "github-actions" },
            { kind: "commit_status", context: "coverage", creator_login: "coverage-bot" },
          ],
        },
      },
    });
    expect(reordered.bundle.digest).toBe(first.bundle.digest);
    expect(reordered.manifest.digest).toBe(first.manifest.digest);

    const changed = compile(replaceFile(
      sourceFixture,
      "repository",
      ".openthrottle/config.yml",
      configWith([
        "      - kind: check_run",
        "        name: quality",
        "        app_slug: another-trusted-app",
        "      - kind: commit_status",
        "        context: coverage",
        "        creator_login: coverage-bot",
      ].join("\n") + "\n"),
    ));
    const changedConfig = changed.bundle.value.entries.find((entry) =>
      entry.definition_kind === "config" && entry.definition_id === "repository")!;
    expect(changedConfig.content_hash).not.toBe(configEntry.content_hash);
    expect(changed.bundle.digest).not.toBe(first.bundle.digest);
    expect(changed.manifest.value.definition_bundle_hash).toBe(changed.bundle.digest);

    const forged = structuredClone(first.bundle.value);
    const forgedConfig = forged.entries.find((entry) => entry.definition_kind === "config")!;
    const forgedPayload = structuredClone(forgedConfig.normalized_payload) as {
      provider_evidence: { github: { required_observations: unknown[] } };
    };
    forgedPayload.provider_evidence.github.required_observations = [];
    forgedConfig.normalized_payload = forgedPayload;
    forgedConfig.content_hash = definitionEntryContentHash(forgedPayload);
    expect(() => compileManifestFromDefinitionBundle({
      bundle: forged,
      compiler_environment: compilerEnvironment(),
      trusted_platform_definitions: platformHashes(first.bundle.value),
    })).toThrow(/required_observations.*between 1 and 32/);
  });

  it("fails cold reconstruction on environment drift, missing dependencies, or a widened closure", () => {
    const admitted = compile();
    const recover = (bundle: DefinitionBundle, environment = compilerEnvironment()) =>
      compileManifestFromDefinitionBundle({
        bundle,
        compiler_environment: environment,
        trusted_platform_definitions: platformHashes(admitted.bundle.value),
      });

    expect(() => recover(admitted.bundle.value, compilerEnvironment({
      compiler_version: "definition-compiler/v2",
    }))).toThrow(/compiler_version.*pinned compiler environment/);

    const missingEval = structuredClone(admitted.bundle.value);
    missingEval.entries = missingEval.entries.filter((entry) => entry.definition_kind !== "eval");
    expect(() => recover(missingEval)).toThrow(/eval core\/review-result is absent/);

    const widened = structuredClone(admitted.bundle.value);
    const sourceSkill = widened.entries.find((entry) => entry.definition_kind === "skill")!;
    const extraPayload = structuredClone(sourceSkill.normalized_payload);
    widened.entries.push({
      ...sourceSkill,
      definition_id: "unused-two",
      origin: { kind: "repository", source_commit: widened.source_commit },
      path: ".openthrottle/skills/unused-two/SKILL.md",
      content_hash: definitionEntryContentHash(extraPayload),
      normalized_payload: extraPayload,
    });
    expect(() => recover(widened)).toThrow(/outside the selected transitive closure.*skill:unused-two/);
  });

  it("emits one golden dependency closure and injects the configured engine", () => {
    const result = compile();

    expect(result.bundle.value.entries.map((entry) => `${entry.definition_kind}:${entry.definition_id}`))
      .toEqual([
        "agent:core/reviewer",
        "config:repository",
        "eval:core/review-result",
        "loop:core/review/review-cycle",
        "pipeline:core/review",
        "skill:core/review-change",
      ]);
    expect(result.bundle.normalized).not.toContain("blob_sha");
    expect(result.bundle.value.entries.find((entry) => entry.definition_kind === "config")?.origin)
      .toEqual({ kind: "repository", source_commit: sourceFixture.source_commit });
    expect(result.bundle.value.entries.filter((entry) => entry.definition_kind !== "config")
      .every((entry) => entry.origin.kind === "platform" && entry.origin.source_commit === null)).toBe(true);
    expect(result.manifest.value.entry_stage).toBe("ot_runtime_provision");
    expect(result.manifest.value.stages.find(({ id }) => id === "review")).toMatchObject({
      kind: "agent",
      engine: "codex",
      loop: { body: ["review"] },
    });
    expect(result.manifest.value.stages.find(({ id }) => id === "review")?.loop)
      .not.toHaveProperty("file");
    expect(result.manifest.value.stages.find(({ id }) => id === "ot_runtime_provision"))
      .toMatchObject({ kind: "effect", effect: "core/daytona-provision@1" });
    expect(result.manifest.value.definition_bundle_hash).toBe(result.bundle.digest);
    expect(result.bundle.digest).toBe("23d8f16ede33039d029fc9ea65abc4cb364f9eec07f72875b343bceda3f0ab73");
    expect(result.manifest.digest).toBe("db244873085516c76858650249a77969f9c87cb5b8523da0fb8f29cab883e3be");
  });

  it("omits exact checked-in core mirrors while preserving platform origin", () => {
    const mirrored = clone(sourceFixture);
    for (const [path, file] of Object.entries(mirrored.platform)) {
      mirrored.repository[path] = { ...file };
    }

    const baseline = compile();
    const result = compile(mirrored);

    expect(result.bundle.normalized).toBe(baseline.bundle.normalized);
    expect(result.manifest.normalized).toBe(baseline.manifest.normalized);
    expect(result.bundle.value.entries.filter((entry) => entry.definition_kind !== "config")
      .every((entry) => entry.origin.kind === "platform")).toBe(true);
  });

  it("does not charge exact core mirrors against the unique compiler budget", () => {
    const nearLimit = clone(sourceFixture);
    for (let index = Object.keys(nearLimit.platform).length; index < 260; index += 1) {
      nearLimit.platform[
        `.openthrottle/skills/core/review-change/references/padding-${String(index).padStart(3, "0")}.md`
      ] = { content: `padding ${index}\n`, blob_sha: index.toString(16).padStart(40, "0") };
    }
    const mirrored = clone(nearLimit);
    for (const [path, file] of Object.entries(mirrored.platform)) {
      mirrored.repository[path] = { ...file };
    }

    expect(Object.keys(mirrored.repository).length + Object.keys(mirrored.platform).length)
      .toBeGreaterThan(VIRTUAL_DEFINITION_MAX_FILES);
    expect(compile(mirrored).bundle.normalized).toBe(compile(nearLimit).bundle.normalized);
  });

  it("rejects changed or extra repository files in the core namespace", () => {
    const changed = clone(sourceFixture);
    for (const [path, file] of Object.entries(changed.platform)) {
      changed.repository[path] = { ...file };
    }
    changed.repository[".openthrottle/agents/core/reviewer/instructions.md"] = {
      ...changed.repository[".openthrottle/agents/core/reviewer/instructions.md"]!,
      content: "Changed repository mirror.\n",
    };
    expect(() => compile(changed)).toThrow(/cannot change or add files in the reserved core namespace/);

    const extra = clone(sourceFixture);
    extra.repository[".openthrottle/agents/core/not-released/instructions.md"] = {
      content: "Not part of the release.\n",
      blob_sha: "f".repeat(40),
    };
    expect(() => compile(extra)).toThrow(/cannot change or add files in the reserved core namespace/);
  });

  it("resolves external loop edges before enforcing final reachability", () => {
    const fixture = replaceFile(
      sourceFixture,
      "platform",
      ".openthrottle/pipelines/core/review/pipeline.yml",
      `schema: openthrottle.pipeline-definition/v1
id: core/review
version: 1
entry: drive
stages:
  - id: drive
    kind: command
    command: test
    loop:
      over: findings
      max_parallel: 2
      max_rounds: 2
      file: loops/review-cycle.yml
    on:
      success: {terminal: completed}
  - id: review
    kind: agent
    agent_id: core/reviewer
    repository_authority: inspect
    skills: [core/review-change]
    entry_skill: core/review-change
    eval: core/review-result
    on:
      success: {terminal: completed}
`,
    );

    expect(compile(fixture).manifest.value.stages.find(({ id }) => id === "drive")).toMatchObject({
      id: "drive",
      loop: { body: ["review"] },
    });
  });

  it("canonicalizes map order, YAML key order, and CRLF to identical bytes", () => {
    const reordered = clone(sourceFixture);
    reordered.repository[".openthrottle/config.yml"] = {
      ...reordered.repository[".openthrottle/config.yml"]!,
      content: "commands:\r\n  test: npm test\r\nengine: codex\r\npipeline: core/review\r\nschema: openthrottle.config/v2\r\n",
    };
    reordered.repository = Object.fromEntries(Object.entries(reordered.repository).reverse());
    reordered.platform = Object.fromEntries(Object.entries(reordered.platform).reverse());

    const baseline = compile();
    const equivalent = compile(reordered);
    expect(equivalent.bundle.normalized).toBe(baseline.bundle.normalized);
    expect(equivalent.bundle.digest).toBe(baseline.bundle.digest);
    expect(equivalent.manifest.normalized).toBe(baseline.manifest.normalized);
  });

  it("excludes unrelated definitions but hashes every selected dependency", () => {
    const baseline = compile();
    const unrelated = replaceFile(
      sourceFixture,
      "repository",
      ".openthrottle/skills/unused/SKILL.md",
      "---\nname: unused\ndescription: Changed but still unrelated.\n---\n\n# Different\n",
    );
    expect(compile(unrelated).bundle.digest).toBe(baseline.bundle.digest);
    const unreferencedPackageFile = clone(sourceFixture);
    unreferencedPackageFile.platform[
      ".openthrottle/skills/core/review-change/references/not-referenced.md"
    ] = {
      content: "Every file in a selected skill package is behavior-affecting.\n",
      blob_sha: "0".repeat(40),
    };
    expect(compile(unreferencedPackageFile).bundle.digest).not.toBe(baseline.bundle.digest);

    const selectedChanges = [
      ["platform", ".openthrottle/agents/core/reviewer/instructions.md", "Changed instructions.\n"],
      [
        "platform",
        ".openthrottle/skills/core/review-change/SKILL.md",
        "---\nname: review-change\ndescription: Review a change and report findings.\n---\n\n# Changed skill\n\nRead [the rubric](references/rubric.md).\n",
      ],
      ["platform", ".openthrottle/skills/core/review-change/references/rubric.md", "# Changed rubric\n"],
      [
        "platform",
        ".openthrottle/pipelines/core/review/loops/review-cycle.yml",
        "schema: openthrottle.pipeline-loop/v1\nid: core/review/review-cycle\nbody: [finalize]\n",
      ],
    ] as const;
    for (const [channel, path, content] of selectedChanges) {
      expect(compile(replaceFile(sourceFixture, channel, path, content)).bundle.digest)
        .not.toBe(baseline.bundle.digest);
    }

    const otherBehaviorInputs = [
      compile(replaceFile(
        sourceFixture,
        "repository",
        ".openthrottle/config.yml",
        `${sourceFixture.repository[".openthrottle/config.yml"]!.content}model: gpt-5.6\n`,
      )).bundle.digest,
      compile(replaceFile(
        sourceFixture,
        "platform",
        ".openthrottle/pipelines/core/review/pipeline.yml",
        sourceFixture.platform[".openthrottle/pipelines/core/review/pipeline.yml"]!.content
          .replace("version: 1", "version: 2"),
      )).bundle.digest,
      compile(replaceFile(
        sourceFixture,
        "platform",
        ".openthrottle/evals/core/review-result/eval.yml",
        sourceFixture.platform[".openthrottle/evals/core/review-result/eval.yml"]!.content
          .replace("max_length: 4000", "max_length: 3999"),
      )).bundle.digest,
      compile(sourceFixture, { compiler_version: "definition-compiler/v2" }).bundle.digest,
      compile(sourceFixture, { runtime_manifest_digest: "c".repeat(64) }).bundle.digest,
      compile(sourceFixture, { evaluator_primitives: [
        "core/action-outcome@1",
        "core/review-outcome@1",
        "core/unit-outcome@1",
        "core/unused-outcome@1",
      ] }).bundle.digest,
    ];
    expect(otherBehaviorInputs.every((digest) => digest !== baseline.bundle.digest)).toBe(true);
  });

  it("binds repository provenance to the exact input commit and ignores reader blob SHAs", () => {
    const baseline = compile();
    const differentCommit = clone(sourceFixture);
    differentCommit.source_commit = "c".repeat(40);
    const recompiled = compile(differentCommit);
    expect(recompiled.bundle.digest).not.toBe(baseline.bundle.digest);
    expect(recompiled.bundle.value.entries.map((entry) => entry.content_hash))
      .toEqual(baseline.bundle.value.entries.map((entry) => entry.content_hash));

    const differentBlobShas = clone(sourceFixture);
    for (const channel of [differentBlobShas.repository, differentBlobShas.platform]) {
      for (const file of Object.values(channel)) file.blob_sha = "f".repeat(40);
    }
    expect(compile(differentBlobShas).bundle.normalized).toBe(baseline.bundle.normalized);
  });

  it("grants platform and environment authority only to verifier-produced immutable snapshots", () => {
    const platform = trustedPlatform(sourceFixture.platform);
    const environment = compilerEnvironment();
    const publicFiles = platform.files as Map<string, VirtualDefinitionFile>;
    publicFiles.set(".openthrottle/agents/core/reviewer/instructions.md", {
      type: "file",
      content: Buffer.from("mutated after verification\n"),
    });
    const result = compileDefinitionBundle({
      repository: {
        source_commit: sourceFixture.source_commit,
        files: virtualFiles(sourceFixture.repository),
      },
      platform,
      compiler_environment: environment,
    });
    expect(result.bundle.digest).toBe(compile().bundle.digest);

    const forgedPlatform = {
      catalog: platform.catalog,
      files: platform.files,
    } as unknown as TrustedPlatformDefinitionSource;
    expect(() => compileDefinitionBundle({
      repository: {
        source_commit: sourceFixture.source_commit,
        files: virtualFiles(sourceFixture.repository),
      },
      platform: forgedPlatform,
      compiler_environment: environment,
    })).toThrow(/produced by verifyPlatformDefinitionSource/);

    const forgedEnvironment = {
      descriptor: environment.descriptor,
    } as unknown as TrustedCompilerEnvironment;
    expect(() => compileDefinitionBundle({
      repository: {
        source_commit: sourceFixture.source_commit,
        files: virtualFiles(sourceFixture.repository),
      },
      platform: trustedPlatform(sourceFixture.platform),
      compiler_environment: forgedEnvironment,
    })).toThrow(/produced by verifyCompilerEnvironment/);
  });

  it("binds every selected repository definition to the exact source commit", () => {
    const fixture = repositoryAuthoredFixture();
    const result = compile(fixture);

    expect(result.bundle.value.pipeline_id).toBe("review");
    expect(result.bundle.value.entries).toHaveLength(6);
    expect(result.bundle.value.entries.every((entry) =>
      entry.origin.kind === "repository" && entry.origin.source_commit === fixture.source_commit
    )).toBe(true);
  });

  it.each([
    ["duplicate YAML keys", "schema: openthrottle.config/v2\npipeline: core/review\nengine: codex\nengine: claude\n", /DUPLICATE_KEY/],
    ["YAML aliases", "schema: openthrottle.config/v2\npipeline: &pipeline core/review\nengine: codex\nmodel: *pipeline\n", /aliases are disabled/],
    ["YAML warnings", "schema: !unknown openthrottle.config/v2\npipeline: core/review\nengine: codex\n", /YAML warning/],
  ])("rejects %s", (_label, content, message) => {
    expect(() => compile(replaceFile(
      sourceFixture,
      "repository",
      ".openthrottle/config.yml",
      content,
    ))).toThrow(message);
  });

  it("rejects YAML before parsing when its byte bound is exceeded", () => {
    const config = `${sourceFixture.repository[".openthrottle/config.yml"]!.content}#${"x".repeat(DEFINITION_YAML_MAX_BYTES)}`;
    expect(() => compile(replaceFile(
      sourceFixture,
      "repository",
      ".openthrottle/config.yml",
      config,
    ))).toThrow(/YAML exceeds/);
  });

  it("rejects unsafe paths, case collisions, symlinks, non-files, NUL, and input bounds", () => {
    const compileFiles = (files: Map<string, VirtualDefinitionFile>) => compileDefinitionBundle({
      repository: { source_commit: sourceFixture.source_commit, files },
      platform: trustedPlatform(sourceFixture.platform),
      compiler_environment: compilerEnvironment(),
    });
    const base = virtualFiles(sourceFixture.repository);

    expect(() => compileFiles(new Map([...base, [
      "../.openthrottle/config.yml",
      { type: "file", content: "x" },
    ]]))).toThrow(/path traversal|relative POSIX path/);
    expect(() => compileFiles(new Map([...base, [
      ".OPENTHROTTLE/CONFIG.YML",
      { type: "file", content: "x" },
    ]]))).toThrow(/case-colliding paths/);
    expect(() => compileFiles(new Map([...base, [
      ".openthrottle/skills/link/SKILL.md",
      { type: "symlink", target: "../../secret" },
    ]]))).toThrow(/must be a regular file/);
    expect(() => compileFiles(new Map([...base, [
      ".openthrottle/skills/directory/SKILL.md",
      { type: "directory" },
    ]]))).toThrow(/must be a regular file/);
    expect(() => compileFiles(new Map([...base, [
      ".openthrottle/skills/nul/SKILL.md",
      { type: "file", content: "---\nname: nul\ndescription: bad\n---\n\u0000" },
    ]]))).toThrow(/NUL/);
    const invalidUtf8 = new Map(base);
    invalidUtf8.set(".openthrottle/config.yml", {
      type: "file",
      content: new Uint8Array([0xc3, 0x28]),
    });
    expect(() => compileFiles(invalidUtf8)).toThrow(/valid UTF-8/);
    expect(() => compileFiles(new Map([...base, [
      ".openthrottle/skills/large/references/a.md",
      { type: "file", content: "x".repeat(VIRTUAL_DEFINITION_MAX_FILE_BYTES + 1) },
    ]]))).toThrow(/file exceeds/);

    const exactFileBound = new Map(base);
    exactFileBound.set(".openthrottle/skills/unused/assets/exact.txt", {
      type: "file",
      content: "x".repeat(VIRTUAL_DEFINITION_MAX_FILE_BYTES),
    });
    expect(() => compileFiles(exactFileBound)).not.toThrow();

    const tooMany = new Map(base);
    for (let index = 0; index <= VIRTUAL_DEFINITION_MAX_FILES; index += 1) {
      tooMany.set(`.openthrottle/skills/unused/references/${index}.md`, { type: "file", content: "x" });
    }
    expect(() => compileFiles(tooMany)).toThrow(/file count exceeds/);

    const tooLarge = new Map(base);
    const chunk = "x".repeat(VIRTUAL_DEFINITION_MAX_FILE_BYTES);
    const chunks = Math.ceil(VIRTUAL_DEFINITION_MAX_TOTAL_BYTES / VIRTUAL_DEFINITION_MAX_FILE_BYTES) + 1;
    for (let index = 0; index < chunks; index += 1) {
      tooLarge.set(`.openthrottle/skills/unused/references/large-${index}.md`, {
        type: "file",
        content: chunk,
      });
    }
    expect(() => compileFiles(tooLarge)).toThrow(/total bytes exceed/);
  });

  it("validates skill frontmatter and all selected package references", () => {
    expect(() => compile(replaceFile(
      sourceFixture,
      "platform",
      ".openthrottle/skills/core/review-change/SKILL.md",
      "---\nname: wrong-name\ndescription: Mismatch.\n---\nBody\n",
    ))).toThrow(/frontmatter\.name.*review-change/);

    const missingReference = clone(sourceFixture);
    delete missingReference.platform[".openthrottle/skills/core/review-change/references/rubric.md"];
    expect(() => compile(missingReference)).toThrow(/references\/rubric\.md.*missing/);

    const cyclicReferences = clone(sourceFixture);
    cyclicReferences.platform[".openthrottle/skills/core/review-change/references/rubric.md"]!.content =
      "Read [more](more.md).\n";
    cyclicReferences.platform[".openthrottle/skills/core/review-change/references/more.md"] = {
      content: "Read [the rubric](rubric.md).\n",
      blob_sha: "e".repeat(40),
    };
    expect(() => compile(cyclicReferences)).toThrow(/references contain a cycle/);

    const nativeToolGrant = replaceFile(
      sourceFixture,
      "platform",
      ".openthrottle/skills/core/review-change/SKILL.md",
      sourceFixture.platform[".openthrottle/skills/core/review-change/SKILL.md"]!.content
        .replace("description:", "allowed-tools: Bash\ndescription:"),
    );
    expect(() => compile(nativeToolGrant)).toThrow(/allowed-tools: unknown field/);
  });

  it("rejects missing pipeline references and unregistered evaluator primitives", () => {
    const missingAgent = replaceFile(
      sourceFixture,
      "platform",
      ".openthrottle/pipelines/core/review/pipeline.yml",
      sourceFixture.platform[".openthrottle/pipelines/core/review/pipeline.yml"]!.content
        .replace("agent_id: core/reviewer", "agent_id: core/missing"),
    );
    expect(() => compile(missingAgent)).toThrow(/agent core\/missing.*not found/);

    const missingEntrySkill = replaceFile(
      sourceFixture,
      "platform",
      ".openthrottle/pipelines/core/review/pipeline.yml",
      sourceFixture.platform[".openthrottle/pipelines/core/review/pipeline.yml"]!.content
        .replace("skills: [core/review-change]", "skills: [core/missing]")
        .replace("entry_skill: core/review-change", "entry_skill: core/missing"),
    );
    expect(() => compile(missingEntrySkill)).toThrow(/skill core\/missing.*not found/);

    const missingEval = replaceFile(
      sourceFixture,
      "platform",
      ".openthrottle/pipelines/core/review/pipeline.yml",
      sourceFixture.platform[".openthrottle/pipelines/core/review/pipeline.yml"]!.content
        .replace("eval: core/review-result", "eval: core/missing"),
    );
    expect(() => compile(missingEval)).toThrow(/eval core\/missing.*not found/);

    const missingLoop = clone(sourceFixture);
    delete missingLoop.platform[".openthrottle/pipelines/core/review/loops/review-cycle.yml"];
    expect(() => compile(missingLoop)).toThrow(/loop file loops\/review-cycle\.yml.*not found/);

    const unknownEvaluator = replaceFile(
      sourceFixture,
      "platform",
      ".openthrottle/evals/core/review-result/eval.yml",
      sourceFixture.platform[".openthrottle/evals/core/review-result/eval.yml"]!.content
        .replace("core/review-outcome@1", "core/not-registered@1"),
    );
    expect(() => compile(unknownEvaluator)).toThrow(/evaluator.*not registered/);

    const inheritedCommand = replaceFile(
      sourceFixture,
      "platform",
      ".openthrottle/pipelines/core/review/pipeline.yml",
      "schema: openthrottle.pipeline-definition/v1\nid: core/review\nversion: 1\nentry: command\nstages:\n  - {id: command, kind: command, command: constructor, on: {success: {terminal: completed}}}\n",
    );
    expect(() => compile(inheritedCommand)).toThrow(/command constructor is not defined/);
  });

  it("rejects transition cycles, loop escapes, repository core shadowing, and unsealed platform paths", () => {
    const cycle = replaceFile(
      sourceFixture,
      "platform",
      ".openthrottle/pipelines/core/review/pipeline.yml",
      "schema: openthrottle.pipeline-definition/v1\nid: core/review\nversion: 1\nentry: one\nstages:\n  - {id: one, kind: command, command: test, on: {success: {to: two}}}\n  - {id: two, kind: command, command: test, on: {success: {to: one}}}\n",
    );
    expect(() => compile(cycle)).toThrow(/unbounded transition cycle/);

    const escape = replaceFile(
      sourceFixture,
      "platform",
      ".openthrottle/pipelines/core/review/pipeline.yml",
      sourceFixture.platform[".openthrottle/pipelines/core/review/pipeline.yml"]!.content
        .replace("loops/review-cycle.yml", "loops/../escape.yml"),
    );
    expect(() => compile(escape)).toThrow(/loop\.file/);

    const shadow = clone(sourceFixture);
    shadow.repository[".openthrottle/skills/core/review-change/SKILL.md"] = {
      content: "---\nname: review-change\ndescription: Shadow.\n---\n",
      blob_sha: "d".repeat(40),
    };
    expect(() => compile(shadow)).toThrow(/reserved core namespace/);

    const override = clone(sourceFixture);
    override.platform[".openthrottle/skills/unused/SKILL.md"] = {
      ...override.repository[".openthrottle/skills/unused/SKILL.md"]!,
    };
    expect(() => compile(override)).toThrow(/reserved core namespace/);

    const duplicateLoopIdentity = clone(sourceFixture);
    duplicateLoopIdentity.platform[".openthrottle/pipelines/core/review/loops/review-cycle.yaml"] = {
      ...duplicateLoopIdentity.platform[".openthrottle/pipelines/core/review/loops/review-cycle.yml"]!,
    };
    expect(() => compile(duplicateLoopIdentity)).toThrow(/duplicate definition loop:core\/review\/review-cycle/);
  });
});
