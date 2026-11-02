import { Octokit } from '@octokit/rest';
import {
  providerMergePreviewSchema,
  type ProviderPollingPolicy as PollingPolicy,
  providerPullChecksOptionsSchema,
  type ProviderPullChecksOptions,
  type ProviderPullChecksPage,
  providerIssueOptionsSchema,
  providerIssueCommentsOptionsSchema,
  type ProviderIssueOptions,
  type ProviderIssueCommentsOptions,
  type ProviderIssueDetails,
  type ProviderIssueCommentsPage,
  type ProviderIssueActionPreview,
  providerWriteIssueSchema,
  type ProviderWriteIssue,
  type ProviderIssueWriteResult,
  providerIssueListOptionsSchema,
  type ProviderIssueListOptions,
  type ProviderIssuePage,
  providerMergePullSchema,
  providerMergeResultSchema,
  type ProviderMergePreview,
  type ProviderMergePull,
  type ProviderMergeResult,
  type ProviderMergeMethod,
  providerPullTemplatesOptionsSchema,
  providerPullTemplateOptionsSchema,
  type ProviderPullTemplatesOptions,
  type ProviderPullTemplateOptions,
  type ProviderPullTemplates,
  type ProviderPullTemplate,
  providerPullSourceSchema,
  providerCreatePullSchema,
  providerPullRevisionSchema,
  type ProviderPullSource,
  type ProviderCreatePull,
  type ProviderPullRevision,
  type ProviderPullSummary,
  providerCreateCommentSchema,
  type ProviderCreateComment,
  type ProviderPullComment,
  providerPullCommentSchema,
  providerPullCommentsPageSchema,
  type ProviderPullCommentsPage,
  providerPullReviewsOptionsSchema,
  providerPullReviewsPageSchema,
  providerPullReviewSchema,
  providerSubmitReviewSchema,
  type ProviderPullReviewsOptions,
  type ProviderPullReviewsPage,
  type ProviderPullReview,
  type ProviderSubmitReview,
  providerPullFilesOptionsSchema,
  providerPullFilesPageSchema,
  type ProviderPullFilesOptions,
  type ProviderPullFilesPage,
  providerPullListOptionsSchema,
  providerPullOptionsSchema,
  providerPullSummarySchema,
  providerPullPageSchema,
  providerPullDetailsSchema,
  type ProviderPullListOptions,
  type ProviderPullOptions,
  type ProviderPullPage,
  type ProviderPullDetails,
  providerOriginSchema,
  providerRepositoryPageSchema,
  providerRepositoryPageNumberSchema,
  type ProviderRepositoryPage,
} from '@openkraken/ipc-contract';

