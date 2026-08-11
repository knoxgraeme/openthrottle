export const PATH_SAFE_ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isPathSafeActionId(value: string): boolean {
  return PATH_SAFE_ACTION_ID_PATTERN.test(value);
}

export function assertPathSafeActionId(value: string, label: string): string {
  if (!isPathSafeActionId(value)) throw new Error(`${label} is not path-safe`);
  return value;
}
