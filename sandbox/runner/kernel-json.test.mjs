import { describe, expect, it } from "vitest";
import { sanitizeArtifactText } from "./kernel-json.mjs";

describe("kernel artifact sanitization", () => {
  it("redacts nested JSON secrets longest first", () => {
    const shortSecret = "nested-token-value";
    const longSecret = `${shortSecret}-with-suffix`;
    const env = {
      CODEX_AUTH_JSON: JSON.stringify({
        tokens: {
          id_token: shortSecret,
          access_token: longSecret,
        },
      }),
    };

    expect(sanitizeArtifactText(`${longSecret} ${shortSecret}`, env))
      .toBe("[REDACTED] [REDACTED]");
  });
});
