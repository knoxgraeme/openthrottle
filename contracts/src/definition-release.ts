/**
 * Release trust anchors for generated definition inputs.
 *
 * These values intentionally live in compiled source instead of beside the
 * generated JSON they authenticate. The artifact generator fails when its
 * source-derived digests differ, making a release-authorized definition or
 * runtime change an explicit reviewed source edit.
 */
export const RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST =
  "9234d9debb240ef661ae870ba53a6cbc514b0b6e9804eda817077aeee1849c46" as const;

export const RELEASE_COMPILER_ENVIRONMENT_DIGEST =
  "0fca4f16aeb857502f86f04d3c1ea8a79ea598ee9c0487d364d44558de86f014" as const;
