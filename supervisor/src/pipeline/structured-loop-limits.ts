export const MAX_LOOP_REQUEST_ENVELOPE_BYTES = 262_144;
export const MAX_PRIOR_EVIDENCE_RECEIPTS = 18;
export const MAX_PRIOR_EVIDENCE_BYTES = 49_152;

// Shared with the sandbox loop request validator (sandbox/runner/execute-loop.mjs)
// and the durable downstream-context store (persistence/pipeline/unit-store.ts).
// These three enforcement points must agree on one canonical maximum so that
// admission sizing, persistence, and the sandbox boundary reject the exact
// same envelope.
export const MAX_DOWNSTREAM_CONTEXT_RECORDS = 32;
export const MAX_DOWNSTREAM_CONTEXT_BYTES = 32_768;
export const MAX_DOWNSTREAM_CONTEXT_RECORD_PAYLOAD_BYTES = 8_192;
