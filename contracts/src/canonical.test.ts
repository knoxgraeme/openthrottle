import { describe, expect, it } from "vitest";
import { canonicalBytes, canonicalJson, digestCanonicalJson, digestNormalized } from "./canonical.js";

describe("canonical JSON utilities", () => {
  it("sorts object keys recursively without changing array order", () => {
    const value = {
      z: 1,
      a: [{ d: 4, b: 2 }, { c: 3, a: 1 }],
    };

    expect(canonicalJson(value)).toBe('{"a":[{"b":2,"d":4},{"a":1,"c":3}],"z":1}');
  });

  it("digests canonical UTF-8 bytes with sha256", () => {
    const value = { b: 2, a: 1 };
    const canonical = '{"a":1,"b":2}';

    expect(Buffer.from(canonicalBytes(value)).toString("utf8")).toBe(canonical);
    expect(digestCanonicalJson(value)).toBe(digestNormalized(canonical));
    expect(digestCanonicalJson(value)).toBe("43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
  });
});
