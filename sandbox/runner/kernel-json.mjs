import { createHash } from "node:crypto";

const SECRET_ENV_NAME = /(?:TOKEN|SECRET|PASSWORD|AUTH|KEY|CREDENTIAL)/i;

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

function nestedSecretStrings(value) {
  if (!value.trim().startsWith("{") && !value.trim().startsWith("[")) return [];
  try {
    const parsed = JSON.parse(value);
    const strings = [];
    const visit = (item) => {
      if (typeof item === "string" && item.length >= 4) strings.push(item);
      else if (Array.isArray(item)) item.forEach(visit);
      else if (item && typeof item === "object") Object.values(item).forEach(visit);
    };
    visit(parsed);
    return strings;
  } catch {
    return [];
  }
}

function secretValues(env) {
  const values = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_ENV_NAME.test(name) || typeof value !== "string") continue;
    if (value.length >= 4) values.add(value);
    for (const nested of nestedSecretStrings(value)) values.add(nested);
  }
  return [...values].sort((left, right) => right.length - left.length);
}

export function sanitizeArtifactText(value, env = process.env) {
  let text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  for (const secret of secretValues(env)) {
    text = text.split(secret).join("[REDACTED]");
  }
  return text;
}
