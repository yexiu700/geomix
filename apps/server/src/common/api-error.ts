export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
