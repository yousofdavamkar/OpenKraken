import { Issues, IssueNotes, Projects } from '@gitbeaker/rest';
import { z } from 'zod';
import {
  providerGitLabIssueDetailsSchema,
  providerGitLabIssueCommentSchema,
  providerIssueOptionsSchema,
  providerIssueCommentsOptionsSchema,
  providerIssueCommentsPageSchema,
  type ProviderIssueCommentsOptions,
  providerGitLabIssueSummarySchema,
  providerIssueListOptionsSchema,
  providerIssuePageSchema,
  type ProviderIssueListOptions,
  type ProviderIssueOptions,
} from '@openkraken/ipc-contract';
import type { GitLabRead } from './gitlab-merges.js';
import { ProviderError } from './provider-error.js';
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const date = z.string().datetime({ offset: true });
const user = z.object({ username: z.string().min(1).max(255) });
const issueSchema = z.object({
  id: integer,
  iid: integer,
  project_id: integer,
  title: z.string().min(1).max(4096),
  state: z.enum(['opened', 'closed']),
  author: user.nullable(),
  labels: z.array(z.string().min(1).max(255)).max(100),
  assignees: z.array(user).max(100),
  milestone: z.object({ title: z.string().min(1).max(255) }).nullable(),
  created_at: date,
  updated_at: date,
  closed_at: date.nullable(),
  user_notes_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  confidential: z.boolean(),
  discussion_locked: z.boolean().nullish(),
  issue_type: z.string().min(1).max(64),
  due_date: z.string().date().nullish(),
  weight: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
});
async function project(read: GitLabRead, repository: ProviderIssueOptions['repository']) {
  const path = `${repository.owner}/${repository.name}`;
  return read(`projects/${encodeURIComponent(path)}`, async (client) => {
    const data = z
      .object({ id: integer, path_with_namespace: z.string().min(3).max(2304) })
      .parse(await new Projects(client).show(path));
    if (data.path_with_namespace !== path)
      throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned another issue project.');
    return data.id;
  });
}
function summary(
  data: z.infer<typeof issueSchema>,
  projectId: number,
  origin: string,
  repository: ProviderIssueOptions['repository'],
) {
  if (data.project_id !== projectId)
    throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned an issue from another project.');
  return providerGitLabIssueSummarySchema.parse({
    provider: 'gitlab',
    id: String(data.id),
    projectId: String(data.project_id),
    number: data.iid,
    title: data.title,
    state: data.state === 'opened' ? 'open' : 'closed',
    stateReason: null,
    author: data.author?.username ?? null,
    labels: data.labels,
    assignees: data.assignees.map((user) => user.username),
    milestone: data.milestone?.title ?? null,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    closedAt: data.closed_at,
    comments: data.user_notes_count,
    confidential: data.confidential,
    locked: data.discussion_locked ?? null,
    issueType: data.issue_type,
    dueDate: data.due_date ?? null,
    weight: data.weight ?? null,
    url: `${origin}/${repository.owner}/${repository.name}/-/issues/${data.iid}`,
  });
}
export async function loadIssues(
  read: GitLabRead,
  origin: string,
  input: ProviderIssueListOptions,
) {
  const options = providerIssueListOptionsSchema.parse(input);
  const projectId = await project(read, options.repository);
  const state = options.state === 'open' ? 'opened' : options.state;
  const issues = await read(`projects/${projectId}/issues`, async (client) => {
    const data = z
      .array(issueSchema)
      .max(100)
      .parse(
        await new Issues(client).all({
          projectId,
          ...(state === 'all' ? {} : { state }),
          scope: 'all',
          orderBy: 'created_at',
          sort: 'desc',
          page: options.page,
          perPage: 100,
          maxPages: 1,
          pagination: 'offset',
        }),
      );
    if (
      new Set(data.map((item) => item.id)).size !== data.length ||
      new Set(data.map((item) => item.iid)).size !== data.length ||
      data.some((item) => state !== 'all' && item.state !== state)
    )
      throw new ProviderError(
        'PROVIDER_RESPONSE',
        'GitLab returned duplicate issues or another issue state.',
      );
    return data.map((item) => summary(item, projectId, origin, options.repository));
  });
  return providerIssuePageSchema.parse({
    issues,
    nextPage: issues.length === 100 && options.page < 100 ? options.page + 1 : null,
    limited: issues.length === 100 && options.page === 100,
  });
}

