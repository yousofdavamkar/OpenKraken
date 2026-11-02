import { createHash } from 'node:crypto';
import { Branches, MergeRequests, Projects } from '@gitbeaker/rest';
import { z } from 'zod';
import {
  providerPullOptionsSchema,
  providerBranchNameSchema,
  providerMergeRequestMergeStateSchema,
  providerMergeRequestMergeIntentSchema,
  providerMergeMergeRequestSchema,
  providerMergeRequestMergedSchema,
  type ProviderPullOptions,
  type ProviderMergeRequestMergeIntent,
  type ProviderMergeMergeRequest,
} from '@openkraken/ipc-contract';
import { parseMergeRequest, mergeRequestSummary, type GitLabRead } from './gitlab-merges.js';
import type { GitLabWrite } from './gitlab-discussion-actions.js';
import { ProviderError } from './provider-error.js';
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const mergeMetadata = z.object({
  user: z.object({ can_merge: z.boolean() }).nullish(),
  squash: z.boolean(),
  squash_on_merge: z.boolean().optional(),
  should_remove_source_branch: z.boolean().nullish(),
  force_remove_source_branch: z.boolean().nullish(),
  merge_after: z.string().datetime({ offset: true }).nullish(),
  merge_when_pipeline_succeeds: z.boolean().nullish(),
  blocking_discussions_resolved: z.boolean().nullish(),
  head_pipeline: z.object({ id: integer, sha: oid, status: z.string().min(1).max(128) }).nullish(),
});
export async function loadMergeRequestMergeState(
  read: GitLabRead,
  origin: string,
  input: ProviderPullOptions,
) {
  const options = providerPullOptionsSchema.parse(input);
  const path = `${options.repository.owner}/${options.repository.name}`;
  const project = await read(`projects/${encodeURIComponent(path)}`, async (client) => {
    const data = z
      .object({
        id: integer,
        path_with_namespace: z.string().max(2304),
        archived: z.boolean(),
        merge_method: z.enum(['merge', 'rebase_merge', 'ff']),
        squash_option: z.enum(['never', 'always', 'default_on', 'default_off']),
        only_allow_merge_if_pipeline_succeeds: z.boolean().nullish(),
        only_allow_merge_if_all_discussions_are_resolved: z.boolean().nullish(),
      })
      .parse(await new Projects(client).show(path));
    if (data.path_with_namespace !== path)
      throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned another repository.');
    return data;
  });
  const merge = () =>
    read(`projects/${project.id}/merge_requests/${options.number}`, async (client) => {
      const raw = await new MergeRequests(client).show(project.id, options.number);
      return {
        mergeRequest: parseMergeRequest(raw, project.id, origin, options),
        metadata: mergeMetadata.parse(raw),
      };
    });
  const first = await merge();
  const branch = (projectId: string, name: string) =>
    read(
      `projects/${projectId}/repository/branches/${encodeURIComponent(name)}`,
      async (client) => {
        providerBranchNameSchema.parse(name);
        const data = z
          .object({
            name: providerBranchNameSchema,
            commit: z.object({ id: oid }),
            protected: z.boolean(),
            default: z.boolean(),
          })
          .parse(await new Branches(client).show(Number(projectId), name));
        if (data.name !== name)
          throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned another branch.');
        return data;
      },
    );
  const source =
    first.mergeRequest.source.projectId === null
      ? null
      : await branch(first.mergeRequest.source.projectId, first.mergeRequest.source.branch);
  const target = await branch(String(project.id), first.mergeRequest.target.branch);
  const last = await merge();
  if (JSON.stringify(first) !== JSON.stringify(last))
    throw new ProviderError(
      'STALE_PROVIDER_MERGE',
      'The merge request changed while loading its review. Refresh the review.',
    );
  const metadata = last.metadata;
  return providerMergeRequestMergeStateSchema.parse({
    mergeRequest: last.mergeRequest,
    head: source?.commit.id ?? null,
    base: target.commit.id,
    sourceProtected: source?.protected ?? null,
    sourceDefault: source?.default ?? null,
    canMerge: metadata.user?.can_merge ?? null,
    squash: metadata.squash_on_merge ?? metadata.squash,
    removeSourceBranch: metadata.should_remove_source_branch ?? null,
    forceRemoveSourceBranch: metadata.force_remove_source_branch ?? null,
    mergeAfter: metadata.merge_after ?? null,
    autoMerge: metadata.merge_when_pipeline_succeeds ?? null,
    discussionsResolved: metadata.blocking_discussions_resolved ?? null,
    pipeline: metadata.head_pipeline
      ? {
          id: String(metadata.head_pipeline.id),
          sha: metadata.head_pipeline.sha,
          status: metadata.head_pipeline.status,
        }
      : null,
    policy: {
      method: project.merge_method,
      squash: project.squash_option,
      archived: project.archived,
      pipelineRequired: project.only_allow_merge_if_pipeline_succeeds ?? null,
      discussionsRequired: project.only_allow_merge_if_all_discussions_are_resolved ?? null,
    },
  });
}
export async function previewMergeRequestMerge(
  read: GitLabRead,
  origin: string,
  userId: string,
  input: ProviderMergeRequestMergeIntent,
) {
  const intent = providerMergeRequestMergeIntentSchema.parse(input);
  const snapshot = await loadMergeRequestMergeState(read, origin, {
    repository: intent.repository,
    number: intent.number,
  });
  const merge = snapshot.mergeRequest;
  if (!snapshot.head || snapshot.head !== intent.head || merge.source.sha !== intent.head)
    throw new ProviderError(
      'STALE_PROVIDER_MERGE',
      'The source commit changed or is not ready. Refresh the merge review.',
    );
  const reason = snapshot.policy.archived
    ? 'The repository is archived.'
    : merge.state !== 'open'
      ? 'The merge request is no longer open.'
      : merge.draft
        ? 'Draft merge requests cannot be merged.'
        : snapshot.canMerge !== true
          ? 'GitLab has not granted this account permission to merge.'
          : snapshot.autoMerge
            ? 'This merge request already has an automatic merge scheduled. Manage it on GitLab.'
            : merge.conflicts || merge.mergeStatus !== 'mergeable'
              ? `GitLab reports merge status: ${merge.mergeStatus}. Refresh after resolving it.`
              : snapshot.mergeAfter && Date.parse(snapshot.mergeAfter) > Date.now()
                ? 'The configured merge time has not arrived.'
                : snapshot.policy.squash === 'never' && intent.squash
                  ? 'This project forbids squashing.'
                  : snapshot.policy.squash === 'always' && !intent.squash
                    ? 'This project requires squashing.'
                    : snapshot.policy.method === 'ff' && intent.mergeMessage !== undefined
                      ? 'Fast-forward merging does not create a merge commit message.'
                      : snapshot.forceRemoveSourceBranch && !intent.removeSourceBranch
                        ? 'The merge request is configured to remove its source branch. Confirm removal or change that setting on GitLab.'
                        : intent.removeSourceBranch &&
                            (snapshot.sourceDefault || snapshot.sourceProtected)
                          ? 'The default or protected source branch cannot be removed by this workflow.'
                          : '';
  if (reason) throw new ProviderError('PROVIDER_MERGE_STATE', reason);
  return {
    snapshot,
    revision: createHash('sha256')
      .update(JSON.stringify({ origin, userId, intent, snapshot }))
      .digest('hex'),
  };
}
export async function mergeMergeRequest(
  read: GitLabRead,
  write: GitLabWrite,
  origin: string,
  userId: string,
  input: ProviderMergeMergeRequest,
) {
  const options = providerMergeMergeRequestSchema.parse(input);
  const review = await previewMergeRequestMerge(read, origin, userId, options.intent);
  if (review.revision !== options.revision)
    throw new ProviderError(
      'STALE_PROVIDER_MERGE',
      'The merge options, project policy or branch state changed. Review again before merging.',
    );
  const { intent } = options;
  const current = review.snapshot.mergeRequest;
  const projectId = Number(current.target.projectId);
  return write(
    `projects/${projectId}/merge_requests/${intent.number}/merge`,
    'PUT',
    async (client) => {
      const raw = await new MergeRequests(client).accept(projectId, intent.number, {
        sha: intent.head,
        squash: intent.squash,
        shouldRemoveSourceBranch: intent.removeSourceBranch,
        autoMerge: false,
        mergeWhenPipelineSucceeds: false,
        ...(intent.mergeMessage !== undefined ? { mergeCommitMessage: intent.mergeMessage } : {}),
        ...(intent.squashMessage !== undefined
          ? { squashCommitMessage: intent.squashMessage }
          : {}),
      });
      const data = z
        .object({
          id: integer,
          source_project_id: integer,
          source_branch: z.string(),
          target_branch: z.string(),
          sha: oid,
          squash: z.boolean(),
          squash_on_merge: z.boolean().optional(),
          merge_when_pipeline_succeeds: z.boolean().nullish(),
          merge_commit_sha: oid.nullish(),
          squash_commit_sha: oid.nullish(),
        })
        .parse(raw);
      const result = mergeRequestSummary(raw, projectId, origin, intent.repository);
      if (
        String(data.id) !== current.id ||
        result.number !== intent.number ||
        result.state !== 'merged' ||
        !result.mergedAt ||
        String(data.source_project_id) !== current.source.projectId ||
        data.source_branch !== current.source.branch ||
        data.target_branch !== current.target.branch ||
        data.sha !== intent.head ||
        (data.squash_on_merge ?? data.squash) !== intent.squash ||
        data.merge_when_pipeline_succeeds === true
      )
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'GitLab did not acknowledge this direct merge. Check the merge request before retrying.',
        );
      return providerMergeRequestMergedSchema.parse({
        mergeRequest: result,
        mergeCommit: data.merge_commit_sha ?? null,
        squashCommit: data.squash_commit_sha ?? null,
      });
    },
  );
}
