const SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD|AUTH_JSON)/i;
const TOKEN_PATTERNS = [
  /\bgh[opsu]_[A-Za-z0-9_]+\b/g,
  /\bgithub_pat_[A-Za-z0-9_]+\b/g,
  /\bsk-[A-Za-z0-9_-]+\b/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9_]+\b/g,
];
const BEARER_CANDIDATE = /(?:\b|(?<=\\[nrt]))Bearer(?:\s|\\+[nrt])+([A-Za-z0-9._~+/\-]+={0,2})/gi;
const BEARER_PROSE = /^(?:authentication|authorization|credentials?|tokens?)(?:-based)?\.*$/i;

function skipAuthorizationSeparators(text: string, from: number): number {
  let cursor = from;
  while (cursor >= 0) {
    if (/\s/.test(text[cursor]!) || text[cursor] === "\\") {
      cursor -= 1;
      continue;
    }
    if (/[nrt]/.test(text[cursor]!) && cursor > 0 && text[cursor - 1] === "\\") {
      cursor -= 2;
      while (cursor >= 0 && text[cursor] === "\\") cursor -= 1;
      continue;
    }
    break;
  }
  return cursor;
}

function hasAuthorizationContext(text: string, offset: number): boolean {
  let cursor = skipAuthorizationSeparators(text, offset - 1);
  if (text[cursor] === '"' || text[cursor] === "'") {
    cursor = skipAuthorizationSeparators(text, cursor - 1);
  }
  if (text[cursor] !== ":") return false;
  cursor = skipAuthorizationSeparators(text, cursor - 1);
  if (text[cursor] === '"' || text[cursor] === "'") {
    cursor = skipAuthorizationSeparators(text, cursor - 1);
  }
  const start = cursor - "Authorization".length + 1;
  return start >= 0 && text.slice(start, cursor + 1).toLowerCase() === "authorization";
}

function isSecretBearerCandidate(text: string, candidate: string, offset: number): boolean {
  if (hasAuthorizationContext(text, offset)) return true;
  return !BEARER_PROSE.test(candidate);
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
  return redactBearerSecrets(sanitized)
    .replace(/(?:\b|(?<=\\[nrt]))Bearer(?:\s|\\+[nrt])+\[REDACTED\]/gi, "[REDACTED]");
}
