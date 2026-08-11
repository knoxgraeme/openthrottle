const SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD|AUTH_JSON)/i;
const TOKEN_PATTERNS = [
  /\bgh[opsu]_[A-Za-z0-9_]+\b/g,
  /\bgithub_pat_[A-Za-z0-9_]+\b/g,
  /\bsk-[A-Za-z0-9_-]+\b/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9_]+\b/g,
];
const BEARER_CANDIDATE = /\bBearer[ \t]+([A-Za-z0-9._~+/\-]+={0,2})/gi;
const BEARER_PROSE = new Set(["authentication", "authorization", "credential", "credentials", "token", "tokens"]);

function isSecretBearerCandidate(text: string, candidate: string, offset: number): boolean {
  const context = text.slice(Math.max(0, offset - 48), offset).replaceAll("\\", "");
  if (/Authorization["']?[ \t]*:[ \t]*["']?[ \t]*$/i.test(context)) return true;
  const proseCandidate = candidate.toLowerCase().replace(/\.+$/, "");
  return !BEARER_PROSE.has(proseCandidate);
}

function redactBearerSecrets(text: string): string {
  return text.replace(BEARER_CANDIDATE, (match, candidate: string, offset: number) =>
    isSecretBearerCandidate(text, candidate, offset) ? "[REDACTED]" : match);
}

export function containsSecretShapedValue(text: string): boolean {
  if (TOKEN_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text))) {
    return true;
  }
  for (const match of text.matchAll(BEARER_CANDIDATE)) {
    if (isSecretBearerCandidate(text, match[1]!, match.index)) return true;
  }
  return false;
}

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
  return redactBearerSecrets(sanitized).replace(/\bBearer[ \t]+\[REDACTED\]/gi, "[REDACTED]");
}
