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
  "ecab562f2a939b33e53936fe8d96bb7b3edf2e0585ef042263344e0bb059bd53" as const;
