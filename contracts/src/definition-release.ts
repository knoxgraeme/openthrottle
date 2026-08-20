/**
 * Release trust anchors for generated definition inputs.
 *
 * These values intentionally live in compiled source instead of beside the
 * generated JSON they authenticate. The artifact generator fails when its
 * source-derived digests differ, making a release-authorized definition or
 * runtime change an explicit reviewed source edit.
 */
export const RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST =
  "e0c704a91c1a5d32e65b7e56f89b93c773ae57fe8b157d595d8ce8cdb939ac4f" as const;

export const RELEASE_COMPILER_ENVIRONMENT_DIGEST =
  "21ab2cb250c2a2293f4c823ba4412df183f56bb53fb983ee52440a8bcf8aa3b9" as const;
