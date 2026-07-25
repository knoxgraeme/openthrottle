const SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD|AUTH_JSON)/i;
const TOKEN_PATTERNS = [
  /\bgh[opsu]_[A-Za-z0-9_]+\b/g,
  /\bgithub_pat_[A-Za-z0-9_]+\b/g,
  /\bsk-[A-Za-z0-9_-]+\b/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9_]+\b/g,
  /Bearer\s+\S+/gi,
];

function nestedSecretStrings(value: string): string[] {
  if (!value.trim().startsWith("{") && !value.trim().startsWith("[")) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    const strings: string[] = [];
    const visit = (item: unknown) => {
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

export function collectSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_NAME.test(name)) continue;
    if (value.length >= 4) values.add(value);
    for (const nested of nestedSecretStrings(value)) values.add(nested);
  }
  return [...values].sort((left, right) => right.length - left.length);
}

export function sanitizeText(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  extraSecrets: string[] = []
): string {
  let sanitized = text;
  const values = [...collectSecretValues(env), ...extraSecrets]
    .filter((value) => value.length >= 4)
    .sort((left, right) => right.length - left.length);
  for (const value of new Set(values)) sanitized = sanitized.split(value).join("[REDACTED]");
  for (const pattern of TOKEN_PATTERNS) sanitized = sanitized.replace(pattern, "[REDACTED]");
  return sanitized;
}
