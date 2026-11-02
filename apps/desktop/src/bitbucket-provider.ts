import {
  providerBitbucketWorkspacePageSchema,
  providerBitbucketRepositoriesOptionsSchema,
  providerRepositoryPageNumberSchema,
  providerRepositoryPageSchema,
  providerRepositoryPathComponentSchema,
  type ProviderBitbucketRepositoriesOptions,
} from '@openkraken/ipc-contract';
import { z } from 'zod';
import { providerBitbucketIdSchema, providerOriginSchema } from '@openkraken/ipc-contract';
import { ProviderError } from './provider-error.js';
import { ProviderPollingPolicy } from './provider-polling-policy.js';
import { ProviderReadCache } from './provider-read-cache.js';

const workspaceSchema = z.object({
  uuid: providerBitbucketIdSchema,
  slug: providerRepositoryPathComponentSchema,
});
const repositorySchema = z.object({
  uuid: providerBitbucketIdSchema,
  full_name: z.string().min(3).max(511),
  workspace: workspaceSchema,
  slug: providerRepositoryPathComponentSchema.optional(),
  scm: z.literal('git'),
  is_private: z.boolean(),
  description: z.string().max(4096).nullish(),
});
function pagination(data: { page?: number; next?: string | null }, page: number, endpoint: string) {
  if (data.page !== undefined && data.page !== page)
    throw new ProviderError('PROVIDER_RESPONSE', 'Bitbucket returned a different page.');
  if (data.next) {
    const next = new URL(data.next);
    if (
      next.origin !== 'https://api.bitbucket.org' ||
      next.username ||
      next.password ||
      next.hash ||
      next.pathname !== `/2.0/${endpoint}` ||
      next.searchParams.getAll('page').length !== 1 ||
      next.searchParams.get('page') !== String(page + 1)
    )
      throw new ProviderError('PROVIDER_RESPONSE', 'Bitbucket returned invalid pagination.');
  }
  // Reconstruct subsequent requests locally, never follow provider links.
  return {
    nextPage: data.next && page < 100 ? page + 1 : null,
    limited: !!data.next && page === 100,
  };
}
function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    page: z.number().int().positive().optional(),
    next: z.string().url().max(4096).nullish(),
    values: z.array(item).max(100),
  });
}
function unique(ids: string[]) {
  if (new Set(ids).size !== ids.length)
    throw new ProviderError('PROVIDER_RESPONSE', 'Bitbucket returned duplicate entries.');
}