import {
  loadIssues,
  loadIssue,
  loadIssueComments,
  writeIssue,
  previewIssueAction,
} from './github-issues.js';
import { loadPullChecks } from './github-checks.js';
import { ProviderError } from './provider-error.js';
import { ProviderReadCache } from './provider-read-cache.js';
import { ProviderPollingPolicy } from './provider-polling-policy.js';
export { ProviderError } from './provider-error.js';
import { loadPullTemplates, loadPullTemplate } from './github-templates.js';
export interface ProviderDriver {
  clearReadCache(): void;
  pollingPolicy(origin: string, token: string): PollingPolicy;
  previewIssueAction(
    origin: string,
    token: string,
    options: ProviderIssueOptions,
    signal?: AbortSignal,
  ): Promise<ProviderIssueActionPreview>;
  writeIssue(
    origin: string,
    token: string,
    options: ProviderWriteIssue,
    signal?: AbortSignal,
  ): Promise<ProviderIssueWriteResult>;
  issue(
    origin: string,
    token: string,
    options: ProviderIssueOptions,
    signal?: AbortSignal,
  ): Promise<ProviderIssueDetails>;
  issueComments(
    origin: string,
    token: string,
    options: ProviderIssueCommentsOptions,
    signal?: AbortSignal,
  ): Promise<ProviderIssueCommentsPage>;
  issues(
    origin: string,
    token: string,
    options: ProviderIssueListOptions,
    signal?: AbortSignal,
  ): Promise<ProviderIssuePage>;
  pullChecks(
    origin: string,
    token: string,
    options: ProviderPullChecksOptions,
    signal?: AbortSignal,
  ): Promise<ProviderPullChecksPage>;
  previewMerge(
    origin: string,
    token: string,
    options: ProviderPullOptions,
    signal?: AbortSignal,
  ): Promise<ProviderMergePreview>;
  mergePull(
    origin: string,
    token: string,
    options: ProviderMergePull,
    signal?: AbortSignal,
  ): Promise<ProviderMergeResult>;
  pullTemplates(
    origin: string,
    token: string,
    options: ProviderPullTemplatesOptions,
    signal?: AbortSignal,
  ): Promise<ProviderPullTemplates>;
  pullTemplate(
    origin: string,
    token: string,
    options: ProviderPullTemplateOptions,
    signal?: AbortSignal,
  ): Promise<ProviderPullTemplate>;
  previewPull(
    origin: string,
    token: string,
    options: ProviderPullSource,
    signal?: AbortSignal,
  ): Promise<ProviderPullRevision>;
  createPull(
    origin: string,
    token: string,
    options: ProviderCreatePull,
    signal?: AbortSignal,
  ): Promise<ProviderPullSummary>;
  createComment(
    origin: string,
    token: string,
    options: ProviderCreateComment,
    signal?: AbortSignal,
  ): Promise<ProviderPullComment>;
  pullComments(
    origin: string,
    token: string,
    options: ProviderPullReviewsOptions,
    signal?: AbortSignal,
  ): Promise<ProviderPullCommentsPage>;
  pullReviews(
    origin: string,
    token: string,
    options: ProviderPullReviewsOptions,
    signal?: AbortSignal,
  ): Promise<ProviderPullReviewsPage>;
  submitReview(
    origin: string,
    token: string,
    options: ProviderSubmitReview,
    signal?: AbortSignal,
  ): Promise<ProviderPullReview>;
  pullFiles(
    origin: string,
    token: string,
    options: ProviderPullFilesOptions,
    signal?: AbortSignal,
  ): Promise<ProviderPullFilesPage>;
  pullRequests(
    origin: string,
    token: string,
    options: ProviderPullListOptions,
    signal?: AbortSignal,
  ): Promise<ProviderPullPage>;
  pullRequest(
    origin: string,
    token: string,
    options: ProviderPullOptions,
    signal?: AbortSignal,
  ): Promise<ProviderPullDetails>;
  repositories(
    origin: string,
    token: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<ProviderRepositoryPage>;
  identity(
    origin: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; login: string }>;
}
export class GitHubProvider implements ProviderDriver {
  private readCache = new ProviderReadCache();
  private polling = new ProviderPollingPolicy();
  pollingPolicy(origin: string, token: string) {
    return this.polling.get(origin, token);
  }
  clearReadCache() {
    this.readCache.clear();
  }
  constructor(private fetcher: typeof fetch = (...args) => fetch(...args)) {}
  async pullChecks(
    origin: string,
    token: string,
    input: ProviderPullChecksOptions,
    signal?: AbortSignal,
  ) {
    const options = providerPullChecksOptionsSchema.parse(input);
    const host = providerOriginSchema.parse(origin);
    return this.request(
      host,
      token,
      signal,
      (client, headers) => loadPullChecks(client, headers, host, options),
      { readOnlyGraphQL: true },
    );
  }
  async issues(
    origin: string,
    token: string,
    input: ProviderIssueListOptions,
    signal?: AbortSignal,
  ) {
    const options = providerIssueListOptionsSchema.parse(input);
    const host = providerOriginSchema.parse(origin);
    return this.request(host, token, signal, (client, headers) =>
      loadIssues(client, headers, host, options),
    );
  }
  async issue(origin: string, token: string, input: ProviderIssueOptions, signal?: AbortSignal) {
    const options = providerIssueOptionsSchema.parse(input);
    const host = providerOriginSchema.parse(origin);
    return this.request(host, token, signal, (client, headers) =>
      loadIssue(client, headers, host, options),
    );
  }
  async issueComments(
    origin: string,
    token: string,
    input: ProviderIssueCommentsOptions,
    signal?: AbortSignal,
  ) {
    const options = providerIssueCommentsOptionsSchema.parse(input);
    const host = providerOriginSchema.parse(origin);
    return this.request(host, token, signal, (client, headers) =>
      loadIssueComments(client, headers, host, options),
    );
  }
  async writeIssue(origin: string, token: string, input: ProviderWriteIssue, signal?: AbortSignal) {
    const options = providerWriteIssueSchema.parse(input);
    const host = providerOriginSchema.parse(origin);
    signal?.throwIfAborted();
    return this.request(host, token, signal, (client, headers) =>
      writeIssue(client, headers, host, options, signal),
    );
  }
  async previewIssueAction(
    origin: string,
    token: string,
    input: ProviderIssueOptions,
    signal?: AbortSignal,
  ) {
    const options = providerIssueOptionsSchema.parse(input);
    const host = providerOriginSchema.parse(origin);
    return this.request(host, token, signal, (client, headers) =>
      previewIssueAction(client, headers, host, options),
    );
  }
  async identity(origin: string, token: string, signal?: AbortSignal) {
    return this.request(origin, token, signal, async (client, headers) => {
      const { data } = await client.users.getAuthenticated({ headers });
      if (!Number.isSafeInteger(data.id) || data.id <= 0 || typeof data.login !== 'string')
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'The provider returned an invalid account identity.',
        );
      return { id: String(data.id), login: data.login };
    });
  }
  async repositories(origin: string, token: string, page: number, signal?: AbortSignal) {
    providerRepositoryPageNumberSchema.parse(page);
    const host = providerOriginSchema.parse(origin);
    return this.request(host, token, signal, async (client, headers) => {
      const { data } = await client.repos.listForAuthenticatedUser({
        headers,
        page,
        per_page: 100,
        sort: 'full_name',
        direction: 'asc',
      });
      if (
        !Array.isArray(data) ||
        data.length > 100 ||
        data.some((repo) => !Number.isSafeInteger(repo?.id) || repo.id <= 0)
      )
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'The provider returned an invalid repository page.',
        );
      const result = providerRepositoryPageSchema.safeParse({
        repositories: data.map((repo) => ({
          id: String(repo.id),
          owner: repo.owner?.login,
          name: repo.name,
          description: repo.description ?? '',
          private: repo.private,
          archived: repo.archived,
          cloneUrl: `${host}/${repo.owner?.login}/${repo.name}.git`,
        })),
        nextPage: data.length === 100 && page < 100 ? page + 1 : null,
        limited: data.length === 100 && page === 100,
      });
      if (!result.success)
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'The provider returned an invalid repository page.',
        );
      return result.data;
    });
  }
  async pullTemplates(
    origin: string,
    token: string,
    input: ProviderPullTemplatesOptions,
    signal?: AbortSignal,
  ) {
    const options = providerPullTemplatesOptionsSchema.parse(input);
    return this.request(origin, token, signal, (client, headers) =>
      loadPullTemplates(client, headers, options),
    );
  }
  async pullTemplate(
    origin: string,
    token: string,
    input: ProviderPullTemplateOptions,
    signal?: AbortSignal,
  ) {
    const options = providerPullTemplateOptionsSchema.parse(input);
    return this.request(origin, token, signal, (client, headers) =>
      loadPullTemplate(client, headers, options),
    );
  }
  async previewPull(
    origin: string,
    token: string,
    input: ProviderPullSource,
    signal?: AbortSignal,
  ) {
    const options = providerPullSourceSchema.parse(input);
    return this.request(origin, token, signal, async (client, headers) => {
      const branch = async (repo: ProviderPullSource['repository'], name: string) => {
        const { data } = await client.repos.getBranch({
          headers,
          owner: repo.owner,
          repo: repo.name,
          branch: name,
        });
        if (data?.name !== name)
          throw new ProviderError(
            'PROVIDER_RESPONSE',
            'The provider returned an unexpected branch.',
          );
        return data.commit?.sha;
      };
      const parsed = providerPullRevisionSchema.safeParse({
        head: await branch(options.source, options.head),
        base: await branch(options.repository, options.base),
      });
      if (!parsed.success)
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'The provider returned invalid branch commits.',
        );
      if (parsed.data.head === parsed.data.base)
        throw new ProviderError(
          'PROVIDER_PULL_EMPTY',
          'The selected branches point to the same commit. Push your changes or choose different branches.',
        );
      return parsed.data;
    });
  }
  async createPull(origin: string, token: string, input: ProviderCreatePull, signal?: AbortSignal) {
    const options = providerCreatePullSchema.parse(input);
    const current = await this.previewPull(
      origin,
      token,
      {
        repository: options.repository,
        source: options.source,
        head: options.head,
        base: options.base,
      },
      signal,
    );
    if (current.head !== options.revision.head || current.base !== options.revision.base)
      throw new ProviderError(
        'STALE_PROVIDER_PULL',
        'The branch commits changed. Preview the pull request again before creating it.',
      );
    signal?.throwIfAborted();
    const host = providerOriginSchema.parse(origin);
    return this.request(host, token, signal, async (client, headers) => {
      try {
        const sameRepository =
          options.repository.owner.toLowerCase() === options.source.owner.toLowerCase() &&
          options.repository.name.toLowerCase() === options.source.name.toLowerCase();
        const { data } = await client.pulls.create({
          headers,
          owner: options.repository.owner,
          repo: options.repository.name,
          head: sameRepository ? options.head : `${options.source.owner}:${options.head}`,
          ...(sameRepository ? {} : { head_repo: options.source.name }),
          base: options.base,
          title: options.title,
          body: options.body,
          draft: options.draft,
          maintainer_can_modify: options.maintainerCanModify,
        });
        const summary = pullSummary(host, options.repository, data);
        const matchesRepository = (
          actual: typeof data.head.repo,
          expected: ProviderPullSource['repository'],
        ) =>
          actual?.owner?.login?.toLowerCase() === expected.owner.toLowerCase() &&
          actual?.name?.toLowerCase() === expected.name.toLowerCase();
        if (
          data.head?.sha !== options.revision.head ||
          data.base?.sha !== options.revision.base ||
          data.head.ref !== options.head ||
          data.base.ref !== options.base ||
          !matchesRepository(data.head.repo, options.source) ||
          !matchesRepository(data.base.repo, options.repository) ||
          summary.state !== 'open' ||
          summary.draft !== options.draft
        )
          throw new Error('Unexpected PR acknowledgment');
        return summary;
      } catch (error) {
        const status =
          typeof error === 'object' && error !== null && 'status' in error
            ? Number(error.status)
            : 0;
        if ([400, 401, 403, 404, 422, 429].includes(status))
          throw new ProviderError(
            'PROVIDER_PULL_REJECTED',
            'The provider rejected the pull request. Check permissions, branches and whether a matching pull request already exists.',
          );
        throw new ProviderError(
          'PROVIDER_WRITE_UNCERTAIN',
          'The provider may have created the pull request. Check existing pull requests before trying again.',
        );
      }
    });
  }
  async pullRequests(
    origin: string,
    token: string,
    input: ProviderPullListOptions,
    signal?: AbortSignal,
  ) {
    const options = providerPullListOptionsSchema.parse(input);
    const host = providerOriginSchema.parse(origin);
    return this.request(host, token, signal, async (client, headers) => {
      const { data } = await client.pulls.list({
        headers,
        owner: options.repository.owner,
        repo: options.repository.name,
        state: options.state,
        page: options.page,
        per_page: 100,
        sort: 'created',
        direction: 'desc',
      });
      if (!Array.isArray(data) || data.length > 100)
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'The provider returned an invalid pull-request page.',
        );
      const result = providerPullPageSchema.safeParse({
        pullRequests: data.map((pr) => pullSummary(host, options.repository, pr)),
        nextPage: data.length === 100 && options.page < 100 ? options.page + 1 : null,
        limited: data.length === 100 && options.page === 100,
      });
      if (!result.success)
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'The provider returned an invalid pull-request page.',
        );
      return result.data;
    });
  }
  async pullRequest(
    origin: string,
    token: string,
    input: ProviderPullOptions,
    signal?: AbortSignal,
  ) {
    const options = providerPullOptionsSchema.parse(input);
    const host = providerOriginSchema.parse(origin);
    return this.request(host, token, signal, async (client, headers) => {
      const { data } = await client.pulls.get({
        headers,
        owner: options.repository.owner,
        repo: options.repository.name,
        pull_number: options.number,
      });
      const branch = (value: typeof data.head) => ({
        label: value?.label,
        ref: value?.ref,
        sha: value?.sha,
      });
      const result = providerPullDetailsSchema.safeParse({
        ...pullSummary(host, options.repository, data),
        body: data.body ?? '',
        head: branch(data.head),
        base: branch(data.base),
        merged: data.merged,
        mergeable: data.mergeable,
        mergeableState: data.mergeable_state,
        comments: data.comments,
        reviewComments: data.review_comments,
        commits: data.commits,
        changedFiles: data.changed_files,
        additions: data.additions,
        deletions: data.deletions,
      });
      if (!result.success || result.data.number !== options.number)
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'The provider returned invalid pull-request details.',
        );
      return result.data;
    });
  }
  async pullFiles(
    origin: string,
    token: string,
    input: ProviderPullFilesOptions,
    signal?: AbortSignal,
  ) {
    const options = providerPullFilesOptionsSchema.parse(input);
    await this.checkPullRevision(origin, token, options, signal);
    const result = await this.request(origin, token, signal, async (client, headers) => {
      const { data } = await client.pulls.listFiles({
        headers,
        owner: options.repository.owner,
        repo: options.repository.name,
        pull_number: options.number,
        page: options.page,
        per_page: 100,
      });
      if (
        !Array.isArray(data) ||
        data.length > 100 ||
        data.some(
          (file) =>
            file?.patch !== null && file?.patch !== undefined && typeof file.patch !== 'string',
        )
      )
        throw new ProviderError('PROVIDER_RESPONSE', 'The provider returned an invalid file page.');
      const parsed = providerPullFilesPageSchema.safeParse({
        files: data.map((file) => ({
          path: file?.filename,
          previousPath: file?.previous_filename ?? null,
          status: file?.status,
          additions: file?.additions,
          deletions: file?.deletions,
          changes: file?.changes,
          sha: file?.sha,
          patch: file?.patch?.slice(0, 262144) ?? null,
          patchTruncated: (file?.patch?.length ?? 0) > 262144,
        })),
        nextPage: data.length === 100 && options.page < 30 ? options.page + 1 : null,
        limited: data.length === 100 && options.page === 30,
      });
      if (!parsed.success)
        throw new ProviderError('PROVIDER_RESPONSE', 'The provider returned an invalid file page.');
      return parsed.data;
    });
    await this.checkPullRevision(origin, token, options, signal);
    return result;
  }
  async pullComments(
    origin: string,
    token: string,
    input: ProviderPullReviewsOptions,
    signal?: AbortSignal,
  ) {
    const options = providerPullReviewsOptionsSchema.parse(input);
    return this.request(origin, token, signal, async (client, headers) => {
      const { data } = await client.pulls.listReviewComments({
        headers,
        owner: options.repository.owner,
        repo: options.repository.name,
        pull_number: options.number,
        page: options.page,
        per_page: 100,
        sort: 'created',
        direction: 'asc',
      });
      if (!Array.isArray(data) || data.length > 100)
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'The provider returned an invalid comment page.',
        );
      return providerPullCommentsPageSchema.parse({
        comments: data.map(pullComment),
        nextPage: data.length === 100 && options.page < 100 ? options.page + 1 : null,
        limited: data.length === 100 && options.page === 100,
      });
    });
  }
  async pullReviews(
    origin: string,
    token: string,
    input: ProviderPullReviewsOptions,
    signal?: AbortSignal,
  ) {
    const options = providerPullReviewsOptionsSchema.parse(input);
    return this.request(origin, token, signal, async (client, headers) => {
      const { data } = await client.pulls.listReviews({
        headers,
        owner: options.repository.owner,
        repo: options.repository.name,
        pull_number: options.number,
        page: options.page,
        per_page: 100,
      });
      if (!Array.isArray(data) || data.length > 100)
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'The provider returned an invalid review page.',
        );
      return providerPullReviewsPageSchema.parse({
        reviews: data.map(pullReview),
        nextPage: data.length === 100 && options.page < 100 ? options.page + 1 : null,
        limited: data.length === 100 && options.page === 100,
      });
    });
  }
  async submitReview(
    origin: string,
    token: string,
    input: ProviderSubmitReview,
    signal?: AbortSignal,
  ) {
    const options = providerSubmitReviewSchema.parse(input);
    const current = await this.checkPullRevision(origin, token, options, signal);
    if (current.state !== 'open' || current.merged)
      throw new ProviderError(
        'PROVIDER_PULL_CLOSED',
        'This pull request is closed. Refresh details before continuing.',
      );
    if (current.draft && options.event !== 'COMMENT')
      throw new ProviderError(
        'PROVIDER_PULL_DRAFT',
        'Draft pull requests accept comments but cannot be approved or receive requests for changes.',
      );
    signal?.throwIfAborted();
    return this.request(origin, token, signal, async (client, headers) => {
      try {
        const { data } = await client.pulls.createReview({
          headers,
          owner: options.repository.owner,
          repo: options.repository.name,
          pull_number: options.number,
          commit_id: options.revision.head,
          event: options.event,
          body: options.body,
        });
        const review = pullReview(data);
        const expected =
          options.event === 'APPROVE'
            ? 'APPROVED'
            : options.event === 'COMMENT'
              ? 'COMMENTED'
              : 'CHANGES_REQUESTED';
        if (
          review.commitId !== options.revision.head ||
          review.state !== expected ||
          !review.submittedAt
        )
          throw new Error('Unexpected review acknowledgment');
        return review;
      } catch (error) {
        const status =
          typeof error === 'object' && error !== null && 'status' in error
            ? Number(error.status)
            : 0;
        if ([400, 401, 403, 404, 422, 429].includes(status))
          throw new ProviderError(
            'PROVIDER_REVIEW_REJECTED',
            'The provider rejected the review. Check access, review permissions and account limits before retrying.',
          );
        throw new ProviderError(
          'PROVIDER_WRITE_UNCERTAIN',
          'The provider may have received this review. Refresh the reviews and check before submitting again.',
        );
      }
    });
  }
  async createComment(
    origin: string,
    token: string,
    input: ProviderCreateComment,
    signal?: AbortSignal,
  ) {
    const options = providerCreateCommentSchema.parse(input);
    const current = await this.checkPullRevision(origin, token, options, signal);
    if (current.state !== 'open' || current.merged)
      throw new ProviderError(
        'PROVIDER_PULL_CLOSED',
        'This pull request is closed. Refresh details before continuing.',
      );
    const host = providerOriginSchema.parse(origin);
    const api = host === 'https://github.com' ? 'https://api.github.com' : `${host}/api/v3`;
    const expectedUrl =
      `${api}/repos/${options.repository.owner}/${options.repository.name}/pulls/${options.number}`.toLowerCase();
    const belongs = (url: unknown) => typeof url === 'string' && url.toLowerCase() === expectedUrl;
    const target = options.target;
    if (target.kind === 'reply') {
      await this.request(origin, token, signal, async (client, headers) => {
        const { data } = await client.pulls.getReviewComment({
          headers,
          owner: options.repository.owner,
          repo: options.repository.name,
          comment_id: target.commentId,
        });
        const parent = pullComment(data);
        if (
          parent.id !== target.commentId ||
          parent.replyTo !== null ||
          !belongs(data.pull_request_url)
        )
          throw new ProviderError(
            'PROVIDER_COMMENT_TARGET',
            'The original comment is no longer available in this pull request. Refresh comments before replying.',
          );
      });
    }
    signal?.throwIfAborted();
    return this.request(origin, token, signal, async (client, headers) => {
      try {
        const common = {
          headers,
          owner: options.repository.owner,
          repo: options.repository.name,
          pull_number: options.number,
          body: options.body,
        };
        const { data } =
          target.kind === 'reply'
            ? await client.pulls.createReplyForReviewComment({
                ...common,
                comment_id: target.commentId,
              })
            : await client.pulls.createReviewComment({
                ...common,
                commit_id: options.revision.head,
                path: target.path,
                line: target.line,
                side: target.side,
              });
        const comment = pullComment(data);
        const matches =
          target.kind === 'reply'
            ? comment.replyTo === target.commentId
            : comment.replyTo === null &&
              comment.commitId === options.revision.head &&
              comment.path === target.path &&
              comment.line === target.line &&
              comment.side === target.side;
        if (!belongs(data.pull_request_url) || !matches)
          throw new Error('Unexpected comment acknowledgment');
        return comment;
      } catch (error) {
        const status =
          typeof error === 'object' && error !== null && 'status' in error
            ? Number(error.status)
            : 0;
        if ([400, 401, 403, 404, 422, 429].includes(status))
          throw new ProviderError(
            'PROVIDER_COMMENT_REJECTED',
            'The provider rejected the comment. Check access and the selected location or thread before retrying.',
          );
        throw new ProviderError(
          'PROVIDER_WRITE_UNCERTAIN',
          'The provider may have received this comment. Refresh comments and check before submitting again.',
        );
      }
    });
  }
  async previewMerge(
    origin: string,
    token: string,
    input: ProviderPullOptions,
    signal?: AbortSignal,
  ) {
    const options = providerPullOptionsSchema.parse(input);
    const settings = await this.request(origin, token, signal, async (client, headers) => {
      const { data } = await client.repos.get({
        headers,
        owner: options.repository.owner,
        repo: options.repository.name,
      });
      const flags = [data.allow_merge_commit, data.allow_squash_merge, data.allow_rebase_merge];
      if (
        typeof data.archived !== 'boolean' ||
        flags.some((flag) => flag !== undefined && typeof flag !== 'boolean') ||
        (data.permissions?.push !== undefined && typeof data.permissions.push !== 'boolean')
      )
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'The provider returned invalid repository merge settings.',
        );
      const methods: ProviderMergeMethod[] = [];
      if (data.allow_merge_commit === true) methods.push('merge');
      if (data.allow_squash_merge === true) methods.push('squash');
      if (data.allow_rebase_merge === true) methods.push('rebase');
      return { methods, archived: data.archived, canPush: data.permissions?.push ?? null };
    });
    const pullRequest = await this.pullRequest(origin, token, options, signal);
    return providerMergePreviewSchema.parse({ ...settings, pullRequest });
  }
  async mergePull(origin: string, token: string, input: ProviderMergePull, signal?: AbortSignal) {
    const options = providerMergePullSchema.parse(input);
    const preview = await this.previewMerge(
      origin,
      token,
      { repository: options.repository, number: options.number },
      signal,
    );
    const current = preview.pullRequest;
    if (
      current.head.sha !== options.revision.head ||
      current.base.sha !== options.revision.base ||
      current.head.ref !== options.revision.headRef ||
      current.base.ref !== options.revision.baseRef
    )
      throw new ProviderError(
        'STALE_PROVIDER_PULL',
        'The pull-request commits or branches changed. Refresh the merge preview before continuing.',
      );
    if (current.state !== 'open' || current.merged)
      throw new ProviderError(
        'PROVIDER_PULL_CLOSED',
        'This pull request is closed. Refresh the merge preview before continuing.',
      );
    if (current.draft)
      throw new ProviderError('PROVIDER_PULL_DRAFT', 'Draft pull requests cannot be merged.');
    if (preview.archived || preview.canPush === false)
      throw new ProviderError(
        'PROVIDER_MERGE_ACCESS',
        'The repository is archived or this account cannot push to it.',
      );
    if (!preview.methods.includes(options.method))
      throw new ProviderError(
        'PROVIDER_MERGE_METHOD',
        'The selected merge method is no longer available. Refresh the merge preview.',
      );
    if (current.mergeable !== true)
      throw new ProviderError(
        'PROVIDER_MERGE_NOT_READY',
        'The provider has not confirmed this pull request can merge. Resolve conflicts or refresh the merge preview.',
      );
    signal?.throwIfAborted();
    return this.request(origin, token, signal, async (client, headers) => {
      try {
        const { data } = await client.pulls.merge({
          headers,
          owner: options.repository.owner,
          repo: options.repository.name,
          pull_number: options.number,
          sha: options.revision.head,
          merge_method: options.method,
          ...(options.commitTitle === undefined ? {} : { commit_title: options.commitTitle }),
          ...(options.commitMessage === undefined ? {} : { commit_message: options.commitMessage }),
        });
        if (data?.merged === false)
          throw new ProviderError(
            'PROVIDER_MERGE_REJECTED',
            'The provider did not merge this pull request. Refresh its state and review the repository requirements before trying again.',
          );
        const parsed = providerMergeResultSchema.safeParse({ sha: data?.sha });
        if (data?.merged !== true || !parsed.success)
          throw new Error('Unexpected merge acknowledgment');
        return parsed.data;
      } catch (error) {
        if (error instanceof ProviderError && error.code === 'PROVIDER_MERGE_REJECTED') throw error;
        const status =
          typeof error === 'object' && error !== null && 'status' in error
            ? Number(error.status)
            : 0;
        if ([400, 401, 403, 404, 405, 409, 422, 429].includes(status))
          throw new ProviderError(
            'PROVIDER_MERGE_REJECTED',
            'The provider rejected the merge. Refresh the preview and check permissions, branch protection, required reviews and checks, or whether a merge queue is required.',
          );
        throw new ProviderError(
          'PROVIDER_WRITE_UNCERTAIN',
          'The provider may have merged this pull request. Check its current merge status before trying again.',
        );
      }
    });
  }
  private async checkPullRevision(
    origin: string,
    token: string,
    options: ProviderPullOptions & { revision: { head: string; base: string } },
    signal?: AbortSignal,
  ) {
    const current = await this.pullRequest(
      origin,
      token,
      { repository: options.repository, number: options.number },
      signal,
    );
    if (current.head.sha !== options.revision.head || current.base.sha !== options.revision.base)
      throw new ProviderError(
        'STALE_PROVIDER_PULL',
        'The pull-request commits changed. Refresh details before continuing.',
      );
    return current;
  }
  private async request<T>(
    origin: string,
    token: string,
    signal: AbortSignal | undefined,
    perform: (client: Octokit, headers: Record<string, string>) => Promise<T>,
    options: { readOnlyGraphQL?: boolean } = {},
  ): Promise<T> {
    const host = providerOriginSchema.parse(origin);
    const baseUrl = host === 'https://github.com' ? 'https://api.github.com' : `${host}/api/v3`;
    if (signal?.aborted) throw new ProviderError('CANCELLED', 'Provider request cancelled.');
    this.polling.assertAllowed(host, token);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const boundedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let blockedBeforeDispatch: ProviderError | undefined;
    let writeDispatched = false;
    const guardedFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== new URL(baseUrl).origin || url.username || url.password)
        throw new ProviderError('PROVIDER_HOST', 'Provider request changed its configured host.');
      try {
        this.polling.assertAllowed(host, token);
      } catch (error) {
        if (error instanceof ProviderError) blockedBeforeDispatch = error;
        throw error;
      }
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      // Only the fixed check-rollup query opts in; future GraphQL mutations invalidate reads.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !options.readOnlyGraphQL) {
        this.readCache.clear();
        writeDispatched = true;
      }
      const key =
        method === 'GET' && !headers.has('if-none-match') && !headers.has('if-modified-since')
          ? this.readCache.key(host, token, url.href, headers)
          : undefined;
      const cached = key === undefined ? undefined : this.readCache.get(key);
      if (cached) headers.set('if-none-match', cached.etag);
      const response = await this.fetcher(input, {
        ...init,
        headers,
        signal: boundedSignal,
        redirect: 'error',
        credentials: 'omit',
      });
      this.polling.observe(host, token, url.href, response.status, response.headers);
      boundedSignal.throwIfAborted();
      if ([401, 403, 404].includes(response.status)) this.readCache.clear();
      if (response.status === 304 && cached) {
        await response.body?.cancel();
        if (!this.readCache.storageAllowed(response.headers)) this.readCache.discard(key!);
        return new Response(cached.body, {
          status: 200,
          headers: cached.contentType ? { 'content-type': cached.contentType } : {},
        });
      }
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
      const body = Buffer.concat(chunks);
      boundedSignal.throwIfAborted();
      if (response.status === 403) this.polling.observeForbiddenBody(host, token, url.href, body);
      if (key !== undefined && response.status === 200)
        this.readCache.set(key, response.headers, body);
      return new Response(bytes ? body : null, {
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
      return await perform(client, {
        'X-GitHub-Api-Version': host === 'https://github.com' ? '2026-03-10' : '2022-11-28',
      });
    } catch (error) {
      // SDK/write wrappers may obscure a local refusal. No write was sent in this case.
      if (blockedBeforeDispatch && !writeDispatched) throw blockedBeforeDispatch;
      if (error instanceof ProviderError) error.retryAt = this.polling.retryAt(host, token);
      if (error instanceof ProviderError && error.code === 'PROVIDER_WRITE_UNCERTAIN') throw error;
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
        this.polling.retryAt(host, token),
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

type GitHubPullSummary = {
  number: unknown;
  title: unknown;
  state: unknown;
  draft?: unknown;
  user?: { login?: unknown } | null;
  created_at?: unknown;
  updated_at?: unknown;
  merged_at?: unknown;
};
function pullSummary(
  host: string,
  repository: ProviderPullOptions['repository'],
  data: GitHubPullSummary,
) {
  const result = providerPullSummarySchema.safeParse({
    number: data?.number,
    title: data?.title,
    author: data?.user?.login ?? null,
    state: data?.state,
    draft: data?.draft ?? false,
    createdAt: data?.created_at,
    updatedAt: data?.updated_at,
    mergedAt: data?.merged_at,
    url: `${host}/${repository.owner}/${repository.name}/pull/${data?.number}`,
  });
  if (!result.success)
    throw new ProviderError(
      'PROVIDER_RESPONSE',
      'The provider returned invalid pull-request metadata.',
    );
  return result.data;
}

function pullReview(data: {
  id: number;
  user: { login?: string } | null;
  state: string;
  body: string;
  submitted_at?: string | null;
  commit_id: string | null;
}) {
  if (!Number.isSafeInteger(data?.id) || data.id <= 0)
    throw new ProviderError('PROVIDER_RESPONSE', 'The provider returned an invalid review.');
  const parsed = providerPullReviewSchema.safeParse({
    id: String(data.id),
    author: data.user?.login ?? null,
    state: data.state,
    body: data.body,
    submittedAt: data.submitted_at ?? null,
    commitId: data.commit_id,
  });
  if (!parsed.success)
    throw new ProviderError('PROVIDER_RESPONSE', 'The provider returned an invalid review.');
  return parsed.data;
}

function pullComment(data: {
  id: number;
  in_reply_to_id?: number;
  user: { login?: string } | null;
  body: string;
  path: string;
  diff_hunk: string;
  commit_id: string;
  original_commit_id: string;
  line?: number | null;
  original_line?: number | null;
  start_line?: number | null;
  original_start_line?: number | null;
  side?: string;
  start_side?: string | null;
  created_at: string;
  updated_at: string;
}) {
  if (typeof data?.diff_hunk !== 'string')
    throw new ProviderError(
      'PROVIDER_RESPONSE',
      'The provider returned an invalid review comment.',
    );
  const parsed = providerPullCommentSchema.safeParse({
    id: data.id,
    replyTo: data.in_reply_to_id ?? null,
    author: data.user?.login ?? null,
    body: data.body,
    path: data.path,
    hunk: data.diff_hunk.slice(0, 262144),
    hunkTruncated: data.diff_hunk.length > 262144,
    commitId: data.commit_id,
    originalCommitId: data.original_commit_id,
    line: data.line ?? null,
    originalLine: data.original_line ?? null,
    startLine: data.start_line ?? null,
    originalStartLine: data.original_start_line ?? null,
    side: data.side ?? null,
    startSide: data.start_side ?? null,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  });
  if (!parsed.success)
    throw new ProviderError(
      'PROVIDER_RESPONSE',
      'The provider returned an invalid review comment.',
    );
  return parsed.data;
}
