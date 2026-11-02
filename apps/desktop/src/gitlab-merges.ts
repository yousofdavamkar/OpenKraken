import { Projects, MergeRequests } from '@gitbeaker/rest';
import type { BaseResourceOptions } from '@gitbeaker/requester-utils';
import { z } from 'zod';
import {
  providerPullListOptionsSchema,
  providerPullPageSchema,
  providerPullSummarySchema,
  providerPullOptionsSchema,
  providerMergeRequestDetailsSchema,
  type ProviderPullListOptions,
  type ProviderPullOptions,
} from '@openkraken/ipc-contract';
import { ProviderError } from './provider-error.js';

export type GitLabRead = <T>(
  endpoint: string,
  perform: (options: BaseResourceOptions<false>) => Promise<T>,
) => Promise<T>;
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const date = z.string().datetime({ offset: true });
const summarySchema = z.object({
  id: integer,
  iid: integer,
  project_id: integer,
  target_project_id: integer,
  title: z.string().min(1).max(4096),
  author: z.object({ username: z.string().min(1).max(255) }).nullable(),
  state: z.enum(['opened', 'closed', 'merged', 'locked']),
  draft: z.boolean(),
  created_at: date,
  updated_at: date,
  merged_at: date.nullable(),
});
async function resolveProject(read: GitLabRead, repository: ProviderPullOptions['repository']) {
  const path = `${repository.owner}/${repository.name}`;
  const project = await read(`projects/${encodeURIComponent(path)}`, async (options) =>
    z
      .object({ id: integer, path_with_namespace: z.string().max(2304) })
      .parse(await new Projects(options).show(path)),
  );
  if (project.path_with_namespace !== path)
    throw new ProviderError(
      'PROVIDER_RESPONSE',
      'GitLab returned another repository. Choose the repository again.',
    );
  return project.id;
}
function summary(
  value: unknown,
  projectId: number,
  origin: string,
  repository: ProviderPullOptions['repository'],
) {
  const data = summarySchema.parse(value);
  if (data.project_id !== projectId || data.target_project_id !== projectId)
    throw new ProviderError(
      'PROVIDER_RESPONSE',
      'GitLab returned a merge request from another project.',
    );
  return providerPullSummarySchema.parse({
    number: data.iid,
    title: data.title,
    author: data.author?.username ?? null,
    state: data.state === 'opened' ? 'open' : data.state,
    draft: data.draft,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    mergedAt: data.merged_at,
    url: `${origin}/${repository.owner}/${repository.name}/-/merge_requests/${data.iid}`,
  });
}
export async function loadMergeRequests(
  read: GitLabRead,
  origin: string,
  input: ProviderPullListOptions,
) {
  const options = providerPullListOptionsSchema.parse(input);
  const projectId = await resolveProject(read, options.repository);
  return read(`projects/${projectId}/merge_requests`, async (client) => {
    const state = options.state === 'open' ? 'opened' : options.state;
    const data = z
      .array(summarySchema)
      .max(100)
      .parse(
        await new MergeRequests(client).all({
          projectId,
          // Omitting state means all states; Gitbeaker models only the explicit filters.
          ...(state === 'all' ? {} : { state }),
          scope: 'all',
          page: options.page,
          perPage: 100,
          maxPages: 1,
          pagination: 'offset',
          orderBy: 'updated_at',
          sort: 'desc',
        }),
      );
    if (state !== 'all' && data.some((item) => item.state !== state))
      throw new ProviderError(
        'PROVIDER_RESPONSE',
        'GitLab returned merge requests in another state.',
      );
    return providerPullPageSchema.parse({
      pullRequests: data.map((item) => summary(item, projectId, origin, options.repository)),
      nextPage: data.length === 100 && options.page < 100 ? options.page + 1 : null,
      limited: data.length === 100 && options.page === 100,
    });
  });
}

const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const detailSchema = summarySchema.extend({
  description: z.string().max(262144).nullable(),
  source_project_id: integer.nullable(),
  source_branch: z.string().min(1).max(1024),
  target_branch: z.string().min(1).max(1024),
  sha: oid.nullable(),
  diff_refs: z
    .union([z.object({ base_sha: oid, head_sha: oid, start_sha: oid }), z.object({}).strict()])
    .nullish(),
  changes_count: z
    .string()
    .regex(/^(?:[0-9]+\+?)?$/)
    .max(17)
    .nullish(),
  user_notes_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  detailed_merge_status: z.string().min(1).max(128),
  has_conflicts: z.boolean(),
});
export async function loadMergeRequest(
  read: GitLabRead,
  origin: string,
  input: ProviderPullOptions,
) {
  const options = providerPullOptionsSchema.parse(input);
  const projectId = await resolveProject(read, options.repository);
  return read(`projects/${projectId}/merge_requests/${options.number}`, async (client) => {
    const data = detailSchema.parse(
      await new MergeRequests(client).show(projectId, options.number),
    );
    if (data.iid !== options.number)
      throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned another merge request.');
    const refs = data.diff_refs;
    return providerMergeRequestDetailsSchema.parse({
      ...summary(data, projectId, origin, options.repository),
      provider: 'gitlab',
      body: data.description ?? '',
      source: {
        projectId: data.source_project_id === null ? null : String(data.source_project_id),
        branch: data.source_branch,
        sha: data.sha,
      },
      target: { projectId: String(data.target_project_id), branch: data.target_branch },
      diffRefs:
        refs && 'base_sha' in refs
          ? { base: refs.base_sha, head: refs.head_sha, start: refs.start_sha }
          : null,
      changesCount: data.changes_count
        ? {
            count: Number(data.changes_count.replace(/\+$/, '')),
            limited: data.changes_count.endsWith('+'),
          }
        : null,
      notesCount: data.user_notes_count,
      mergeStatus: data.detailed_merge_status,
      conflicts: data.has_conflicts,
    });
  });
}
