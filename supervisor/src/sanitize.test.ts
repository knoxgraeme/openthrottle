import { describe, expect, it } from "vitest";
import { collectSecretValues, sanitizeText } from "./sanitize.js";

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
      "Bearer opaque-value",
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
});
