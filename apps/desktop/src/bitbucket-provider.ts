import { loadBitbucketMergeability } from './bitbucket-mergeability.js';
import type { ProviderBitbucketMergeabilityOptions } from '@openkraken/ipc-contract';
import { loadBitbucketStatuses } from './bitbucket-statuses.js';
import type { ProviderBitbucketStatusesOptions } from '@openkraken/ipc-contract';
import { loadBitbucketComments } from './bitbucket-comments.js';
import type { ProviderBitbucketCommentsOptions } from '@openkraken/ipc-contract';
import { loadBitbucketFiles, loadBitbucketDiff } from './bitbucket-files.js';
import type {
  ProviderBitbucketFilesOptions,
  ProviderBitbucketDiffOptions,
} from '@openkraken/ipc-contract';
import { loadBitbucketPulls, loadBitbucketPull } from './bitbucket-pulls.js';
import type { ProviderPullListOptions, ProviderPullOptions } from '@openkraken/ipc-contract';
import { bitbucketPagination, bitbucketPageSchema, bitbucketUnique } from './bitbucket-response.js';
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
        const result = bitbucketPageSchema(z.object({ workspace: workspaceSchema })).parse(data);
        bitbucketUnique(result.values.map((value) => value.workspace.uuid));
        bitbucketUnique(result.values.map((value) => value.workspace.slug));
        return providerBitbucketWorkspacePageSchema.parse({
          workspaces: result.values.map(({ workspace }) => ({
            id: workspace.uuid,
            slug: workspace.slug,
          })),
          ...bitbucketPagination(result, page, 'user/workspaces'),
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
        const result = bitbucketPageSchema(repositorySchema).parse(data);
        bitbucketUnique(result.values.map((repo) => repo.uuid));
        bitbucketUnique(result.values.map((repo) => repo.full_name));
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
          ...bitbucketPagination(result, page, endpoint),
        });
      },
    );
  }
  pullRequests(
    origin: string,
    token: string,
    input: ProviderPullListOptions,
    signal?: AbortSignal,
  ) {
    return loadBitbucketPulls(
      (endpoint, parse) => this.request(origin, token, endpoint, signal, parse),
      input,
    );
  }
  pullRequest(origin: string, token: string, input: ProviderPullOptions, signal?: AbortSignal) {
    return loadBitbucketPull(
      (endpoint, parse) => this.request(origin, token, endpoint, signal, parse),
      input,
    );
  }
  pullMergeability(
    origin: string,
    token: string,
    input: ProviderBitbucketMergeabilityOptions,
    signal?: AbortSignal,
  ) {
    return loadBitbucketMergeability(
      (endpoint, parse) => this.request(origin, token, endpoint, signal, parse),
      input,
    );
  }
  pullStatuses(
    origin: string,
    token: string,
    input: ProviderBitbucketStatusesOptions,
    signal?: AbortSignal,
  ) {
    return loadBitbucketStatuses(
      (endpoint, parse) => this.request(origin, token, endpoint, signal, parse),
      input,
    );
  }
  pullComments(
    origin: string,
    token: string,
    input: ProviderBitbucketCommentsOptions,
    signal?: AbortSignal,
  ) {
    return loadBitbucketComments(
      (endpoint, parse) => this.request(origin, token, endpoint, signal, parse),
      input,
    );
  }
  pullFiles(
    origin: string,
    token: string,
    input: ProviderBitbucketFilesOptions,
    signal?: AbortSignal,
  ) {
    return loadBitbucketFiles(
      (endpoint, parse) => this.request(origin, token, endpoint, signal, parse),
      (endpoint) =>
        this.request(
          origin,
          token,
          endpoint,
          signal,
          (value) => z.string().min(1).max(4096).parse(value),
          'redirect',
        ),
      input,
    );
  }
  pullDiff(
    origin: string,
    token: string,
    input: ProviderBitbucketDiffOptions,
    signal?: AbortSignal,
  ) {
    return loadBitbucketDiff(
      (endpoint, parse) => this.request(origin, token, endpoint, signal, parse),
      (endpoint) =>
        this.request(
          origin,
          token,
          endpoint,
          signal,
          (value) => z.string().min(1).max(4096).parse(value),
          'redirect',
        ),
      (endpoint) =>
        this.request(origin, token, endpoint, signal, (value) => z.string().parse(value), 'text'),
      input,
    );
  }
  private async request<T>(
    origin: string,
    token: string,
    endpoint: string,
    signal: AbortSignal | undefined,
    parse: (data: unknown) => T,
    mode: 'json' | 'redirect' | 'text' = 'json',
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
        Accept: mode === 'text' ? 'text/plain' : 'application/json',
        'User-Agent': 'OpenKraken/0.1.0',
      });
      const key = this.cache.key(origin, token, url, headers);
      const cached = mode !== 'redirect' ? this.cache.get(key) : undefined;
      if (cached) headers.set('If-None-Match', cached.etag);
      const response = await this.fetcher(url, {
        method: 'GET',
        headers,
        signal: combined,
        credentials: 'omit',
        redirect: mode === 'redirect' ? 'manual' : 'error',
      });
      this.policy.observe(origin, token, url, response.status, response.headers);
      if ([401, 403, 404].includes(response.status)) this.cache.clear();
      if (mode === 'redirect') {
        await response.body?.cancel().catch(() => {});
        combined.throwIfAborted();
        if (response.status !== 302) {
          this.policy.assertAllowed(origin, token);
          throw new ProviderError(
            [401, 403].includes(response.status) ? 'PROVIDER_AUTH' : 'PROVIDER_RESPONSE',
            'Bitbucket did not return a pull-request comparison redirect.',
          );
        }
        return parse(response.headers.get('location'));
      }
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
      if (
        mode === 'text' &&
        response.status === 200 &&
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/plain'
      )
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'Bitbucket returned a non-text diff response.',
        );
      const result = parse(
        mode === 'text'
          ? new TextDecoder('utf-8', { fatal: true }).decode(body)
          : JSON.parse(body.toString('utf8')),
      );
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
