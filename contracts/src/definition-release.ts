/**
 * Release trust anchors for generated definition inputs.
 *
 * These values intentionally live in compiled source instead of beside the
 * generated JSON they authenticate. The artifact generator fails when its
 * source-derived digests differ, making a release-authorized definition or
 * runtime change an explicit reviewed source edit.
 */
export const RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST =
  "7c31f8181e6bfe3f9707bd064539cf289b9af7ee6c616a767dee804d0e090c27" as const;

export const RELEASE_COMPILER_ENVIRONMENT_DIGEST =
  "21ab2cb250c2a2293f4c823ba4412df183f56bb53fb983ee52440a8bcf8aa3b9" as const;
