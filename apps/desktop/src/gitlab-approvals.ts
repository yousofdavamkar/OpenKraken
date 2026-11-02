import { createHash } from 'node:crypto';
import type { GitLabWrite } from './gitlab-discussion-actions.js';
import { MergeRequestApprovals } from '@gitbeaker/rest';
import { z } from 'zod';
import {
  providerMergeApprovalOptionsSchema,
  providerWriteMergeApprovalSchema,
  type ProviderMergeApprovalOptions,
  type ProviderWriteMergeApproval,
  providerPullOptionsSchema,
  providerMergeApprovalStateSchema,
  type ProviderPullOptions,
  type ProviderMergeRequestDetails,
} from '@openkraken/ipc-contract';
import { loadMergeRequest, type GitLabRead } from './gitlab-merges.js';
import { ProviderError } from './provider-error.js';
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rule = z.object({
  id: integer,
  name: z.string().min(1).max(1024),
  rule_type: z.string().min(1).max(64),
});
const metadata = z.object({
  id: integer.optional(),
  iid: integer.optional(),
  project_id: integer.optional(),
  approved: z.boolean(),
  user_can_approve: z.boolean(),
  user_has_approved: z.boolean(),
  approved_by: z
    .array(
      z.object({
        user: z.object({ id: integer, username: z.string().min(1).max(255) }),
        approved_at: z.string().datetime({ offset: true }).nullish(),
      }),
    )
    .max(1000),
  approvals_required: count.nullish(),
  approvals_left: count.nullish(),
  require_password_to_approve: z.boolean().nullish(),
  approval_rules_left: z.array(rule).max(1000).nullish(),
  invalid_approvers_rules: z.array(rule).max(1000).nullish(),
});
function approvalState(value: unknown, merge: ProviderMergeRequestDetails, userId: string) {
  const data = metadata.parse(value);
  if (
    (data.id !== undefined && String(data.id) !== merge.id) ||
    (data.iid !== undefined && data.iid !== merge.number) ||
    (data.project_id !== undefined && String(data.project_id) !== merge.target.projectId)
  )
    throw new ProviderError(
      'PROVIDER_RESPONSE',
      'GitLab returned approvals for another merge request.',
    );
  if (
    new Set(data.approved_by.map((entry) => entry.user.id)).size !== data.approved_by.length ||
    data.user_has_approved !== data.approved_by.some((entry) => String(entry.user.id) === userId)
  )
    throw new ProviderError(
      'PROVIDER_RESPONSE',
      'GitLab returned inconsistent approval identities.',
    );
  const rules = (entries: z.infer<typeof rule>[] | null | undefined) => {
    if (entries && new Set(entries.map((entry) => entry.id)).size !== entries.length)
      throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned duplicate approval rules.');
    return (
      entries?.map((entry) => ({
        id: String(entry.id),
        name: entry.name,
        type: entry.rule_type,
      })) ?? null
    );
  };
  return providerMergeApprovalStateSchema.parse({
    approved: data.approved,
    canApprove: data.user_can_approve,
    hasApproved: data.user_has_approved,
    approvedBy: data.approved_by.map((entry) => ({
      id: String(entry.user.id),
      login: entry.user.username,
      approvedAt: entry.approved_at ?? null,
    })),
    required: data.approvals_required ?? null,
    remaining: data.approvals_left ?? null,
    passwordRequired: data.require_password_to_approve ?? null,
    rulesLeft: rules(data.approval_rules_left),
    invalidRules: rules(data.invalid_approvers_rules),
  });
}
export async function loadMergeApprovals(
  read: GitLabRead,
  origin: string,
  userId: string,
  input: ProviderPullOptions,
) {
  const options = providerPullOptionsSchema.parse(input);
  const mergeRequest = await loadMergeRequest(read, origin, options);
  const state = await read(
    `projects/${mergeRequest.target.projectId}/merge_requests/${options.number}/approvals`,
    async (client) =>
      approvalState(
        await new MergeRequestApprovals(client).showConfiguration(
          Number(mergeRequest.target.projectId),
          { mergerequestIId: options.number },
        ),
        mergeRequest,
        userId,
      ),
  );
  const latest = await loadMergeRequest(read, origin, options);
  if (JSON.stringify(latest) !== JSON.stringify(mergeRequest))
    throw new ProviderError(
      'STALE_PROVIDER_APPROVAL',
      'The merge request changed while loading approvals. Refresh before continuing.',
    );
  return { mergeRequest, state };
}

export async function previewMergeApproval(
  read: GitLabRead,
  origin: string,
  userId: string,
  input: ProviderMergeApprovalOptions,
) {
  const options = providerMergeApprovalOptionsSchema.parse(input);
  const snapshot = await loadMergeApprovals(read, origin, userId, {
    repository: options.repository,
    number: options.number,
  });
  if (snapshot.mergeRequest.source.sha !== options.head)
    throw new ProviderError(
      'STALE_PROVIDER_APPROVAL',
      'The merge-request source commit changed. Refresh approvals before reviewing again.',
    );
  if (
    options.action === 'approve'
      ? !snapshot.state.canApprove ||
        snapshot.state.hasApproved ||
        snapshot.mergeRequest.state !== 'open'
      : !snapshot.state.hasApproved
  )
    throw new ProviderError(
      'PROVIDER_APPROVAL_STATE',
      'The current account cannot make this approval change. Refresh approvals and check access.',
    );
  return {
    ...snapshot,
    revision: createHash('sha256')
      .update(JSON.stringify({ origin, userId, options, snapshot }))
      .digest('hex'),
  };
}
export async function writeMergeApproval(
  read: GitLabRead,
  write: GitLabWrite,
  origin: string,
  userId: string,
  input: ProviderWriteMergeApproval,
) {
  const options = providerWriteMergeApprovalSchema.parse(input);
  const preview = await previewMergeApproval(read, origin, userId, {
    repository: options.repository,
    number: options.number,
    action: options.action,
    head: options.head,
  });
  if (options.revision !== preview.revision)
    throw new ProviderError(
      'STALE_PROVIDER_APPROVAL',
      'Approval state changed. Review the current details before submitting again.',
    );
  if (options.action === 'approve' && preview.state.passwordRequired && !options.password)
    throw new ProviderError(
      'PROVIDER_APPROVAL_PASSWORD',
      'GitLab requires your approval password. Review and confirm again with the password.',
    );
  const projectId = Number(preview.mergeRequest.target.projectId);
  return write(
    `projects/${projectId}/merge_requests/${options.number}/${options.action}`,
    'POST',
    async (client) => {
      const api = new MergeRequestApprovals(client);
      const data =
        options.action === 'approve'
          ? await api.approve(projectId, options.number, {
              sha: options.head,
              ...(options.password ? { approvalPassword: options.password } : {}),
            })
          : await api.unapprove(projectId, options.number);
      const state = approvalState(data, preview.mergeRequest, userId);
      if (state.hasApproved !== (options.action === 'approve'))
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'GitLab did not acknowledge the requested approval change.',
        );
      return state;
    },
  );
}