/** Cloud API only; caller-supplied and server-returned URLs never receive credentials. */
export class BitbucketProvider {
  private policy = new ProviderPollingPolicy();
  private cache = new ProviderReadCache();
  constructor(private fetcher: typeof fetch = (...args) => fetch(...args)) {}
  clearReadCache() {
    this.cache.clear();
  }
  pollingPolicy(origin: string, token: string) {
    return this.policy.get(origin, token);
  }
  async identity(origin: string, token: string, signal?: AbortSignal) {
    return this.request(origin, token, 'user', signal, (data) => {
      const user = z
        .object({ uuid: providerBitbucketIdSchema, display_name: z.string().min(1).max(255) })
        .parse(data);
      return { id: user.uuid, login: user.display_name };
    });
  }
  async workspaces(origin: string, token: string, page: number, signal?: AbortSignal) {
    providerRepositoryPageNumberSchema.parse(page);
    return this.request(
      origin,
      token,
      `user/workspaces?page=${page}&pagelen=100&sort=slug`,
      signal,
      (data) => {
        const result = pageSchema(z.object({ workspace: workspaceSchema })).parse(data);
        unique(result.values.map((value) => value.workspace.uuid));
        unique(result.values.map((value) => value.workspace.slug));
        return providerBitbucketWorkspacePageSchema.parse({
          workspaces: result.values.map(({ workspace }) => ({
            id: workspace.uuid,
            slug: workspace.slug,
          })),
          ...pagination(result, page, 'user/workspaces'),
        });
      },
    );
  }
  async repositories(
    origin: string,
    token: string,
    input: ProviderBitbucketRepositoriesOptions,
    signal?: AbortSignal,
  ) {
    const { workspace, page } = providerBitbucketRepositoriesOptionsSchema.parse(input);
    const endpoint = `repositories/${workspace.slug}`;
    return this.request(
      origin,
      token,
      `${endpoint}?page=${page}&pagelen=100&sort=name`,
      signal,
      (data) => {
        const result = pageSchema(repositorySchema).parse(data);
        unique(result.values.map((repo) => repo.uuid));
        unique(result.values.map((repo) => repo.full_name));
        return providerRepositoryPageSchema.parse({
          repositories: result.values.map((repo) => {
            const [owner, name, ...extra] = repo.full_name.split('/');
            if (
              owner !== workspace.slug ||
              repo.workspace.uuid !== workspace.id ||
              repo.workspace.slug !== workspace.slug ||
              extra.length ||
              (repo.slug !== undefined && repo.slug !== name)
            )
              throw new ProviderError(
                'PROVIDER_RESPONSE',
                'Bitbucket returned a repository outside the selected workspace.',
              );
            providerRepositoryPathComponentSchema.parse(name);
            return {
              id: repo.uuid,
              owner,
              name,
              description: repo.description ?? '',
              private: repo.is_private,
              visibility: repo.is_private ? 'private' : 'public',
              archived: false,
              cloneUrl: `https://bitbucket.org/${owner}/${name}.git`,
            };
          }),
          ...pagination(result, page, endpoint),
        });
      },
    );
  }
  private async request<T>(
    origin: string,
    token: string,
    endpoint: string,
    signal: AbortSignal | undefined,
    parse: (data: unknown) => T,
  ) {
    if (providerOriginSchema.parse(origin) !== 'https://bitbucket.org')
      throw new ProviderError('PROVIDER_ORIGIN', 'Bitbucket Cloud uses https://bitbucket.org.');
    this.policy.assertAllowed(origin, token);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      combined.throwIfAborted();
      const url = `https://api.bitbucket.org/2.0/${endpoint}`;
      const headers = new Headers({
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'OpenKraken/0.1.0',
      });
      const key = this.cache.key(origin, token, url, headers);
      const cached = this.cache.get(key);
      if (cached) headers.set('If-None-Match', cached.etag);
      const response = await this.fetcher(url, {
        method: 'GET',
        headers,
        signal: combined,
        credentials: 'omit',
        redirect: 'error',
      });
      this.policy.observe(origin, token, url, response.status, response.headers);
      if ([401, 403, 404].includes(response.status)) this.cache.clear();
      const reader = response.body?.getReader();
      let body: Buffer<ArrayBuffer>;
      try {
        if (response.status === 304 && cached) {
          body = cached.body;
          if (!this.cache.storageAllowed(response.headers)) this.cache.discard(key);
        } else {
          if (response.status !== 200) {
            this.policy.assertAllowed(origin, token);
            throw new ProviderError(
              [401, 403].includes(response.status) ? 'PROVIDER_AUTH' : 'PROVIDER_REQUEST',
              'Bitbucket rejected this request. Check your connection and API token permissions.',
            );
          }
          const chunks: Uint8Array[] = [];
          let length = 0;
          if (reader)
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              length += chunk.value.length;
              if (length > (endpoint === 'user' ? 32768 : 4 * 1024 * 1024)) throw new Error('size');
              chunks.push(chunk.value);
            }
          body = Buffer.concat(chunks);
        }
      } finally {
        await reader?.cancel().catch(() => {});
      }
      combined.throwIfAborted();
      const result = parse(JSON.parse(body.toString('utf8')));
      if (response.status === 200) this.cache.set(key, response.headers, body);
      return result;
    } catch (error) {
      if (signal?.aborted) throw new ProviderError('CANCELLED', 'Bitbucket request cancelled.');
      if (error instanceof ProviderError) throw error;
      if (error instanceof z.ZodError)
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'Bitbucket returned invalid response metadata.',
        );
      throw new ProviderError(
        'PROVIDER_REQUEST',
        'The Bitbucket request failed. Check the connection and try again.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
