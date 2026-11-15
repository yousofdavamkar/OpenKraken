import { z } from 'zod';

// Only fixed application vocabulary may enter the activity file. Never add request payloads.
export const activityActions = {
  open: 'Open repository',
  repositoryLinkOpen: 'Open linked repository',
  init: 'Initialize repository',
  clone: 'Clone repository',
  openWorktree: 'Open worktree',
  openSubmodule: 'Open submodule',
  files: 'Stage or unstage files',
  patch: 'Stage or unstage selected changes',
  saveWorkingFile: 'Save working file',
  discard: 'Discard changes',
  commit: 'Commit',
  undo: 'Undo or redo',
  reference: 'Change reference',
  remote: 'Change remote',
  fetch: 'Fetch',
  push: 'Push',
  deleteRemote: 'Delete remote reference',
  pull: 'Pull',
  operationAction: 'Continue, skip or abort operation',
  startOperation: 'Start Git operation',
  interactiveRebase: 'Interactive rebase',
  reset: 'Reset',
  resolveConflict: 'Resolve conflict',
  stashPush: 'Create stash',
  stashAction: 'Apply, pop or drop stash',
  addWorktree: 'Create worktree',
  worktreeAction: 'Manage worktree',
  pruneWorktrees: 'Prune worktree registrations',
  updateSubmodules: 'Update submodules',
  syncSubmodules: 'Synchronize submodule URLs',
  lfsSetup: 'Set up Git LFS',
  lfsPull: 'Download LFS objects',
  lfsLocks: 'Refresh server LFS locks',
  providerMergePull: 'Merge pull request',
  providerCreatePull: 'Create pull request',
  providerCreateComment: 'Post pull request comment',
  providerWriteIssue: 'Write issue or issue comment',
  providerWriteGitLabIssue: 'Write GitLab issue or comment',
  providerSubmitReview: 'Submit pull request review',
  providerMergeRequestMerge: 'Merge GitLab merge request',
  providerCreateMergeRequest: 'Create GitLab merge request',
  providerWriteMergeApproval: 'Update merge request approval',
  providerWriteMergeDiscussion: 'Write merge request discussion',
  providerConnect: 'Connect provider account',
  providerDisconnect: 'Disconnect provider account',
  appearanceSave: 'Save appearance',
  commandKeymapSave: 'Save keyboard shortcuts',
} as const;
export type ActivityAction = keyof typeof activityActions;
const time = z.number().int().min(0).max(8640000000000000);
export const activityEntrySchema = z
  .object({
    id: z.string().uuid(),
    action: z.enum(Object.keys(activityActions) as [ActivityAction, ...ActivityAction[]]),
    startedAt: time,
    finishedAt: time.nullable(),
    outcome: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'attention', 'unknown']),
  })
  .strict();
export type ActivityEntry = z.infer<typeof activityEntrySchema>;
export const activityStateSchema = z
  .object({
    entries: z.array(activityEntrySchema).max(500),
    warning: z.enum(['unavailable', 'unsaved']).nullable(),
  })
  .strict();
export type ActivityState = z.infer<typeof activityStateSchema>;
export const activityRequests = [
  z.object({ id: z.string().uuid(), method: z.literal('activityRead') }).strict(),
  z.object({ id: z.string().uuid(), method: z.literal('activityClear') }).strict(),
] as const;
const activityCompletionSchema = activityEntrySchema.pick({ id: true, action: true }).extend({
  outcome: activityEntrySchema.shape.outcome.exclude(['running']),
});
export type ActivityCompletion = z.infer<typeof activityCompletionSchema>;
export const activityEventSchema = z.strictObject({
  type: z.literal('activityChanged'),
  completed: activityCompletionSchema.optional(),
});
