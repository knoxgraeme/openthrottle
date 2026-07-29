export const CANONICAL_DETERMINISM_FIXTURE = {
  zeta: [
    { nested: { beta: true, alpha: false }, id: "second" },
    { id: "first", nested: { delta: null, gamma: [3, 1, 2] } },
  ],
  alpha: {
    empty: {},
    unicode: "plain-ascii-fixture",
    number: 123.45,
  },
  middle: [
    "value",
    0,
    false,
    null,
  ],
};

export interface CanonicalDigestFixtureResult {
  environment: string;
  canonicalJson: string;
  digest: string;
}
