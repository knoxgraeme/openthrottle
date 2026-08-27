/**
 * Release trust anchors for generated definition inputs.
 *
 * These values intentionally live in compiled source instead of beside the
 * generated JSON they authenticate. The artifact generator fails when its
 * source-derived digests differ, making a release-authorized definition or
 * runtime change an explicit reviewed source edit.
 */
export const RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST =
  "6d6a09a431c8a5f573d92eea0587c496f24c9109681f761065a210264b097859" as const;

export const RELEASE_COMPILER_ENVIRONMENT_DIGEST =
  "b2a856bb5e4df33718f7f9bdfb53711bdd308ac83bd56030af38c188bbdf36aa" as const;
