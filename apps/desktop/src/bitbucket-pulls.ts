import { z } from 'zod';
import {
  providerBitbucketCommitSchema,
  providerBitbucketPullDetailsSchema,
  providerPullOptionsSchema,
} from '@openkraken/ipc-contract';
import {
  providerBitbucketIdSchema,
  providerPullNumberSchema,
  providerPullListOptionsSchema,
  providerPullSummarySchema,
  providerPullPageSchema,
  providerRepositoryPathComponentSchema,
  type ProviderPullListOptions,
  type ProviderPullOptions,
} from '@openkraken/ipc-contract';
import { ProviderError } from './provider-error.js';
import { bitbucketPagination, bitbucketPageSchema, bitbucketUnique } from './bitbucket-response.js';

export type BitbucketRead = <T>(endpoint: string, parse: (data: unknown) => T) => Promise<T>;
const repositorySchema = z.object({
  uuid: providerBitbucketIdSchema,
  full_name: z.string().min(3).max(511),
});
const summarySchema = z.object({
  id: providerPullNumberSchema,
  title: z.string().min(1).max(4096),
  author: z.object({ display_name: z.string().min(1).max(255) }).nullish(),
  state: z.enum(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']),
  draft: z.boolean(),
  created_on: z.string().datetime({ offset: true }),
  updated_on: z.string().datetime({ offset: true }),
  destination: z.object({ repository: repositorySchema }),
});
function repositoryPath(repository: ProviderPullOptions['repository']) {
  if (!providerRepositoryPathComponentSchema.safeParse(repository.owner).success)
    throw new ProviderError('PROVIDER_UNSUPPORTED', 'Choose a Bitbucket workspace and repository.');
  return `${repository.owner}/${repository.name}`;
}
async function resolveRepository(
  read: BitbucketRead,
  repository: ProviderPullOptions['repository'],
) {
  const path = repositoryPath(repository);
  return read(`repositories/${path}`, (value) => {
    const data = repositorySchema.parse(value);
    if (data.full_name !== path)
      throw new ProviderError(
        'PROVIDER_RESPONSE',
        'Bitbucket returned another repository. Choose the repository again.',
      );
    return data;
  });
}
function summary(value: unknown, repository: z.infer<typeof repositorySchema>) {
  const data = summarySchema.parse(value);
  if (
    data.destination.repository.uuid !== repository.uuid ||
    data.destination.repository.full_name !== repository.full_name
  )
    throw new ProviderError(
      'PROVIDER_RESPONSE',
      'Bitbucket returned a pull request from another repository.',
    );
  return providerPullSummarySchema.parse({
    number: data.id,
    title: data.title,
    author: data.author?.display_name ?? null,
    state: data.state.toLowerCase(),
    draft: data.draft,
    createdAt: data.created_on,
    updatedAt: data.updated_on,
    // Updated time is not a merge timestamp; the detail API does not supply one.
    mergedAt: null,
    url: `https://bitbucket.org/${repository.full_name}/pull-requests/${data.id}`,
  });
}
export async function loadBitbucketPulls(read: BitbucketRead, input: ProviderPullListOptions) {
  const options = providerPullListOptionsSchema.parse(input);
  if (options.state === 'closed' || options.state === 'locked')
    throw new ProviderError(
      'PROVIDER_UNSUPPORTED',
      'Choose Open, Merged, Declined, Superseded or All for Bitbucket.',
    );
  const repository = await resolveRepository(read, options.repository);
  const endpoint = `repositories/${repository.full_name}/pullrequests`;
  const states =
    options.state === 'all'
      ? ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']
      : [options.state.toUpperCase()];
  const query = new URLSearchParams({
    page: String(options.page),
    pagelen: '100',
    sort: '-created_on',
  });
  for (const state of states) query.append('state', state);
  return read(`${endpoint}?${query}`, (value) => {
    const data = bitbucketPageSchema(summarySchema).parse(value);
    bitbucketUnique(data.values.map((pull) => String(pull.id)));
    if (data.values.some((pull) => !states.includes(pull.state)))
      throw new ProviderError(
        'PROVIDER_RESPONSE',
        'Bitbucket returned pull requests in another state.',
      );
    return providerPullPageSchema.parse({
      pullRequests: data.values.map((pull) => summary(pull, repository)),
      ...bitbucketPagination(data, options.page, endpoint),
    });
  });
}

const personSchema = z.object({
  uuid: providerBitbucketIdSchema,
  display_name: z.string().min(1).max(255),
});
const endpointSchema = z.object({
  repository: repositorySchema.nullish(),
  branch: z.object({ name: z.string().min(1).max(1024) }).nullish(),
  commit: z.object({ hash: providerBitbucketCommitSchema }).nullish(),
});
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const detailsSchema = summarySchema.extend({
  description: z.string().max(262144).nullish(),
  summary: z.object({ raw: z.string().max(262144) }).nullish(),
  source: endpointSchema.nullish(),
  destination: endpointSchema.extend({ repository: repositorySchema }),
  merge_commit: z.object({ hash: providerBitbucketCommitSchema }).nullish(),
  comment_count: count.nullish(),
  task_count: count.nullish(),
  close_source_branch: z.boolean().nullish(),
  queued: z.boolean().nullish(),
  reason: z.string().max(262144).nullish(),
  closed_by: personSchema.nullish(),
  reviewers: z.array(personSchema.nullable()).max(1000).nullish(),
  participants: z
    .array(
      z.object({
        user: personSchema.nullish(),
        role: z.enum(['PARTICIPANT', 'REVIEWER']),
        approved: z.boolean(),
        state: z.enum(['approved', 'changes_requested']).nullish(),
        participated_on: z.string().datetime({ offset: true }).nullish(),
      }),
    )
    .max(1000)
    .nullish(),
});
function person(value: z.infer<typeof personSchema> | null | undefined) {
  return value ? { id: value.uuid, name: value.display_name } : null;
}
function endpoint(value: z.infer<typeof endpointSchema> | null | undefined) {
  let repository = null;
  if (value?.repository) {
    const parts = value.repository.full_name.split('/');
    if (parts.length !== 2)
      throw new ProviderError(
        'PROVIDER_RESPONSE',
        'Bitbucket returned an invalid repository path.',
      );
    repository = {
      id: value.repository.uuid,
      owner: providerRepositoryPathComponentSchema.parse(parts[0]),
      name: providerRepositoryPathComponentSchema.parse(parts[1]),
    };
  }
  return { repository, branch: value?.branch?.name ?? null, commit: value?.commit?.hash ?? null };
}
export async function loadBitbucketPull(read: BitbucketRead, input: ProviderPullOptions) {
  const options = providerPullOptionsSchema.parse(input);
  const repository = await resolveRepository(read, options.repository);
  return read(`repositories/${repository.full_name}/pullrequests/${options.number}`, (value) => {
    const data = detailsSchema.parse(value);
    if (data.id !== options.number)
      throw new ProviderError('PROVIDER_RESPONSE', 'Bitbucket returned another pull request.');
    bitbucketUnique((data.reviewers ?? []).flatMap((user) => (user ? [user.uuid] : [])));
    bitbucketUnique(
      (data.participants ?? []).flatMap((item) => (item.user ? [item.user.uuid] : [])),
    );
    return providerBitbucketPullDetailsSchema.parse({
      ...summary(data, repository),
      provider: 'bitbucket',
      repositoryId: repository.uuid,
      body: data.description ?? data.summary?.raw ?? '',
      source: endpoint(data.source),
      destination: endpoint(data.destination),
      mergeCommit: data.merge_commit?.hash ?? null,
      comments: data.comment_count ?? null,
      openTasks: data.task_count ?? null,
      closeSourceBranch: data.close_source_branch ?? null,
      queued: data.queued ?? null,
      reason: data.reason ?? '',
      closedBy: person(data.closed_by),
      reviewers: data.reviewers?.map(person) ?? null,
      participants:
        data.participants?.map((item) => ({
          user: person(item.user),
          role: item.role,
          approved: item.approved,
          state: item.state ?? null,
          participatedAt: item.participated_on ?? null,
        })) ?? null,
    });
  });
}