export async function loadIssue(read: GitLabRead, origin: string, input: ProviderIssueOptions) {
  const options = providerIssueOptionsSchema.parse(input);
  const projectId = await project(read, options.repository);
  return read(`projects/${projectId}/issues/${options.number}`, async (client) => {
    return parseIssue(
      await new Issues(client).show(options.number, { projectId }),
      projectId,
      origin,
      options.repository,
      options.number,
    );
  });
}
export async function loadIssueComments(
  read: GitLabRead,
  origin: string,
  input: ProviderIssueCommentsOptions,
) {
  const options = providerIssueCommentsOptionsSchema.parse(input);
  const issue = await loadIssue(read, origin, {
    repository: options.repository,
    number: options.number,
  });
  const comments = await read(
    `projects/${issue.projectId}/issues/${options.number}/notes`,
    async (client) => {
      const data = z
        .array(z.unknown())
        .max(100)
        .parse(
          await new IssueNotes(client).all(Number(issue.projectId), options.number, {
            page: options.page,
            perPage: 100,
            maxPages: 1,
            pagination: 'offset',
            sort: 'asc',
            orderBy: 'created_at',
          }),
        );
      const notes = data.map((entry) => parseIssueNote(entry, issue));
      if (new Set(notes.map((entry) => entry.id)).size !== notes.length)
        throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned duplicate issue notes.');
      return notes;
    },
  );
  const after = await loadIssue(read, origin, {
    repository: options.repository,
    number: options.number,
  });
  if (
    issue.id !== after.id ||
    issue.projectId !== after.projectId ||
    issue.confidential !== after.confidential
  )
    throw new ProviderError(
      'STALE_PROVIDER_ISSUE',
      'The issue identity or visibility changed. Refresh its details and notes.',
    );
  return providerIssueCommentsPageSchema.parse({
    comments,
    nextPage: comments.length === 100 && options.page < 100 ? options.page + 1 : null,
    limited: comments.length === 100 && options.page === 100,
  });
}

export function parseIssue(
  value: unknown,
  projectId: number,
  origin: string,
  repository: ProviderIssueOptions['repository'],
  number?: number,
) {
  const data = issueSchema.extend({ description: z.string().max(262144).nullable() }).parse(value);
  if (number !== undefined && data.iid !== number)
    throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned another issue.');
  return providerGitLabIssueDetailsSchema.parse({
    ...summary(data, projectId, origin, repository),
    body: data.description ?? '',
  });
}

export function parseIssueNote(
  value: unknown,
  issue: { id: string; projectId: string; number: number },
) {
  const entry = z
    .object({
      id: integer,
      author: user.nullable(),
      body: z.string().max(262144),
      created_at: date,
      updated_at: date,
      noteable_id: integer,
      noteable_iid: integer.nullish(),
      noteable_type: z.literal('Issue'),
      project_id: integer,
      system: z.boolean(),
      internal: z.boolean().nullish(),
      confidential: z.boolean().nullish(),
      type: z.string().min(1).max(64).nullish(),
    })
    .parse(value);
  if (
    String(entry.noteable_id) !== issue.id ||
    String(entry.project_id) !== issue.projectId ||
    (entry.noteable_iid !== null &&
      entry.noteable_iid !== undefined &&
      entry.noteable_iid !== issue.number)
  )
    throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned a note from another issue.');
  return providerGitLabIssueCommentSchema.parse({
    provider: 'gitlab',
    id: String(entry.id),
    author: entry.author?.username ?? null,
    body: entry.body,
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
    system: entry.system,
    internal: entry.internal ?? null,
    confidential: entry.confidential ?? null,
    noteType: entry.type ?? null,
  });
}
