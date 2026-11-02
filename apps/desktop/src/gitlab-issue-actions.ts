import { createHash } from 'node:crypto';
import { Issues, IssueNotes, Projects } from '@gitbeaker/rest';
import { z } from 'zod';
import {
  providerGitLabIssueIntentSchema,
  providerGitLabIssueActionPreviewSchema,
  providerWriteGitLabIssueSchema,
  type ProviderGitLabIssueIntent,
  type ProviderWriteGitLabIssue,
  type ProviderIssueWriteResult,
} from '@openkraken/ipc-contract';
import { loadIssue, parseIssue, parseIssueNote } from './gitlab-issues.js';
import type { GitLabRead } from './gitlab-merges.js';
import type { GitLabWrite } from './gitlab-discussion-actions.js';
import { ProviderError } from './provider-error.js';
async function project(read: GitLabRead, intent: ProviderGitLabIssueIntent) {
  const path = `${intent.repository.owner}/${intent.repository.name}`;
  return read(`projects/${encodeURIComponent(path)}`, async (client) => {
    const data = z
      .object({
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        path_with_namespace: z.string(),
        archived: z.boolean(),
        issues_enabled: z.boolean().nullish(),
        issues_access_level: z.enum(['disabled', 'private', 'enabled']).nullish(),
      })
      .parse(await new Projects(client).show(path));
    if (data.path_with_namespace !== path)
      throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned another issue project.');
    return {
      id: String(data.id),
      archived: data.archived,
      issuesEnabled: data.issues_enabled ?? null,
      issuesAccessLevel: data.issues_access_level ?? null,
    };
  });
}
export async function previewIssueAction(
  read: GitLabRead,
  origin: string,
  userId: string,
  input: ProviderGitLabIssueIntent,
) {
  const intent = providerGitLabIssueIntentSchema.parse(input);
  if (
    intent.action !== 'state' &&
    /(?:^|[\r\n])[\t ]*\/[a-z_][a-z0-9_-]*(?:\s|$)/i.test(intent.body)
  )
    throw new ProviderError(
      'PROVIDER_ISSUE_COMMAND',
      'This plain-text action cannot run GitLab slash commands. Escape command-like lines before reviewing.',
    );
  const snapshot = await project(read, intent);
  if (
    snapshot.archived ||
    snapshot.issuesEnabled === false ||
    snapshot.issuesAccessLevel === 'disabled'
  )
    throw new ProviderError(
      'PROVIDER_ISSUE_STATE',
      'This project is archived or issues are disabled. Choose an active issue project.',
    );
  const issue =
    intent.action === 'create'
      ? null
      : await loadIssue(read, origin, { repository: intent.repository, number: intent.number });
  if (
    issue &&
    (issue.projectId !== snapshot.id ||
      JSON.stringify(snapshot) !== JSON.stringify(await project(read, intent)))
  )
    throw new ProviderError(
      'STALE_PROVIDER_ISSUE',
      'The issue project changed during review. Review again.',
    );
  if (intent.action === 'state' && issue?.state === intent.state)
    throw new ProviderError(
      'PROVIDER_ISSUE_STATE',
      'The issue already has the requested state. Refresh its details.',
    );
  return providerGitLabIssueActionPreviewSchema.parse({
    project: snapshot,
    issue,
    revision: createHash('sha256')
      .update(JSON.stringify({ origin, userId, intent, project: snapshot, issue }))
      .digest('hex'),
  });
}
export async function writeIssue(
  read: GitLabRead,
  write: GitLabWrite,
  origin: string,
  userId: string,
  input: ProviderWriteGitLabIssue,
): Promise<ProviderIssueWriteResult> {
  const { intent, revision } = providerWriteGitLabIssueSchema.parse(input);
  const current = await previewIssueAction(read, origin, userId, intent);
  if (current.revision !== revision)
    throw new ProviderError(
      'STALE_PROVIDER_ISSUE',
      'The issue, project or draft changed. Review the action again.',
    );
  const projectId = Number(current.project.id);
  if (intent.action === 'create')
    return write(`projects/${projectId}/issues`, 'POST', async (client) => {
      const issue = parseIssue(
        await new Issues(client).create(projectId, intent.title, {
          description: intent.body,
          confidential: intent.confidential,
          issueType: 'issue',
        }),
        projectId,
        origin,
        intent.repository,
      );
      if (
        issue.title !== intent.title ||
        issue.body !== intent.body ||
        issue.state !== 'open' ||
        issue.confidential !== intent.confidential ||
        issue.issueType !== 'issue'
      )
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'GitLab returned an unexpected created issue.',
        );
      return { kind: 'created', issue };
    });
  const before = current.issue!;
  if (intent.action === 'comment')
    return write(`projects/${projectId}/issues/${intent.number}/notes`, 'POST', async (client) => {
      const comment = parseIssueNote(
        await new IssueNotes(client).create(projectId, intent.number, intent.body, {
          internal: intent.internal,
        }),
        before,
      );
      if (
        comment.body !== intent.body ||
        comment.system ||
        (comment.internal ?? comment.confidential) !== intent.internal
      )
        throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned an unexpected issue note.');
      return { kind: 'commented', comment };
    });
  return write(`projects/${projectId}/issues/${intent.number}`, 'PUT', async (client) => {
    const issue = parseIssue(
      await new Issues(client).edit(projectId, intent.number, {
        stateEvent: intent.state === 'closed' ? 'close' : 'reopen',
      }),
      projectId,
      origin,
      intent.repository,
      intent.number,
    );
    if (
      issue.id !== before.id ||
      issue.state !== intent.state ||
      issue.confidential !== before.confidential
    )
      throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned an unexpected issue state.');
    return { kind: 'updated', issue };
  });
}
