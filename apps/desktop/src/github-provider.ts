import { Octokit } from '@octokit/rest';
import { providerOriginSchema } from '@openkraken/ipc-contract';

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface ProviderDriver {
  identity(
    origin: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; login: string }>;
}
export class GitHubProvider implements ProviderDriver {
  constructor(private fetcher: typeof fetch = (...args) => fetch(...args)) {}
  async identity(origin: string, token: string, signal?: AbortSignal) {
    const host = providerOriginSchema.parse(origin);
    const baseUrl = host === 'https://github.com' ? 'https://api.github.com' : `${host}/api/v3`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const boundedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const guardedFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== new URL(baseUrl).origin || url.username || url.password)
        throw new ProviderError('PROVIDER_HOST', 'Provider request changed its configured host.');
      const response = await this.fetcher(input, {
        ...init,
        signal: boundedSignal,
        redirect: 'error',
        credentials: 'omit',
      });
      if (response.status >= 300 && response.status < 400)
        throw new ProviderError(
          'PROVIDER_REDIRECT',
          'The provider redirected the request. Check the configured host.',
        );
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        if (reader)
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            bytes += item.value.length;
            if (bytes > 4 * 1024 * 1024)
              throw new ProviderError(
                'PROVIDER_LIMIT',
                'The provider response exceeded the display limit.',
              );
            chunks.push(item.value);
          }
      } finally {
        await reader?.cancel().catch(() => {});
      }
      return new Response(bytes ? Buffer.concat(chunks) : null, {
        status: response.status,
        headers: response.headers,
      });
    };
    const client = new Octokit({
      auth: token,
      baseUrl,
      userAgent: 'OpenKraken/0.1.0',
      request: { fetch: guardedFetch },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    try {
      const { data } = await client.users.getAuthenticated({
        headers: {
          'X-GitHub-Api-Version': host === 'https://github.com' ? '2026-03-10' : '2022-11-28',
        },
      });
      if (!Number.isSafeInteger(data.id) || data.id <= 0 || typeof data.login !== 'string')
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'The provider returned an invalid account identity.',
        );
      return { id: String(data.id), login: data.login };
    } catch (error) {
      if (signal?.aborted) throw new ProviderError('CANCELLED', 'Provider request cancelled.');
      if (controller.signal.aborted)
        throw new ProviderError('PROVIDER_TIMEOUT', 'The provider did not respond in time.');
      if (error instanceof ProviderError) throw error;
      const status = (error as { status?: number }).status;
      throw new ProviderError(
        status === 401
          ? 'PROVIDER_AUTH'
          : status === 403
            ? 'PROVIDER_FORBIDDEN'
            : status === 429
              ? 'PROVIDER_RATE_LIMIT'
              : 'PROVIDER_REQUEST',
        status === 401
          ? 'The provider rejected this token. Check its validity and permissions.'
          : status === 403
            ? 'The provider denied access. Check account permissions or rate limits.'
            : status === 429
              ? 'The provider rate limit was reached. Try again later.'
              : 'The provider request failed. Check the host and connection.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
