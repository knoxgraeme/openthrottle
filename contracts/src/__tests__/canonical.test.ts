import { describe, expect, it } from "vitest";
import { canonicalJson, digestNormalized } from "../canonical.js";
import { DIGEST_DETERMINISM_FIXTURE } from "../__fixtures__/determinism.js";

describe("canonical JSON utilities", () => {
  it("sorts object keys recursively without reordering arrays", () => {
    expect(canonicalJson(DIGEST_DETERMINISM_FIXTURE)).toBe(
      "{\"alpha\":{\"array\":[3,1,2],\"nested\":{\"a\":\"first\",\"z\":\"last\"}},\"number\":42,\"unicode\":\"stage-c-u1a\",\"zulu\":[{\"alpha\":1,\"bravo\":2},[\"delta\",{\"alpha\":null,\"charlie\":true}]]}"
    );
  });

  it("returns a sha256 hex digest for normalized bytes", () => {
    expect(digestNormalized(canonicalJson(DIGEST_DETERMINISM_FIXTURE))).toMatch(/^[a-f0-9]{64}$/);
  });
});
