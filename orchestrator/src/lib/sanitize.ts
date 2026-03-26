const SECRET_ENV_VARS = [
  "GITHUB_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "SUPABASE_ACCESS_TOKEN",
  "OPENAI_API_KEY",
];

const TOKEN_PATTERNS = [
  /ghp_[A-Za-z0-9_]{36,}/g,
  /ghs_[A-Za-z0-9_]{36,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /Bearer [^ ]*/g,
];

export function sanitizeSecrets(text: string): string {
  let result = text;

  for (const envVar of SECRET_ENV_VARS) {
    const value = process.env[envVar];
    if (value) {
      result = result.replaceAll(value, "[REDACTED]");
    }
  }

  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }

  return result;
}
