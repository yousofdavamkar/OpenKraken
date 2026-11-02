import {
  loadMergeRequestMergeState,
  previewMergeRequestMerge,
  mergeMergeRequest,
} from './gitlab-merge-action.js';
import { loadMergeTemplates, loadMergeTemplate } from './gitlab-templates.js';
import { previewMergeCreation, createMergeRequest } from './gitlab-create.js';
import { previewMergeDiscussionAction, writeMergeDiscussion } from './gitlab-discussion-actions.js';
import {
  loadMergeApprovals,
  previewMergeApproval,
  writeMergeApproval,
} from './gitlab-approvals.js';
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
import { loadMergeRequestDiscussions } from './gitlab-discussions.js';
import { loadMergeRequestFiles } from './gitlab-files.js';
import { loadMergeRequest, loadMergeRequests } from './gitlab-merges.js';
import type {
  ProviderPullTemplatesOptions,
  ProviderMergeTemplateOptions,
  ProviderMergeRequestMergeIntent,
  ProviderMergeMergeRequest,
  ProviderMergeCreationIntent,
  ProviderCreateMergeRequest,
  ProviderMergeApprovalOptions,
  ProviderWriteMergeApproval,
  ProviderMergeDiscussionAction,
  ProviderWriteMergeDiscussion,
  ProviderMergeRequestDiscussionsOptions,
  ProviderMergeRequestFilesOptions,
  ProviderPullListOptions,
  ProviderPullOptions,
} from '@openkraken/ipc-contract';
import { ProviderReadCache } from './provider-read-cache.js';

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
  private cache = new ProviderReadCache();
  constructor(private fetcher: typeof fetch = (...args) => fetch(...args)) {}
  clearReadCache() {
    this.cache.clear();
  }
  pollingPolicy(origin: string, token: string) {
    return this.policy.get(origin, token);
  }
  async identity(origin: string, token: string, signal?: AbortSignal) {
    return this.request(
      origin,
      token,
      signal,
      async (options) => {
        const result = z
          .object({
            id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            username: z.string().min(1).max(255),
          })
          .parse(await new Users(options).showCurrentUser());
        return { id: String(result.id), login: result.username };
      },
      'user',
    );
  }
  async repositories(origin: string, token: string, page: number, signal?: AbortSignal) {
    providerRepositoryPageNumberSchema.parse(page);
    const host = providerOriginSchema.parse(origin);
    return this.request(
      host,
      token,
      signal,
      async (options) => {
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
      },
      'projects',
    );
  }
  pullRequests(
    origin: string,
    token: string,
    input: ProviderPullListOptions,
    signal?: AbortSignal,
  ) {
    return loadMergeRequests(
      (endpoint, perform) => this.request(origin, token, signal, perform, endpoint),
      providerOriginSchema.parse(origin),
      input,
    );
  }
  mergeRequest(origin: string, token: string, input: ProviderPullOptions, signal?: AbortSignal) {
    return loadMergeRequest(
      (endpoint, perform) => this.request(origin, token, signal, perform, endpoint),
      providerOriginSchema.parse(origin),
      input,
    );
  }
  mergeRequestFiles(
    origin: string,
    token: string,
    input: ProviderMergeRequestFilesOptions,
    signal?: AbortSignal,
  ) {
    return loadMergeRequestFiles(
      (endpoint, perform) => this.request(origin, token, signal, perform, endpoint),
      providerOriginSchema.parse(origin),
      input,
    );
  }
  mergeRequestDiscussions(
    origin: string,
    token: string,
    input: ProviderMergeRequestDiscussionsOptions,
    signal?: AbortSignal,
  ) {
    return loadMergeRequestDiscussions(
      (endpoint, perform) => this.request(origin, token, signal, perform, endpoint),
      providerOriginSchema.parse(origin),
      input,
    );
  }
  mergeRequestMergeState(
    origin: string,
    token: string,
    input: ProviderPullOptions,
    signal?: AbortSignal,
  ) {
    this.cache.clear();
    return loadMergeRequestMergeState(
      (endpoint, perform) => this.request(origin, token, signal, perform, endpoint),
      origin,
      input,
    );
  }
  previewMergeRequestMerge(
    origin: string,
    token: string,
    userId: string,
    input: ProviderMergeRequestMergeIntent,
    signal?: AbortSignal,
  ) {
    this.cache.clear();
    return previewMergeRequestMerge(
      (endpoint, perform) => this.request(origin, token, signal, perform, endpoint),
      origin,
      userId,
      input,
    );
  }
  mergeMergeRequest(
    origin: string,
    token: string,
    userId: string,
    input: ProviderMergeMergeRequest,
    signal?: AbortSignal,
  ) {
    this.cache.clear();
    return mergeMergeRequest(
      (endpoint, perform) => this.request(origin, token, signal, perform, endpoint),
      (endpoint, method, perform) => this.request(origin, token, signal, perform, endpoint, method),
      origin,
      userId,
      input,
    );
  }
  mergeTemplates(
    origin: string,
    token: string,
    input: ProviderPullTemplatesOptions,
    signal?: AbortSignal,
  ) {
    return loadMergeTemplates(
      (endpoint, perform) => this.request(origin, token, signal, perform, endpoint),
      origin,
      input,
    );
  }
  mergeTemplate(
    origin: string,
    token: string,
    input: ProviderMergeTemplateOptions,
    signal?: AbortSignal,
  ) {
    this.cache.clear();
    return loadMergeTemplate(
      (endpoint, perform) => this.request(origin, token, signal, perform, endpoint),
      origin,
      input,
    );
  }
  previewMergeCreation(
    origin: string,
    token: string,
    userId: string,
    input: ProviderMergeCreationIntent,
    signal?: AbortSignal,
  ) {
    this.cache.clear();
    return previewMergeCreation(
      (endpoint, perform) => this.request(origin, token, signal, perform, endpoint),
      origin,
      userId,
      input,
    );
  }
  createMergeRequest(
    origin: string,
    token: string,
    userId: string,
    input: ProviderCreateMergeRequest,
    signal?: AbortSignal,
  ) {
    this.cache.clear();
    return createMergeRequest(
      (endpoint, perform) => this.request(origin, token, signal, perform, endpoint),
      (endpoint, method, perform) => this.request(origin, token, signal, perform, endpoint, method),
      origin,
      userId,
      input,
    );
  }
  mergeApprovals(
    origin: string,
    token: string,
    userId: string,
    input: ProviderPullOptions,
    signal?: AbortSignal,
  ) {
    return loadMergeApprovals(
      (endpoint, perform) => this.request(origin, token, signal, perform, endpoint),
      origin,
      userId,
      input,
    );
  }
  previewMergeApproval(
    origin: string,
    token: string,
    userId: string,
    input: ProviderMergeApprovalOptions,
    signal?: AbortSignal,
  ) {
    this.cache.clear();
    return previewMergeApproval(
      (endpoint, perform) => this.request(origin, token, signal, perform, endpoint),
      origin,
      userId,
      input,
    );
  }
  writeMergeApproval(
    origin: string,
    token: string,
    userId: string,
    input: ProviderWriteMergeApproval,
    signal?: AbortSignal,
  ) {
    this.cache.clear();
    return writeMergeApproval(
      (endpoint, perform) => this.request(origin, token, signal, perform, endpoint),
      (endpoint, method, perform) => this.request(origin, token, signal, perform, endpoint, method),
      origin,
      userId,
      input,
    );
  }
  previewMergeDiscussionAction(
    origin: string,
    token: string,
    input: ProviderMergeDiscussionAction,
    signal?: AbortSignal,
  ) {
    this.cache.clear();
    return previewMergeDiscussionAction(
      (endpoint, perform) => this.request(origin, token, signal, perform, endpoint),
      origin,
      input,
    );
  }
  writeMergeDiscussion(
    origin: string,
    token: string,
    input: ProviderWriteMergeDiscussion,
    signal?: AbortSignal,
  ) {
    this.cache.clear();
    return writeMergeDiscussion(
      (endpoint, perform) => this.request(origin, token, signal, perform, endpoint),
      (endpoint, method, perform) => this.request(origin, token, signal, perform, endpoint, method),
      origin,
      input,
    );
  }
  private async request<T>(
    origin: string,
    token: string,
    signal: AbortSignal | undefined,
    perform: (options: BaseResourceOptions<false>) => Promise<T>,
    expectedEndpoint: string,
    method: 'GET' | 'POST' | 'PUT' = 'GET',
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
            const target =
              typeof options?.prefixUrl === 'string'
                ? `${options.prefixUrl.replace(/\/$/, '')}/${endpoint}`
                : '';
            if (
              dispatched ||
              target !== `${host}/api/v4/${expectedEndpoint}` ||
              options?.method !== method
            )
              throw new Error('endpoint');
            const url = new URL(target);
            url.search = typeof options.searchParams === 'string' ? options.searchParams : '';
            const requestHeaders = new Headers(options.headers as Record<string, string>);
            requestHeaders.set('User-Agent', 'OpenKraken/0.1.0');
            const key = this.cache.key(host, token, url.href, requestHeaders);
            const cached = method === 'GET' ? this.cache.get(key) : undefined;
            if (cached) requestHeaders.set('If-None-Match', cached.etag);
            combined.throwIfAborted();
            if (method !== 'GET') this.cache.clear();
            dispatched = true;
            const response = await this.fetcher(url.href, {
              method,
              ...(method === 'GET' ? {} : { body: options.body as BodyInit | undefined }),
              headers: requestHeaders,
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
            if ([401, 403, 404].includes(response.status)) this.cache.clear();
            const reader = response.body?.getReader();
            const chunks: Uint8Array[] = [];
            let length = 0;
            try {
              if (response.status === 304 && cached) {
                chunks.push(cached.body);
                if (!this.cache.storageAllowed(response.headers)) this.cache.discard(key);
              } else if (!response.ok) {
                if (method !== 'GET')
                  throw new ProviderError(
                    [400, 401, 403, 404, 405, 409, 410, 422, 429].includes(response.status)
                      ? 'PROVIDER_WRITE_REJECTED'
                      : 'PROVIDER_WRITE_UNCERTAIN',
                    'The GitLab action was not acknowledged. Check its current state before trying again.',
                  );
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
              if (
                (method === 'POST' && response.status !== 201) ||
                (method === 'PUT' && response.status !== 200)
              )
                throw new ProviderError(
                  'PROVIDER_WRITE_UNCERTAIN',
                  'GitLab did not acknowledge completion of this action.',
                );
              if (reader && response.status !== 304)
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
            const body = Buffer.concat(chunks);
            if (method === 'GET' && response.status === 200)
              this.cache.set(key, response.headers, body);
            return {
              body: z
                .union([
                  z.record(z.string(), z.unknown()),
                  z.array(z.record(z.string(), z.unknown())).max(100),
                ])
                .parse(JSON.parse(body.toString('utf8'))),
              // Continuation is local and bounded; provider Link URLs never enter the SDK pager.
              headers: {},
              status: response.status === 304 ? 200 : response.status,
            };
          },
        ),
      });
      combined.throwIfAborted();
      return result;
    } catch (error) {
      if (method !== 'GET' && dispatched) {
        if (error instanceof ProviderError && error.code === 'PROVIDER_WRITE_REJECTED') throw error;
        throw new ProviderError(
          'PROVIDER_WRITE_UNCERTAIN',
          'This GitLab action may have completed. Check existing results before trying again.',
        );
      }
      if (signal?.aborted) throw new ProviderError('CANCELLED', 'GitLab request cancelled.');
      if (error instanceof ProviderError) throw error;
      if (error instanceof z.ZodError)
        throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned invalid response metadata.');
      throw new ProviderError(
        'PROVIDER_REQUEST',
        'The GitLab request failed. Check the connection and try again.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
