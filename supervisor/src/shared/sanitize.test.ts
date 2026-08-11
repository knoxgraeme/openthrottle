import { describe, expect, it } from "vitest";
import { collectSecretValues, containsSecretShapedValue, sanitizeText } from "./sanitize.js";

describe("sanitizeText", () => {
  it("redacts named secrets, nested auth values, and known token shapes", () => {
    const env = {
      GITHUB_TOKEN: "named-secret-value",
      CODEX_AUTH_JSON: JSON.stringify({ tokens: { access_token: "inner-access-token" } }),
      HARMLESS: "visible-value",
    };
    const input = [
      "named-secret-value",
      "inner-access-token",
      "visible-value",
      "ghp_abcdefghijklmnopqrstuvwxyz",
      "github_pat_abcdefghijklmnopqrstuvwxyz",
      "sk-project-secret",
      "lin_api_secretvalue",
      "lin_oauth_secretvalue",
      "Bearer opaque-value-1234567890",
    ].join(" ");

    const result = sanitizeText(input, env);

    expect(result).not.toContain("named-secret-value");
    expect(result).not.toContain("inner-access-token");
    expect(result).toContain("visible-value");
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(8);
  });

  it("sorts longer overlapping values first and ignores short values", () => {
    expect(collectSecretValues({ API_KEY: "abcd-long", OTHER_KEY: "abcd", TINY_KEY: "abc" })).toEqual([
      "abcd-long",
      "abcd",
    ]);
  });

  it("distinguishes bearer-token shapes from ordinary bearer prose", () => {
    const prose = "CODEX_AUTH_JSON bearer credentials. Supports Bearer authentication, and Bearer token.";
    expect(sanitizeText(prose, {})).toBe(prose);
    expect(containsSecretShapedValue(prose)).toBe(false);

    for (const secret of [
      "Bearer eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl",
      "Bearer k7dP3nQ9xR2mV8z",
      "Bearer opaque._~+/-value-1234567890=",
      "Authorization: Bearer abc123",
      '{"authorization":"Bearer abc123"}',
      'summary: "{\\"authorization\\":\\"Bearer abc123\\"}"',
    ]) {
      expect(sanitizeText(secret, {})).not.toContain(secret.split("Bearer ")[1]);
      expect(sanitizeText(secret, {})).toContain("[REDACTED]");
      expect(containsSecretShapedValue(secret)).toBe(true);
    }
  });
});
