/**
 * Release trust anchors for generated definition inputs.
 *
 * These values intentionally live in compiled source instead of beside the
 * generated JSON they authenticate. The artifact generator fails when its
 * source-derived digests differ, making a release-authorized definition or
 * runtime change an explicit reviewed source edit.
 */
export const RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST =
  "f7e4f6052032a337f62de7a8341e3952ccf74c89678602f3cb6b29dee5482dc3" as const;

export const RELEASE_COMPILER_ENVIRONMENT_DIGEST =
  "ea815409ec707a3c3c3b2fcf28f334f5a4bbdc9ffa27c0688991fb0dac2fb5fd" as const;
