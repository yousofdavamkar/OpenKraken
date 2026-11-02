import { Users, Projects } from '@gitbeaker/rest';
import { createRequesterFn, type BaseResourceOptions } from '@gitbeaker/requester-utils';
import { z } from 'zod';
import {
  providerOriginSchema,
  providerRepositoryPageNumberSchema,
  providerRepositoryPageSchema,
  providerNamespaceSchema,
  providerRepositoryPathComponentSchema,
} from '@openkraken/ipc-contract';
import { ProviderError } from './provider-error.js';
import { ProviderPollingPolicy } from './provider-polling-policy.js';

const projectSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  path_with_namespace: z.string().min(3).max(2304),
  path: providerRepositoryPathComponentSchema,
  description: z.string().max(4096).nullable(),
  visibility: z.enum(['public', 'internal', 'private']),
  archived: z.boolean(),
});
/** Gitbeaker endpoints with a bounded, cancellable transport and no implicit retries. */
export class GitLabProvider {
  private policy = new ProviderPollingPolicy();
  constructor(private fetcher: typeof fetch = (...args) => fetch(...args)) {}
  clearReadCache() {}
  pollingPolicy(origin: string, token: string) {
    return this.policy.get(origin, token);
  }
  async identity(origin: string, token: string, signal?: AbortSignal) {
    return this.request(origin, token, signal, async (options) => {
      const result = z
        .object({
          id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          username: z.string().min(1).max(255),
        })
        .parse(await new Users(options).showCurrentUser());
      return { id: String(result.id), login: result.username };
    });
  }
  async repositories(origin: string, token: string, page: number, signal?: AbortSignal) {
    providerRepositoryPageNumberSchema.parse(page);
    const host = providerOriginSchema.parse(origin);
    return this.request(host, token, signal, async (options) => {
      const data = z
        .array(projectSchema)
        .max(100)
        .parse(
          await new Projects(options).all({
            membership: true,
            pagination: 'offset',
            page,
            perPage: 100,
            orderBy: 'id',
            sort: 'asc',
            maxPages: 1,
          }),
        );
      return providerRepositoryPageSchema.parse({
        repositories: data.map((project) => {
          const parts = project.path_with_namespace.split('/');
          const owner = providerNamespaceSchema.parse(parts.slice(0, -1).join('/'));
          if (parts.at(-1) !== project.path)
            throw new ProviderError(
              'PROVIDER_RESPONSE',
              'GitLab returned an invalid repository path.',
            );
          return {
            id: String(project.id),
            owner,
            name: project.path,
            description: project.description ?? '',
            private: project.visibility !== 'public',
            visibility: project.visibility,
            archived: project.archived,
            cloneUrl: `${host}/${owner}/${project.path}.git`,
          };
        }),
        nextPage: data.length === 100 && page < 100 ? page + 1 : null,
        limited: data.length === 100 && page === 100,
      });
    });
  }
  private async request<T>(
    origin: string,
    token: string,
    signal: AbortSignal | undefined,
    perform: (options: BaseResourceOptions<false>) => Promise<T>,
  ) {
    const host = providerOriginSchema.parse(origin);
    this.policy.assertAllowed(host, token);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let dispatched = false;
    try {
      combined.throwIfAborted();
      const result = await perform({
        host,
        oauthToken: token,
        requesterFn: createRequesterFn(
          (_, options) => Promise.resolve(options),
          async (endpoint, options) => {
            // Each public call owns one page. SDK pagination/retries cannot add hidden requests.
            if (dispatched || !['user', 'projects'].includes(endpoint) || options?.method !== 'GET')
              throw new Error('endpoint');
            dispatched = true;
            const url = new URL(`${host}/api/v4/${endpoint}`);
            url.search = typeof options.searchParams === 'string' ? options.searchParams : '';
            const response = await this.fetcher(url.href, {
              method: 'GET',
              headers: {
                ...(options.headers as Record<string, string>),
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
            this.policy.observe(host, token, url.href, response.status, headers);
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
                    : 'The GitLab request failed. Check the connection and try again.',
                );
              }
              if (reader)
                for (;;) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  length += chunk.value.length;
                  if (length > (endpoint === 'user' ? 32768 : 4 * 1024 * 1024))
                    throw new Error('size');
                  chunks.push(chunk.value);
                }
            } finally {
              await reader?.cancel().catch(() => {});
            }
            return {
              body: z
                .union([
                  z.record(z.string(), z.unknown()),
                  z.array(z.record(z.string(), z.unknown())).max(100),
                ])
                .parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))),
              // Continuation is local and bounded; provider Link URLs never enter the SDK pager.
              headers: {},
              status: response.status,
            };
          },
        ),
      });
      combined.throwIfAborted();
      return result;
    } catch (error) {
      if (signal?.aborted) throw new ProviderError('CANCELLED', 'GitLab request cancelled.');
      if (error instanceof ProviderError) throw error;
      if (error instanceof z.ZodError)
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'GitLab returned invalid repository or account metadata.',
        );
      throw new ProviderError(
        'PROVIDER_REQUEST',
        'The GitLab request failed. Check the connection and try again.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
