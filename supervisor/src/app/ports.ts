export class RepositoryRefConflictError extends Error {
  readonly retryable = false;
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "RepositoryRefConflictError";
  }
}
