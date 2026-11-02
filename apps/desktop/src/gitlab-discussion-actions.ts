import { createHash } from 'node:crypto';
import { MergeRequestDiscussions } from '@gitbeaker/rest';
import type { BaseResourceOptions } from '@gitbeaker/requester-utils';
import {
  providerMergeDiscussionActionSchema,
  providerWriteMergeDiscussionSchema,
  providerMergeDiscussionPreviewSchema,
  providerMergeDiscussionWrittenSchema,
  type ProviderMergeDiscussionAction,
  type ProviderWriteMergeDiscussion,
} from '@openkraken/ipc-contract';
import { loadMergeRequest, type GitLabRead } from './gitlab-merges.js';
import { parseMergeDiscussion, parseMergeNote } from './gitlab-discussions.js';
import { ProviderError } from './provider-error.js';
export type GitLabWrite = <T>(
  endpoint: string,
  method: 'POST' | 'PUT',
  perform: (options: BaseResourceOptions<false>) => Promise<T>,
) => Promise<T>;
export async function previewMergeDiscussionAction(
  read: GitLabRead,
  origin: string,
  input: ProviderMergeDiscussionAction,
) {
  const intent = providerMergeDiscussionActionSchema.parse(input);
  const mergeRequest = await loadMergeRequest(read, origin, {
    repository: intent.repository,
    number: intent.number,
  });
  if (mergeRequest.state === 'locked')
    throw new ProviderError(
      'PROVIDER_DISCUSSION_STATE',
      'This merge request is locked. Refresh its details before continuing.',
    );
  const discussion =
    intent.action === 'comment'
      ? null
      : await read(
          `projects/${mergeRequest.target.projectId}/merge_requests/${intent.number}/discussions/${intent.discussionId}`,
          async (client) => {
            const value = parseMergeDiscussion(
              await new MergeRequestDiscussions(client).show(
                Number(mergeRequest.target.projectId),
                intent.number,
                intent.discussionId,
              ),
              mergeRequest,
            );
            if (value.id !== intent.discussionId)
              throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned another discussion.');
            return value;
          },
        );
  if (discussion?.notes[0]!.system)
    throw new ProviderError(
      'PROVIDER_DISCUSSION_STATE',
      'System notes cannot receive discussion actions.',
    );
  if (intent.action === 'resolve') {
    const notes = discussion!.notes.filter((note) => note.resolvable);
    if (
      discussion!.individual ||
      !notes.length ||
      notes.some((note) => note.resolved === null) ||
      notes.every((note) => note.resolved === intent.resolved)
    )
      throw new ProviderError(
        'PROVIDER_DISCUSSION_STATE',
        'This thread cannot receive the requested resolution change. Refresh its details.',
      );
  }
  const revision = createHash('sha256')
    .update(JSON.stringify({ origin, intent, mergeRequest, discussion }))
    .digest('hex');
  return providerMergeDiscussionPreviewSchema.parse({ mergeRequest, discussion, revision });
}
export async function writeMergeDiscussion(
  read: GitLabRead,
  write: GitLabWrite,
  origin: string,
  input: ProviderWriteMergeDiscussion,
) {
  const { intent, revision } = providerWriteMergeDiscussionSchema.parse(input);
  const current = await previewMergeDiscussionAction(read, origin, intent);
  if (current.revision !== revision)
    throw new ProviderError(
      'STALE_PROVIDER_DISCUSSION',
      'The merge request, discussion or draft changed. Review the action again before submitting.',
    );
  const projectId = Number(current.mergeRequest.target.projectId);
  const endpoint = `projects/${projectId}/merge_requests/${intent.number}/discussions`;
  if (intent.action === 'reply')
    return write(`${endpoint}/${intent.discussionId}/notes`, 'POST', async (client) => {
      const note = parseMergeNote(
        await new MergeRequestDiscussions(client).addNote(
          projectId,
          intent.number,
          intent.discussionId,
          intent.body,
        ),
        current.mergeRequest,
      );
      if (note.system || current.discussion!.notes.some((existing) => existing.id === note.id))
        throw new ProviderError('PROVIDER_RESPONSE', 'GitLab did not return a new reply.');
      return providerMergeDiscussionWrittenSchema.parse({ kind: 'replied', note });
    });
  if (intent.action === 'resolve')
    return write(`${endpoint}/${intent.discussionId}`, 'PUT', async (client) => {
      const discussion = parseMergeDiscussion(
        await new MergeRequestDiscussions(client).resolve(
          projectId,
          intent.number,
          intent.discussionId,
          intent.resolved,
        ),
        current.mergeRequest,
      );
      const notes = discussion.notes.filter((note) => note.resolvable);
      if (
        discussion.id !== intent.discussionId ||
        discussion.individual ||
        !notes.length ||
        notes.some((note) => note.resolved !== intent.resolved)
      )
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'GitLab did not acknowledge the requested resolution.',
        );
      return providerMergeDiscussionWrittenSchema.parse({ kind: 'resolved', discussion });
    });
  return write(endpoint, 'POST', async (client) => {
    const discussion = parseMergeDiscussion(
      await new MergeRequestDiscussions(client).create(projectId, intent.number, intent.body),
      current.mergeRequest,
    );
    if (
      discussion.individual ||
      discussion.notes.length !== 1 ||
      discussion.notes[0]!.system ||
      discussion.notes[0]!.position !== null
    )
      throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned an unexpected discussion.');
    return providerMergeDiscussionWrittenSchema.parse({ kind: 'commented', discussion });
  });
}
