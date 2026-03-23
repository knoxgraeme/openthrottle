export interface ExecError extends Error {
  stderr?: Buffer | string;
  status?: number | null;
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const execErr = err as ExecError;
    const stderr = execErr.stderr?.toString().trim();
    return stderr || execErr.message;
  }
  return String(err);
}
