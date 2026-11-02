import { createHash } from 'node:crypto';
import { Branches, Projects, MergeRequests } from '@gitbeaker/rest';
import { z } from 'zod';
import {
  providerMergeCreationIntentSchema,
  providerCreateMergeRequestSchema,
  providerMergeCreationPreviewSchema,
  providerBranchNameSchema,
  type ProviderMergeCreationIntent,
  type ProviderCreateMergeRequest,
} from '@openkraken/ipc-contract';
import { mergeRequestSummary, type GitLabRead } from './gitlab-merges.js';
import type { GitLabWrite } from './gitlab-discussion-actions.js';
import { ProviderError } from './provider-error.js';
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export async function creationProject(
  read: GitLabRead,
  repository: ProviderMergeCreationIntent['repository'],
) {
  const path = `${repository.owner}/${repository.name}`;
  return read(`projects/${encodeURIComponent(path)}`, async (client) => {
    const data = z
      .object({
        id: integer,
        path_with_namespace: z.string().max(2304),
        archived: z.boolean(),
        default_branch: providerBranchNameSchema.nullable(),
      })
      .parse(await new Projects(client).show(path));
    if (data.path_with_namespace !== path)
      throw new ProviderError(
        'PROVIDER_RESPONSE',
        'GitLab returned another repository. Choose it again.',
      );
    return { id: data.id, archived: data.archived, defaultBranch: data.default_branch };
  });
}
async function branch(read: GitLabRead, project: number, name: string) {
  return read(
    `projects/${project}/repository/branches/${encodeURIComponent(name)}`,
    async (client) => {
      const data = z
        .object({ name: providerBranchNameSchema, commit: z.object({ id: oid }) })
        .parse(await new Branches(client).show(project, name));
      if (data.name !== name)
        throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned another branch.');
      return data.commit.id;
    },
  );
}
export async function previewMergeCreation(
  read: GitLabRead,
  origin: string,
  userId: string,
  input: ProviderMergeCreationIntent,
) {
  const intent = providerMergeCreationIntentSchema.parse(input);
  const draftTitle = /^(?:draft:|\[draft\]|\(draft\)|wip:|\[wip\]|\(wip\))/i.test(intent.title);
  if (!intent.draft && draftTitle)
    throw new ProviderError(
      'PROVIDER_CREATION_STATE',
      'Remove the draft prefix from the title or select Create as draft.',
    );
  const title = intent.draft && !draftTitle ? `Draft: ${intent.title}` : intent.title;
  if (title.length > 255)
    throw new ProviderError(
      'PROVIDER_CREATION_STATE',
      'Shorten the title to fit 255 characters including the draft prefix.',
    );
  const source = await creationProject(read, intent.source);
  const target = await creationProject(read, intent.repository);
  if (source.archived || target.archived)
    throw new ProviderError(
      'PROVIDER_CREATION_STATE',
      'Choose active source and target repositories.',
    );
  if (source.id === target.id && intent.head === intent.base)
    throw new ProviderError('PROVIDER_PULL_EMPTY', 'Choose different source and target branches.');
  const head = await branch(read, source.id, intent.head);
  const base = await branch(read, target.id, intent.base);
  if (head === base)
    throw new ProviderError(
      'PROVIDER_PULL_EMPTY',
      'The branches point to the same commit. Push changes or choose different branches.',
    );
  const snapshot = { source, target, head, base, title };
  return providerMergeCreationPreviewSchema.parse({
    head,
    base,
    title,
    sourceProjectId: String(source.id),
    targetProjectId: String(target.id),
    revision: createHash('sha256')
      .update(JSON.stringify({ origin, userId, intent, snapshot }))
      .digest('hex'),
  });
}
export async function createMergeRequest(
  read: GitLabRead,
  write: GitLabWrite,
  origin: string,
  userId: string,
  input: ProviderCreateMergeRequest,
) {
  const options = providerCreateMergeRequestSchema.parse(input);
  const current = await previewMergeCreation(read, origin, userId, options.intent);
  if (current.revision !== options.revision)
    throw new ProviderError(
      'STALE_PROVIDER_CREATION',
      'The draft, projects or branch commits changed. Preview the merge request again.',
    );
  const { intent } = options;
  return write(`projects/${current.sourceProjectId}/merge_requests`, 'POST', async (client) => {
    const raw = await new MergeRequests(client).create(
      Number(current.sourceProjectId),
      intent.head,
      intent.base,
      current.title,
      {
        targetProjectId: Number(current.targetProjectId),
        description: intent.body,
        allowCollaboration: intent.maintainerCanModify,
        removeSourceBranch: false,
      },
    );
    const data = z
      .object({
        source_project_id: integer,
        target_project_id: integer,
        source_branch: z.string(),
        target_branch: z.string(),
        description: z.string().nullable(),
        sha: oid.nullable(),
        allow_collaboration: z.boolean().nullable(),
      })
      .parse(raw);
    const result = mergeRequestSummary(
      raw,
      Number(current.targetProjectId),
      origin,
      intent.repository,
    );
    if (
      String(data.source_project_id) !== current.sourceProjectId ||
      String(data.target_project_id) !== current.targetProjectId ||
      data.source_branch !== intent.head ||
      data.target_branch !== intent.base ||
      (data.sha !== null && data.sha !== current.head) ||
      (data.description ?? '') !== intent.body ||
      result.title !== current.title ||
      result.state !== 'open' ||
      result.draft !== intent.draft ||
      (data.allow_collaboration ?? false) !== intent.maintainerCanModify
    )
      throw new ProviderError(
        'PROVIDER_RESPONSE',
        'GitLab returned a different merge request. Check existing requests before retrying.',
      );
    return result;
  });
}
