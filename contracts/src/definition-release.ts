/**
 * Release trust anchors for generated definition inputs.
 *
 * These values intentionally live in compiled source instead of beside the
 * generated JSON they authenticate. The artifact generator fails when its
 * source-derived digests differ, making a release-authorized definition or
 * runtime change an explicit reviewed source edit.
 */
export const RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST =
  "37cfd479f2f61957dcf41de5401d8885c35e6580fb61be0f104769413652ebbb" as const;

export const RELEASE_COMPILER_ENVIRONMENT_DIGEST =
  "c93ed63d11d7fbc4db6803f052121e60759f05c6c47edfcecfc53183061b981f" as const;
