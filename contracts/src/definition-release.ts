/**
 * Release trust anchors for generated definition inputs.
 *
 * These values intentionally live in compiled source instead of beside the
 * generated JSON they authenticate. The artifact generator fails when its
 * source-derived digests differ, making a release-authorized definition or
 * runtime change an explicit reviewed source edit.
 */
export const RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST =
  "f1b98b0e2a97b2debe28a6b2ffb2dcebc579474c1610c0a29874fa8e728a23f7" as const;

export const RELEASE_COMPILER_ENVIRONMENT_DIGEST =
  "1d5676ce67f0c62e23f8672a015facd51ea19b2567c49a5339f704936a165746" as const;
