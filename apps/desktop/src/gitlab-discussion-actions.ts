import { createHash } from 'node:crypto';
import { MergeRequestDiscussions } from '@gitbeaker/rest';
import type { BaseResourceOptions } from '@gitbeaker/requester-utils';
import {
  providerPatchLines,
  providerMergeRequestPositionSchema,
  providerMergeDiscussionActionSchema,
  providerWriteMergeDiscussionSchema,
  providerMergeDiscussionPreviewSchema,
  providerMergeDiscussionWrittenSchema,
  type ProviderMergeDiscussionAction,
  type ProviderWriteMergeDiscussion,
} from '@openkraken/ipc-contract';
import { loadMergeRequest, type GitLabRead } from './gitlab-merges.js';
import { parseMergeDiscussion, parseMergeNote } from './gitlab-discussions.js';
import { loadMergeRequestFiles } from './gitlab-files.js';
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
    intent.action === 'comment' || intent.action === 'inline'
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
  let inline = null;
  let fileSnapshot = null;
  if (intent.action === 'inline') {
    const page = await loadMergeRequestFiles(read, origin, {
      repository: intent.repository,
      number: intent.number,
      revision: intent.position.revision,
      page: intent.page,
    });
    const matches = page.files.filter((file) => file.path === intent.position.newPath);
    const file =
      matches.length === 1 &&
      (matches[0]!.previousPath ?? matches[0]!.path) === intent.position.oldPath
        ? matches[0]
        : undefined;
    if (!file || !file.patch || file.patchTruncated || file.collapsed || file.tooLarge)
      throw new ProviderError(
        'PROVIDER_COMMENT_TARGET',
        'A complete text patch is required for this location. Refresh files before commenting.',
      );
    const line = [...providerPatchLines(file.patch).values()].find(
      (line) =>
        line.oldLine === intent.position.oldLine && line.newLine === intent.position.newLine,
    );
    if (!line)
      throw new ProviderError(
        'PROVIDER_COMMENT_TARGET',
        'This line is not present in the current text patch. Select a line again.',
      );
    // File reads guard all three SHAs; also refuse a state/metadata change during review.
    const latest = await loadMergeRequest(read, origin, {
      repository: intent.repository,
      number: intent.number,
    });
    if (JSON.stringify(latest) !== JSON.stringify(mergeRequest))
      throw new ProviderError(
        'STALE_PROVIDER_DISCUSSION',
        'The merge request changed while reviewing this line. Review again.',
      );
    inline = { position: intent.position, text: line.text };
    fileSnapshot = file;
  }
  const revision = createHash('sha256')
    .update(JSON.stringify({ origin, intent, mergeRequest, discussion, fileSnapshot }))
    .digest('hex');
  return providerMergeDiscussionPreviewSchema.parse({ mergeRequest, discussion, inline, revision });
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
    const position = intent.action === 'inline' ? intent.position : null;
    const discussion = parseMergeDiscussion(
      await new MergeRequestDiscussions(client).create(
        projectId,
        intent.number,
        intent.body,
        position
          ? {
              position: {
                positionType: 'text',
                baseSha: position.revision.base,
                headSha: position.revision.head,
                startSha: position.revision.start,
                oldPath: position.oldPath,
                newPath: position.newPath,
                ...(position.oldLine === null ? {} : { oldLine: String(position.oldLine) }),
                ...(position.newLine === null ? {} : { newLine: String(position.newLine) }),
              },
            }
          : undefined,
      ),
      current.mergeRequest,
    );
    if (
      discussion.individual ||
      discussion.notes.length !== 1 ||
      discussion.notes[0]!.system ||
      (position
        ? JSON.stringify(discussion.notes[0]!.position) !==
          JSON.stringify(
            providerMergeRequestPositionSchema.parse({ kind: 'text', ...position, range: null }),
          )
        : discussion.notes[0]!.position !== null)
    )
      throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned an unexpected discussion.');
    return providerMergeDiscussionWrittenSchema.parse({ kind: 'commented', discussion });
  });
}
