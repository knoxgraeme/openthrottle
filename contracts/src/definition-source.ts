export const VIRTUAL_DEFINITION_MAX_FILES = 512;
export const VIRTUAL_DEFINITION_MAX_FILE_BYTES = 512 * 1024;
export const VIRTUAL_DEFINITION_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export type VirtualDefinitionFile =
  | {
    readonly type: "file";
    readonly content: string | Uint8Array;
    /** Reader evidence only. It is deliberately excluded from compiled output. */
    readonly blob_sha?: string;
  }
  | { readonly type: "symlink"; readonly target: string }
  | { readonly type: "directory" };

export type VirtualDefinitionFileMap = ReadonlyMap<string, VirtualDefinitionFile>;

export interface TrustedRepositoryDefinitionSource {
  /** Exact Git commit resolved by the trusted repository reader. */
  readonly source_commit: string;
  readonly files: VirtualDefinitionFileMap;
}
