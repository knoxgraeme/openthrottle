/**
 * Release trust anchors for generated definition inputs.
 *
 * These values intentionally live in compiled source instead of beside the
 * generated JSON they authenticate. The artifact generator fails when its
 * source-derived digests differ, making a release-authorized definition or
 * runtime change an explicit reviewed source edit.
 */
export const RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST =
  "348ec25762f668311897564ee9c6e77c9398aa249c5098c4f90b505b571d85ac" as const;

export const RELEASE_COMPILER_ENVIRONMENT_DIGEST =
  "c93ed63d11d7fbc4db6803f052121e60759f05c6c47edfcecfc53183061b981f" as const;
