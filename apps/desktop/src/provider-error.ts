export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public retryAt?: number,
  ) {
    super(message);
  }
}
