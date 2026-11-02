import { Users } from '@gitbeaker/rest';
import { createRequesterFn } from '@gitbeaker/requester-utils';
import { z } from 'zod';
import { providerOriginSchema } from '@openkraken/ipc-contract';
import { ProviderError } from './provider-error.js';
import { ProviderPollingPolicy } from './provider-polling-policy.js';

/** Gitbeaker endpoints with a bounded, cancellable transport and no implicit retries. */
export class GitLabProvider {
  private policy = new ProviderPollingPolicy();
  constructor(private fetcher: typeof fetch = (...args) => fetch(...args)) {}
  clearReadCache() {}
  pollingPolicy(origin: string, token: string) {
    return this.policy.get(origin, token);
  }
  async identity(origin: string, token: string, signal?: AbortSignal) {
    const host = providerOriginSchema.parse(origin);
    this.policy.assertAllowed(host, token);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      combined.throwIfAborted();
      const users = new Users({
        host,
        oauthToken: token,
        requesterFn: createRequesterFn(
          (_, options) => Promise.resolve(options),
          async (endpoint, options) => {
            if (endpoint !== 'user') throw new Error('endpoint');
            const url = `${host}/api/v4/${endpoint}`;
            const response = await this.fetcher(url, {
              method: 'GET',
              headers: {
                ...(options?.headers as Record<string, string>),
                'User-Agent': 'OpenKraken/0.1.0',
              },
              credentials: 'omit',
              redirect: 'error',
              signal: combined,
            });
            const headers = new Headers(response.headers);
            for (const name of ['remaining', 'reset']) {
              const value = headers.get(`ratelimit-${name}`);
              if (value !== null) headers.set(`x-ratelimit-${name}`, value);
            }
            this.policy.observe(host, token, url, response.status, headers);
            const reader = response.body?.getReader();
            const chunks: Uint8Array[] = [];
            let length = 0;
            try {
              if (!response.ok) {
                this.policy.assertAllowed(host, token);
                throw new ProviderError(
                  response.status === 401 || response.status === 403
                    ? 'PROVIDER_AUTH'
                    : 'PROVIDER_REQUEST',
                  response.status === 401 || response.status === 403
                    ? 'The provider rejected this token. Check its validity and permissions.'
                    : 'The GitLab account request failed. Check the connection and try again.',
                );
              }
              if (reader)
                for (;;) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  length += chunk.value.length;
                  if (length > 32768) throw new Error('size');
                  chunks.push(chunk.value);
                }
            } finally {
              await reader?.cancel().catch(() => {});
            }
            return {
              body: z
                .record(z.string(), z.unknown())
                .parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))),
              headers: Object.fromEntries(response.headers),
              status: response.status,
            };
          },
        ),
      });
      const result = z
        .object({
          id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          username: z.string().min(1).max(255),
        })
        .parse(await users.showCurrentUser());
      combined.throwIfAborted();
      return { id: String(result.id), login: result.username };
    } catch (error) {
      if (signal?.aborted) throw new ProviderError('CANCELLED', 'GitLab request cancelled.');
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        'PROVIDER_REQUEST',
        'The GitLab account request failed. Check the connection and try again.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
