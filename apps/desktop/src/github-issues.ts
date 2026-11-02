import { z } from 'zod';
import type { Octokit } from '@octokit/rest';
import {
  providerIssueDetailsSchema,
  providerIssueCommentSchema,
  providerIssueCommentsPageSchema,
  type ProviderIssueOptions,
  type ProviderIssueCommentsOptions,
  providerIssueSummarySchema,
  providerIssuePageSchema,
  type ProviderIssueListOptions,
} from '@openkraken/ipc-contract';
import { ProviderError } from './provider-error.js';
const issueMetadata = z.object({
  number: z.unknown(),
  title: z.unknown(),
  state: z.unknown(),
  state_reason: z.unknown().optional(),
  user: z.object({ login: z.string() }).nullable(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])).max(100),
  assignees: z
    .array(z.object({ login: z.string() }))
    .max(100)
    .nullable(),
  milestone: z.object({ title: z.string() }).nullable(),
  locked: z.unknown(),
  comments: z.unknown(),
  created_at: z.unknown(),
  updated_at: z.unknown(),
  closed_at: z.unknown(),
});
function invalid() {
  return new ProviderError('PROVIDER_RESPONSE', 'The provider returned invalid issue data.');
}
function summary(host: string, repository: ProviderIssueListOptions['repository'], value: unknown) {
  const parsed = issueMetadata.safeParse(value);
  if (!parsed.success) throw invalid();
  const data = parsed.data;
  const result = providerIssueSummarySchema.safeParse({
    number: data.number,
    title: data.title,
    state: data.state,
    stateReason: data.state_reason ?? null,
    author: data.user?.login ?? null,
    labels: data.labels.map((label) => (typeof label === 'string' ? label : label.name)),
    assignees: (data.assignees ?? []).map((user) => user.login),
    milestone: data.milestone?.title ?? null,
    locked: data.locked,
    comments: data.comments,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    closedAt: data.closed_at,
    url: `${host}/${repository.owner}/${repository.name}/issues/${data.number}`,
  });
  if (!result.success) throw invalid();
  return result.data;
}
const pageSchema = z.array(z.record(z.string(), z.unknown())).max(100);
export async function loadIssues(
  client: Octokit,
  headers: Record<string, string>,
  host: string,
  options: ProviderIssueListOptions,
) {
  const { data } = await client.issues.listForRepo({
    owner: options.repository.owner,
    repo: options.repository.name,
    state: options.state,
    page: options.page,
    per_page: 100,
    sort: 'created',
    direction: 'desc',
    headers,
  });
  const parsed = pageSchema.safeParse(data);
  if (!parsed.success) throw invalid();
  const full = parsed.data.length === 100;
  return providerIssuePageSchema.parse({
    issues: parsed.data
      .filter((item) => !Object.hasOwn(item, 'pull_request'))
      .map((item) => summary(host, options.repository, item)),
    nextPage: full && options.page < 100 ? options.page + 1 : null,
    limited: full && options.page === 100,
  });
}
export async function loadIssue(
  client: Octokit,
  headers: Record<string, string>,
  host: string,
  options: ProviderIssueOptions,
) {
  const { data } = await client.issues.get({
    owner: options.repository.owner,
    repo: options.repository.name,
    issue_number: options.number,
    headers,
  });
  if (!data || typeof data !== 'object') throw invalid();
  if (Object.hasOwn(data, 'pull_request'))
    throw new ProviderError(
      'PROVIDER_ISSUE_IS_PULL',
      'This item is a pull request. Open it in Pull requests.',
    );
  if (data.number !== options.number) throw invalid();
  const result = providerIssueDetailsSchema.safeParse({
    ...summary(host, options.repository, data),
    body: data.body ?? '',
  });
  if (!result.success) throw invalid();
  return result.data;
}
const commentMetadata = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  user: z.object({ login: z.string() }).nullable(),
  body: z.string().nullable().optional(),
  created_at: z.unknown(),
  updated_at: z.unknown(),
  issue_url: z.string(),
});
export async function loadIssueComments(
  client: Octokit,
  headers: Record<string, string>,
  host: string,
  options: ProviderIssueCommentsOptions,
) {
  await loadIssue(client, headers, host, options);
  const { data } = await client.issues.listComments({
    owner: options.repository.owner,
    repo: options.repository.name,
    issue_number: options.number,
    page: options.page,
    per_page: 100,
    headers,
  });
  const parsed = z.array(commentMetadata).max(100).safeParse(data);
  if (!parsed.success) throw invalid();
  const api = host === 'https://github.com' ? 'https://api.github.com' : `${host}/api/v3`;
  const comments = parsed.data.map((comment) => {
    if (
      comment.issue_url !==
      `${api}/repos/${options.repository.owner}/${options.repository.name}/issues/${options.number}`
    )
      throw invalid();
    const result = providerIssueCommentSchema.safeParse({
      id: String(comment.id),
      author: comment.user?.login ?? null,
      body: comment.body ?? '',
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    });
    if (!result.success) throw invalid();
    return result.data;
  });
  return providerIssueCommentsPageSchema.parse({
    comments,
    nextPage: comments.length === 100 && options.page < 100 ? options.page + 1 : null,
    limited: comments.length === 100 && options.page === 100,
  });
}
