import {
  compileDefinitionBundle,
  type DefinitionCompilation,
  type TrustedCompilerEnvironment,
  type TrustedPlatformDefinitionSource,
  type TrustedRepositoryDefinitionSource,
} from "@openthrottle/contracts";

export interface ExactDefinitionSourceReader {
  read(repository: string, commit: string): Promise<TrustedRepositoryDefinitionSource>;
}

/**
 * Provider-neutral admission seam for compiling one exact repository subject.
 * The caller owns ref resolution; this adapter never rereads a branch or tag.
 */
export async function compileRepositoryDefinitionAtCommit(input: {
  repository: string;
  commit: string;
  expectedPipeline?: string;
  sourceReader: ExactDefinitionSourceReader;
  platform: TrustedPlatformDefinitionSource;
  compilerEnvironment: TrustedCompilerEnvironment;
}): Promise<DefinitionCompilation> {
  const repository = await input.sourceReader.read(input.repository, input.commit);
  if (repository.source_commit !== input.commit) {
    throw new Error("definition source reader returned a different commit than requested");
  }
  return compileDefinitionBundle({
    repository,
    platform: input.platform,
    compiler_environment: input.compilerEnvironment,
    ...(input.expectedPipeline === undefined
      ? {}
      : { selected_pipeline: input.expectedPipeline }),
  });
}
