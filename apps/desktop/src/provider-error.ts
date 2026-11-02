export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public retryAt?: number,
    public readonly httpStatus?: number,
  ) {
    super(message);
  }
}
