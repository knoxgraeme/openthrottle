import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  RELEASE_COMPILER_ENVIRONMENT_DIGEST,
  RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
  canonicalJson,
  validatePlatformDefinitionCatalog,
  verifyCompilerEnvironment,
  verifyPlatformDefinitionSource,
  type TrustedRepositoryDefinitionSource,
} from "@openthrottle/contracts";
import { VerifiedKernelManifestResolver } from "../app/kernel-composition.js";
import { compileRepositoryDefinitionAtCommit } from "./definition-compilation.js";
import { getRepositoryDefinitionSourceAtCommit } from "../providers/github/client.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const parityGolden = JSON.parse(readFileSync(
  join(repositoryRoot, "contracts", "fixtures", "definition-compiler", "committed-golden.json"),
  "utf8",
)) as {
  source_commit: string;
  bundle_digest: string;
  manifest_digest: string;
};
const commit = parityGolden.source_commit;

function releaseInputs() {
  const catalog = validatePlatformDefinitionCatalog(JSON.parse(readFileSync(
    join(repositoryRoot, "contracts", "generated", "platform-definition-catalog.json"),
    "utf8",
  ))).value;
  const files = new Map(catalog.files.map(({ path }) => [
    path,
    {
      type: "file" as const,
      content: new Uint8Array(readFileSync(join(repositoryRoot, ...path.split("/")))),
    },
  ]));
  return {
    platform: verifyPlatformDefinitionSource(
      catalog,
      files,
      RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
    ),
    compilerEnvironment: verifyCompilerEnvironment(
      JSON.parse(readFileSync(
        join(repositoryRoot, "contracts", "generated", "compiler-environment.json"),
        "utf8",
      )),
      RELEASE_COMPILER_ENVIRONMENT_DIGEST,
    ),
  };
}

function repositorySource(sourceCommit = commit): TrustedRepositoryDefinitionSource {
  return {
    source_commit: sourceCommit,
    files: new Map([[".openthrottle/config.yml", {
      type: "file",
      content: readFileSync(join(
        repositoryRoot,
        "contracts",
        "fixtures",
        "definition-compiler",
        "committed-repository",
        ".openthrottle",
        "config.yml",
      )),
    }]]),
  };
}

describe("repository definition compilation adapter", () => {
  it("compiles only the exact source returned for the requested commit", async () => {
    const read = vi.fn(async () => repositorySource());
    const release = releaseInputs();

    const result = await compileRepositoryDefinitionAtCommit({
      repository: "owner/repository",
      commit,
      sourceReader: { read },
      ...release,
    });

    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith("owner/repository", commit);
    expect(result.bundle.value.source_commit).toBe(commit);
    expect(result.manifest.value.pipeline_id).toBe("core/implement");
    expect(result.bundle.digest).toBe(parityGolden.bundle_digest);
    expect(result.manifest.digest).toBe(parityGolden.manifest_digest);
  });

  it("cold-reconstructs the admitted manifest from canonical bundle bytes", async () => {
    const release = releaseInputs();
    const result = await compileRepositoryDefinitionAtCommit({
      repository: "owner/repository",
      commit,
      sourceReader: { read: async () => repositorySource() },
      ...release,
    });
    const trustedPlatformDefinitions = new Map(result.bundle.value.entries
      .filter((entry) => entry.origin.kind === "platform")
      .map((entry) => [
        `${entry.definition_kind}:${entry.definition_id}`,
        entry.content_hash,
      ]));
    const resolver = new VerifiedKernelManifestResolver({
      compiler_environment: release.compilerEnvironment,
      trusted_platform_definitions: trustedPlatformDefinitions,
    });

    const recovered = resolver.resolve({
      pipeline_id: result.bundle.value.pipeline_id,
      definition_bundle_hash: result.bundle.digest,
      definition_bundle_bytes: new TextEncoder().encode(result.bundle.normalized),
    });

    expect(canonicalJson(recovered)).toBe(result.manifest.normalized);
  });

  it("matches the golden through the production exact-commit GitHub reader", async () => {
    const rootTree = "b".repeat(40);
    const definitionTree = "c".repeat(40);
    const configBlob = "d".repeat(40);
    const config = readFileSync(join(
      repositoryRoot,
      "contracts/fixtures/definition-compiler/committed-repository/.openthrottle/config.yml",
    ));
    const fetchMock = vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      if (url.endsWith(`/git/commits/${commit}`)) {
        return Response.json({ sha: commit, tree: { sha: rootTree } });
      }
      if (url.endsWith(`/git/trees/${rootTree}`)) {
        return Response.json({
          sha: rootTree,
          truncated: false,
          tree: [{ path: ".openthrottle", mode: "040000", type: "tree", sha: definitionTree }],
        });
      }
      if (url.endsWith(`/git/trees/${definitionTree}?recursive=1`)) {
        return Response.json({
          sha: definitionTree,
          truncated: false,
          tree: [{
            path: "config.yml",
            mode: "100644",
            type: "blob",
            sha: configBlob,
            size: config.byteLength,
          }],
        });
      }
      if (url.endsWith(`/git/blobs/${configBlob}`)) {
        return Response.json({
          sha: configBlob,
          encoding: "base64",
          content: config.toString("base64"),
          size: config.byteLength,
        });
      }
      throw new Error(`unexpected GitHub request: ${url}`);
    });
    const release = releaseInputs();

    const result = await compileRepositoryDefinitionAtCommit({
      repository: "owner/repository",
      commit,
      sourceReader: {
        read: (repository, sourceCommit) => getRepositoryDefinitionSourceAtCommit(
          { token: "token", fetch: fetchMock },
          repository,
          sourceCommit,
        ),
      },
      ...release,
    });

    expect(result.bundle.digest).toBe(parityGolden.bundle_digest);
    expect(result.manifest.digest).toBe(parityGolden.manifest_digest);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects a reader that returns a different commit", async () => {
    const release = releaseInputs();
    await expect(compileRepositoryDefinitionAtCommit({
      repository: "owner/repository",
      commit,
      sourceReader: { read: async () => repositorySource("b".repeat(40)) },
      ...release,
    })).rejects.toThrow(/different commit/);
  });

  it("selects an explicit pipeline without rewriting committed config bytes", async () => {
    const release = releaseInputs();
    const result = await compileRepositoryDefinitionAtCommit({
      repository: "owner/repository",
      commit,
      expectedPipeline: "core/structured",
      sourceReader: { read: async () => repositorySource() },
      ...release,
    });

    expect(result.bundle.value.pipeline_id).toBe("core/structured");
    expect(result.bundle.value.pipeline_selection).toBe("explicit");
    expect(result.bundle.value.entries.find(({ definition_kind }) => definition_kind === "config"))
      .toMatchObject({ normalized_payload: { pipeline: "core/implement" } });
  });
});
