import { expect } from "vitest";

export function assertProviderSchemaCompatibility(value: unknown, path = "$"): void {
  expect(value, `${path} must be a schema object`).toBeTypeOf("object");
  expect(value, `${path} must be a schema object`).not.toBeNull();
  expect(Array.isArray(value), `${path} must be a schema object`).toBe(false);
  const schema = value as Record<string, unknown>;
  expect(
    typeof schema.type === "string" || Array.isArray(schema.anyOf) || typeof schema.$ref === "string",
    `${path} must declare type, anyOf, or $ref`,
  ).toBe(true);
  expect(schema, `${path} uses unsupported uniqueItems`).not.toHaveProperty("uniqueItems");
  if (Object.hasOwn(schema, "const")) {
    const expectedType = schema.const === null
      ? "null"
      : Array.isArray(schema.const)
        ? "array"
        : typeof schema.const;
    expect(schema.type, `${path}.type for const`).toBe(expectedType);
  }
  if (schema.type === "object") {
    expect(schema.additionalProperties, `${path}.additionalProperties`).toBe(false);
    expect(schema.properties, `${path}.properties`).toBeTypeOf("object");
    expect(schema.required, `${path}.required`).toEqual(
      Object.keys(schema.properties as Record<string, unknown>).sort(),
    );
  }
  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((entry, index) => assertProviderSchemaCompatibility(entry, `${path}.anyOf[${index}]`));
  }
  if (schema.items !== undefined) {
    assertProviderSchemaCompatibility(schema.items, `${path}.items`);
  }
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    for (const [key, entry] of Object.entries(schema.properties)) {
      assertProviderSchemaCompatibility(entry, `${path}.properties.${key}`);
    }
  }
  if (schema.$defs && typeof schema.$defs === "object" && !Array.isArray(schema.$defs)) {
    for (const [key, entry] of Object.entries(schema.$defs)) {
      assertProviderSchemaCompatibility(entry, `${path}.$defs.${key}`);
    }
  }
}
