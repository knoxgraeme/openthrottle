/**
 * Release trust anchors for generated definition inputs.
 *
 * These values intentionally live in compiled source instead of beside the
 * generated JSON they authenticate. The artifact generator fails when its
 * source-derived digests differ, making a release-authorized definition or
 * runtime change an explicit reviewed source edit.
 */
export const RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST =
  "d75c093c8ede4e2517c08cb03801cdb90e3ddf38105ddd2d2c451ae59de0a1ae" as const;

export const RELEASE_COMPILER_ENVIRONMENT_DIGEST =
  "89a1add89ea040665c34a59282355eef0d703d69a10c7706bc095d43abb15731" as const;
