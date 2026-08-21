import { createHash } from "node:crypto";

function canonicalValue(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON cannot contain a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") throw new Error("value is not canonical JSON");
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function digestCanonicalJson(value) {
  return digest(canonicalJson(value));
}

export function sanitizeArtifactText(value, env = process.env) {
  let text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  for (const [name, secret] of Object.entries(env)) {
    if (!/(?:TOKEN|SECRET|PASSWORD|AUTH|KEY|CREDENTIAL)/i.test(name) || typeof secret !== "string" || secret.length < 4) continue;
    text = text.split(secret).join("[REDACTED]");
  }
  return text;
}
