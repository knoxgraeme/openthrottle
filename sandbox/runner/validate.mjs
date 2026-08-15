// Shared low-level request-validation primitives for the runner executables.
// execute-stage.mjs, execute-loop.mjs, repository-skills.mjs, and
// native-session-package.mjs previously carried byte-identical copies of
// these helpers and regexes; this leaf module (no runner imports) is now the
// single definition. Error messages are part of the executor contract and
// must stay byte-identical when editing here.

export const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
// Ticket identities are provider-qualified and GitHub's external thread
// identifier includes a `#` (for example, github:owner/repo#123). Keep this
// distinct from generic IDs so accepting ticket syntax does not widen fields
// that may be used as path components.
export const ISSUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/;
// Session identities extend ticket identities with a provider activation
// suffix, so GitHub sessions retain the same safe `#` thread separator.
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/;
export const STAGE_PATH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const NATIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export const SHA256 = /^[a-f0-9]{64}$/;
// repository-skills.mjs and execute-stage.mjs name the sha256 shape DIGEST;
// execute-loop.mjs names it SHA256. One regex, both names.
export const DIGEST = SHA256;

export function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function string(value, label, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function boundedText(value, label, maxLength) {
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`${label} is invalid`);
  return value;
}
