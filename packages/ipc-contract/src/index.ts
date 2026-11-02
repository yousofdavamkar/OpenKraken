import { z } from 'zod';

export const oidSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const headSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('branch'), ref: z.string(), oid: oidSchema.optional() }),
  z.object({ kind: z.literal('detached'), oid: oidSchema }),
]);
export const refSchema = z.object({
  name: z.string(),
  shortName: z.string(),
  kind: z.enum(['local', 'remote', 'tag', 'stash', 'other']),
  target: oidSchema,
  objectType: z.string(),
  peeled: oidSchema.optional(),
  peeledType: z.string(),
  isHead: z.boolean(),
  subject: z.string(),
  upstream: z
    .object({
      ref: z.string(),
      ahead: z.number().int().nonnegative(),
      behind: z.number().int().nonnegative(),
      gone: z.boolean(),
    })
    .optional(),
});
export const signatureSchema = z.object({
  name: z.string(),
  email: z.string(),
  time: z.number().int(),
  tzOffsetMin: z.number().int(),
});
export const commitSchema = z.object({
  oid: oidSchema,
  parents: z.array(oidSchema),
  author: signatureSchema,
  committer: signatureSchema,
  summary: z.string(),
  body: z.string(),
  isStash: z.boolean(),
});
export const statusEntrySchema = z.object({
  path: z.string(),
  pathBytes: z.string(),
  origPath: z.string().optional(),
  origPathBytes: z.string().optional(),
  index: z.string(),
  worktree: z.string(),
  submodule: z.string(),
  kind: z.enum(['ordinary', 'rename', 'untracked', 'ignored', 'conflict']),
  stages: z.object({ base: z.string(), ours: z.string(), theirs: z.string() }).optional(),
});
export const statusSchema = z.object({
  entries: z.array(statusEntrySchema),
  ahead: z.number().int(),
  behind: z.number().int(),
  upstream: z.string().optional(),
});
export const repositorySchema = z.object({
  id: z.string(),
  path: z.string(),
  gitDir: z.string(),
  commonDir: z.string(),
  isBare: z.boolean(),
  isShallow: z.boolean(),
  isSparse: z.boolean(),
  head: headSchema,
  state: z.enum([
    'clean',
    'merging',
    'rebasing',
    'rebasing-interactive',
    'cherry-picking',
    'reverting',
    'bisecting',
    'applying-mailbox',
  ]),
});
export const operationStateSchema = z
  .object({
    kind: z.enum(['none', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'bisect']),
    token: z.string().regex(/^[0-9a-f]{64}$/),
    actions: z.array(z.enum(['continue', 'skip', 'abort'])),
    conflicts: z.number().int().nonnegative(),
    message: z.string().max(65536),
    originalHead: oidSchema.optional(),
    currentCommit: oidSchema.optional(),
    branchRef: z.string().optional(),
    progress: z
      .object({ current: z.number().int().nonnegative(), total: z.number().int().positive() })
      .optional(),
  })
  .strict();
export type OperationState = z.infer<typeof operationStateSchema>;
export const operationActionSchema = z
  .object({
    action: z.enum(['continue', 'skip', 'abort']),
    token: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type OperationAction = z.infer<typeof operationActionSchema>;
export const mergePredictionSchema = z
  .object({
    head: oidSchema,
    target: oidSchema,
    tree: oidSchema,
    clean: z.boolean(),
    paths: z.array(z.object({ path: z.string(), pathBytes: z.string() })).max(10000),
  })
  .strict();
export type MergePrediction = z.infer<typeof mergePredictionSchema>;
export const resetSelectionSchema = z
  .object({ mode: z.enum(['soft', 'mixed', 'hard']), target: oidSchema })
  .strict();
export type ResetSelection = z.infer<typeof resetSelectionSchema>;
export const resetPreviewSchema = z
  .object({
    token: z.string().regex(/^[0-9a-f]{64}$/),
    head: headSchema,
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export type ResetPreview = z.infer<typeof resetPreviewSchema>;
export const startOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('merge'),
      mode: z.enum(['ff', 'ff-only', 'no-ff', 'squash']),
      target: oidSchema,
      revision: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('rebase'),
      target: oidSchema,
      revision: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z
    .object({
      kind: z.enum(['cherry-pick', 'revert']),
      target: oidSchema,
      revision: z.string().regex(/^[0-9a-f]{64}$/),
      mainline: z.number().int().min(1).max(128).optional(),
    })
    .strict(),
]);
export type StartOperation = z.infer<typeof startOperationSchema>;

export const graphViewSchema = z
  .object({
    hiddenRefs: z.array(z.string().min(1).max(1024)).max(10000),
    soloRef: z.string().min(1).max(1024).optional(),
    pinnedRef: z.string().min(1).max(1024).optional(),
  })
  .strict();
export type GraphView = z.infer<typeof graphViewSchema>;
export const snapshotSchema = z.object({
  view: graphViewSchema,
  pinnedOid: oidSchema.optional(),
  repository: repositorySchema,
  refs: z.array(refSchema),
  status: statusSchema,
  commits: z.array(commitSchema),
  hasMore: z.boolean(),
  cursor: z.string().uuid(),
  elapsedMs: z.number(),
});
const requestId = z.string().uuid();
const historyRequests = [
  z
    .object({
      id: requestId,
      method: z.literal('page'),
      repoId: z.string().regex(/^[0-9a-f]{64}$/),
      cursor: z.string().uuid(),
      offset: z.number().int().nonnegative(),
      count: z.number().int().min(1).max(5000),
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('search'),
      repoId: z.string().regex(/^[0-9a-f]{64}$/),
      cursor: z.string().uuid(),
      query: z.string().trim().min(1).max(200),
    })
    .strict(),
] as const;
const repoIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const commitOptionsSchema = z
  .object({
    message: z.string().min(1).max(65536),
    revision: z.string().regex(/^[0-9a-f]{64}$/),
    amend: z.boolean().optional(),
    sign: z.boolean().optional(),
  })
  .strict();
export type CommitOptions = z.infer<typeof commitOptionsSchema>;
export const workingStateSchema = z.object({
  operation: operationStateSchema.optional(),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  messageTemplate: z.string().optional(),
  amendMessage: z.string().optional(),
  signing: z.boolean().optional(),
  commitWarning: z.string().optional(),
  status: statusSchema,
  head: headSchema,
  undo: z.object({ id: requestId, label: z.string() }).optional(),
  redo: z.object({ id: requestId, label: z.string() }).optional(),
});
export type WorkingState = z.infer<typeof workingStateSchema>;
const pathBytesSchema = z
  .string()
  .min(1)
  .max(65536)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const conflictVersionSchema = z
  .object({
    oid: oidSchema,
    mode: z.enum(['100644', '100755', '120000', '160000']),
    bytes: z.number().int().nonnegative(),
    text: z
      .string()
      .max(2 * 1024 * 1024)
      .optional(),
    binary: z.boolean(),
  })
  .strict();
export const conflictPreviewSchema = z
  .object({
    path: z.string(),
    pathBytes: pathBytesSchema,
    token: z.string().regex(/^[0-9a-f]{64}$/),
    base: conflictVersionSchema.optional(),
    ours: conflictVersionSchema.optional(),
    theirs: conflictVersionSchema.optional(),
    working: z
      .object({
        text: z
          .string()
          .max(2 * 1024 * 1024)
          .optional(),
        bytes: z.number().int().nonnegative(),
        kind: z.enum(['file', 'symlink', 'missing', 'submodule']),
      })
      .strict(),
    editable: z.boolean(),
    externalTool: z.string().max(128).optional(),
    operation: operationStateSchema.shape.kind,
  })
  .strict();
export type ConflictPreview = z.infer<typeof conflictPreviewSchema>;
export const resolveConflictSchema = z.discriminatedUnion('choice', [
  z
    .object({
      pathBytes: pathBytesSchema,
      token: z.string().regex(/^[0-9a-f]{64}$/),
      choice: z.literal('output'),
      text: z.string().max(2 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      pathBytes: pathBytesSchema,
      token: z.string().regex(/^[0-9a-f]{64}$/),
      choice: z.enum(['ours', 'theirs', 'delete', 'external']),
    })
    .strict(),
]);
export type ResolveConflict = z.infer<typeof resolveConflictSchema>;
export const diffSideSchema = z.enum(['worktree', 'index']);
export const patchOptionsSchema = z
  .object({
    pathBytes: pathBytesSchema,
    side: diffSideSchema,
    token: z.string().regex(/^[0-9a-f]{64}$/),
    lines: z.array(z.number().int().nonnegative()).min(1).max(10000),
  })
  .strict();
export type PatchOptions = z.infer<typeof patchOptionsSchema>;
export const workingDiffSchema = z.object({
  path: z.string(),
  pathBytes: pathBytesSchema,
  side: diffSideSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/),
  oldExists: z.boolean(),
  newExists: z.boolean(),
  oldMode: z.string(),
  newMode: z.string(),
  binary: z.boolean(),
  partialReason: z.string().optional(),
  hunks: z.array(
    z.object({
      oldStart: z.number(),
      oldLines: z.number(),
      newStart: z.number(),
      newLines: z.number(),
      header: z.string(),
      lines: z.array(
        z.object({
          id: z.number().int(),
          kind: z.enum(['context', 'add', 'del']),
          text: z.string(),
          oldNo: z.number().optional(),
          newNo: z.number().optional(),
          noNewline: z.boolean().optional(),
        }),
      ),
    }),
  ),
});
export type WorkingDiff = z.infer<typeof workingDiffSchema>;
export const discardPreviewSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/),
  paths: z.array(z.string()),
  bytes: z.number().nonnegative(),
});
export type DiscardPreview = z.infer<typeof discardPreviewSchema>;
export const referenceOptionsSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('deleteBranch'),
      name: z.string().min(1).max(1024),
      expected: oidSchema,
      force: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('setUpstream'),
      name: z.string().min(1).max(1024),
      expected: oidSchema,
      upstream: z.string().min(1).max(1024).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('renameBranch'),
      name: z.string().min(1).max(1024),
      newName: z.string().min(1).max(1024),
      expected: oidSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('checkoutBranch'),
      name: z.string().min(1).max(1024),
      expected: oidSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('createBranch'),
      name: z.string().min(1).max(1024),
      target: oidSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('createTag'),
      name: z.string().min(1).max(1024),
      target: oidSchema,
      message: z.string().max(65536).optional(),
      sign: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('deleteTag'),
      name: z.string().min(1).max(1024),
      expected: oidSchema,
    })
    .strict(),
]);
export type ReferenceOptions = z.infer<typeof referenceOptionsSchema>;
export const remoteStateSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/),
  remotes: z.array(
    z.object({ name: z.string(), urls: z.array(z.string()), pushUrls: z.array(z.string()) }),
  ),
});
export type RemoteState = z.infer<typeof remoteStateSchema>;
export const remoteNameSchema = z
  .string()
  .min(1)
  .max(1024)
  // eslint-disable-next-line no-control-regex -- Reject control bytes at the IPC boundary.
  .regex(/^[^-\s][^\s\x00-\x1f\x7f]*$/);
const remoteUrlSchema = z
  .string()
  .min(1)
  .max(32768)
  // eslint-disable-next-line no-control-regex -- Reject control bytes at the IPC boundary.
  .regex(/^[^-\x00-\x1f\x7f][^\x00-\x1f\x7f]*$/);
export const cloneOptionsSchema = z
  .object({
    url: remoteUrlSchema,
    branch: z.string().min(1).max(1024).optional(),
    depth: z.number().int().min(1).max(1000000).optional(),
    filter: z.literal('blob:none').optional(),
    sparse: z
      .array(
        z
          .string()
          .min(1)
          .max(1024)
          .refine(
            (path) =>
              !path.startsWith('/') &&
              !path
                .split('/')
                .some((part) => !part || ['.', '..', '.git'].includes(part.toLowerCase())) &&
              [...path].every((char) => char.charCodeAt(0) >= 32 && char !== '\\' && char !== ':'),
            'Use repository-relative directories separated by /',
          ),
      )
      .max(1000)
      .optional(),
  })
  .strict();
export type CloneOptions = z.infer<typeof cloneOptionsSchema>;
const remoteTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const pullOptionsSchema = z
  .object({ mode: z.enum(['ff-only', 'merge', 'rebase']), revision: remoteTokenSchema })
  .strict();
export type PullOptions = z.infer<typeof pullOptionsSchema>;
export const remoteOptionsSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('add'),
      name: remoteNameSchema,
      url: remoteUrlSchema,
      token: remoteTokenSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('setUrl'),
      name: remoteNameSchema,
      url: remoteUrlSchema,
      push: z.boolean().optional(),
      token: remoteTokenSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('rename'),
      name: remoteNameSchema,
      newName: remoteNameSchema,
      token: remoteTokenSchema,
    })
    .strict(),
  z
    .object({ action: z.literal('remove'), name: remoteNameSchema, token: remoteTokenSchema })
    .strict(),
]);
export type RemoteOptions = z.infer<typeof remoteOptionsSchema>;
const pushRefSchema = z
  .string()
  .min(11)
  .max(1024)
  .regex(/^refs\/(heads|tags)\/.+/);
export const pushSelectionSchema = z
  .object({ name: remoteNameSchema, source: pushRefSchema, destination: pushRefSchema })
  .strict();
export type PushSelection = z.infer<typeof pushSelectionSchema>;
export const pushPlanSchema = pushSelectionSchema
  .extend({
    sourceOid: oidSchema,
    remoteOid: oidSchema.nullable(),
    token: remoteTokenSchema,
    url: z.string(),
  })
  .strict();
export type PushPlan = z.infer<typeof pushPlanSchema>;
export const pushOptionsSchema = z
  .object({ plan: pushPlanSchema, force: z.boolean().optional(), upstream: z.boolean().optional() })
  .strict();
export type PushOptions = z.infer<typeof pushOptionsSchema>;
export const deleteRemoteSelectionSchema = z
  .object({ name: remoteNameSchema, destination: pushRefSchema })
  .strict();
export type DeleteRemoteSelection = z.infer<typeof deleteRemoteSelectionSchema>;
export const deleteRemotePlanSchema = deleteRemoteSelectionSchema
  .extend({ remoteOid: oidSchema, token: remoteTokenSchema, url: z.string() })
  .strict();
export type DeleteRemotePlan = z.infer<typeof deleteRemotePlanSchema>;

export const stashStateSchema = z.object({
  token: remoteTokenSchema,
  entries: z
    .array(
      z.object({
        oid: oidSchema,
        selector: z.string().regex(/^stash@\{[0-9]+\}$/),
        subject: z.string(),
      }),
    )
    .max(10000),
});
export type StashState = z.infer<typeof stashStateSchema>;
export const stashPushOptionsSchema = z
  .object({
    revision: remoteTokenSchema,
    message: z.string().max(4096).optional(),
    includeUntracked: z.boolean().optional(),
    stagedOnly: z.boolean().optional(),
    paths: z.array(pathBytesSchema).min(1).max(10000).optional(),
  })
  .strict()
  .refine(
    (value) => !(value.stagedOnly && value.includeUntracked),
    'Staged-only and untracked modes cannot be combined',
  );
export type StashPushOptions = z.infer<typeof stashPushOptionsSchema>;
const stashSelectionSchema = z.object({
  selector: z.string().regex(/^stash@\{[0-9]+\}$/),
  oid: oidSchema,
  token: remoteTokenSchema,
});
export const stashActionOptionsSchema = z.discriminatedUnion('action', [
  stashSelectionSchema
    .extend({ action: z.enum(['apply', 'pop']), restoreIndex: z.boolean().optional() })
    .strict(),
  stashSelectionSchema.extend({ action: z.literal('drop') }).strict(),
  stashSelectionSchema
    .extend({
      action: z.literal('rename'),
      message: z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .refine((message) => !message.includes('\0'), 'Invalid stash message'),
    })
    .strict(),
]);
export type StashActionOptions = z.infer<typeof stashActionOptionsSchema>;
const authenticationAnswer = z
  .object({
    id: requestId,
    method: z.literal('answerPrompt'),
    requestId,
    promptId: requestId,
    answer: z
      .string()
      .max(4096)
      .refine((value) => !/[\r\n]/.test(value) && !value.includes('\0'), 'Use a single-line answer')
      .nullable(),
  })
  .strict();
const workingRequests = [
  z
    .object({
      id: requestId,
      method: z.literal('deleteRemotePreview'),
      repoId: repoIdSchema,
      selection: deleteRemoteSelectionSchema,
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('deleteRemote'),
      repoId: repoIdSchema,
      plan: deleteRemotePlanSchema,
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('pull'),
      repoId: repoIdSchema,
      options: pullOptionsSchema,
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('stashAction'),
      repoId: repoIdSchema,
      options: stashActionOptionsSchema,
    })
    .strict(),
  z.object({ id: requestId, method: z.literal('stashes'), repoId: repoIdSchema }).strict(),
  z
    .object({
      id: requestId,
      method: z.literal('stashPush'),
      repoId: repoIdSchema,
      options: stashPushOptionsSchema,
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('pushPreview'),
      repoId: repoIdSchema,
      selection: pushSelectionSchema,
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('push'),
      repoId: repoIdSchema,
      options: pushOptionsSchema,
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('fetch'),
      repoId: repoIdSchema,
      name: remoteNameSchema,
      background: z.boolean().optional(),
    })
    .strict(),
  z.object({ id: requestId, method: z.literal('remotes'), repoId: repoIdSchema }).strict(),
  z
    .object({
      id: requestId,
      method: z.literal('remote'),
      repoId: repoIdSchema,
      options: remoteOptionsSchema,
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('reference'),
      repoId: repoIdSchema,
      options: referenceOptionsSchema,
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('discardPreview'),
      repoId: repoIdSchema,
      paths: z.array(pathBytesSchema).min(1).max(10000),
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('discard'),
      repoId: repoIdSchema,
      paths: z.array(pathBytesSchema).min(1).max(10000),
      token: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('diff'),
      repoId: repoIdSchema,
      pathBytes: pathBytesSchema,
      side: diffSideSchema,
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('patch'),
      repoId: repoIdSchema,
      options: patchOptionsSchema,
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('commit'),
      repoId: repoIdSchema,
      options: commitOptionsSchema,
    })
    .strict(),
  z.object({ id: requestId, method: z.literal('workingState'), repoId: repoIdSchema }).strict(),
  z
    .object({
      id: requestId,
      method: z.literal('conflictPreview'),
      repoId: repoIdSchema,
      pathBytes: pathBytesSchema,
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('resolveConflict'),
      repoId: repoIdSchema,
      options: resolveConflictSchema,
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('mergePrediction'),
      repoId: repoIdSchema,
      head: oidSchema,
      target: oidSchema,
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('resetPreview'),
      repoId: repoIdSchema,
      selection: resetSelectionSchema,
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('reset'),
      repoId: repoIdSchema,
      selection: resetSelectionSchema,
      token: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('startOperation'),
      repoId: repoIdSchema,
      options: startOperationSchema,
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('operationAction'),
      repoId: repoIdSchema,
      options: operationActionSchema,
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('files'),
      repoId: repoIdSchema,
      action: z.enum(['stage', 'unstage']),
      paths: z.array(pathBytesSchema).min(1).max(10000),
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('undo'),
      repoId: repoIdSchema,
      redo: z.boolean().optional(),
    })
    .strict(),
] as const;
export const requestSchema = z.discriminatedUnion('method', [
  authenticationAnswer,
  z.object({ id: requestId, method: z.literal('clone'), options: cloneOptionsSchema }).strict(),
  ...workingRequests,
  z
    .object({
      id: requestId,
      method: z.literal('appearance'),
      remoteAvatars: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('avatars'),
      emails: z.array(z.string().max(320)).max(100),
    })
    .strict(),
  ...historyRequests,
  z.object({ id: requestId, method: z.literal('open') }).strict(),
  z
    .object({ id: requestId, method: z.literal('init'), branch: z.string().min(1).max(200) })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('refresh'),
      view: graphViewSchema.optional(),
      repoId: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z.object({ id: requestId, method: z.literal('discover') }).strict(),
]);
const repositoryPath = z.string().min(1).max(32768);
export const serviceRequestSchema = z.discriminatedUnion('method', [
  authenticationAnswer,
  z
    .object({
      id: requestId,
      method: z.literal('clone'),
      path: repositoryPath,
      options: cloneOptionsSchema,
    })
    .strict(),
  ...workingRequests,
  ...historyRequests,
  z.object({ id: requestId, method: z.literal('open'), path: repositoryPath }).strict(),
  z
    .object({
      id: requestId,
      method: z.literal('init'),
      path: repositoryPath,
      branch: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      id: requestId,
      method: z.literal('refresh'),
      view: graphViewSchema.optional(),
      repoId: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z.object({ id: requestId, method: z.literal('discover'), path: repositoryPath }).strict(),
]);
export const cancelSchema = z.object({ id: requestId }).strict();
export const resultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('deleteRemotePreview'), plan: deleteRemotePlanSchema }),
  z.object({ kind: z.literal('authenticationAnswered'), accepted: z.boolean() }),
  z.object({
    kind: z.literal('stashAction'),
    state: workingStateSchema,
    stashes: stashStateSchema,
    warning: z.string().optional(),
  }),
  z.object({ kind: z.literal('stashes'), state: stashStateSchema }),
  z.object({ kind: z.literal('pushPreview'), plan: pushPlanSchema }),
  z.object({ kind: z.literal('pushed'), state: remoteStateSchema, warning: z.string().optional() }),
  z.object({ kind: z.literal('remotes'), state: remoteStateSchema }),
  z.object({ kind: z.literal('discardPreview'), preview: discardPreviewSchema }),
  z.object({ kind: z.literal('diff'), diff: workingDiffSchema }),
  z.object({ kind: z.literal('workingState'), state: workingStateSchema }),
  z.object({ kind: z.literal('conflictPreview'), preview: conflictPreviewSchema }),
  z.object({ kind: z.literal('mergePrediction'), prediction: mergePredictionSchema }),
  z.object({ kind: z.literal('resetPreview'), preview: resetPreviewSchema }),
  z.object({ kind: z.literal('appearance'), remoteAvatars: z.boolean() }),
  z.object({
    kind: z.literal('avatars'),
    images: z.record(
      z.string(),
      z
        .string()
        .max(100000)
        .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
        .nullable(),
    ),
  }),
  z.object({
    kind: z.literal('page'),
    cursor: z.string().uuid(),
    offset: z.number().int().nonnegative(),
    commits: z.array(commitSchema),
    hasMore: z.boolean(),
  }),
  z.object({
    kind: z.literal('search'),
    cursor: z.string().uuid(),
    commits: z.array(commitSchema),
    truncated: z.boolean(),
  }),
  z.object({ kind: z.literal('snapshot'), snapshot: snapshotSchema }),
  z.object({ kind: z.literal('discovery'), paths: z.array(z.string()) }),
  z.object({ kind: z.literal('cancelled') }),
  z.object({ kind: z.literal('error'), code: z.string(), message: z.string() }),
]);
export const serviceResponseSchema = z.object({ id: requestId, result: resultSchema });
export const CHANNEL = 'openkraken:request';
export const CANCEL_CHANNEL = 'openkraken:cancel';
export type Commit = z.infer<typeof commitSchema>;
export type Ref = z.infer<typeof refSchema>;
export type StatusEntry = z.infer<typeof statusEntrySchema>;
export type Status = z.infer<typeof statusSchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Request = z.infer<typeof requestSchema>;
export type ServiceRequest = z.infer<typeof serviceRequestSchema>;
export type Result = z.infer<typeof resultSchema>;
export interface DesktopApi {
  request(request: Request): Promise<Result>;
  cancel(id: string): Promise<void>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
}

export const shutdownSchema = z.object({ shutdown: z.literal(true) }).strict();

export const repositoryEventSchema = z
  .object({
    type: z.literal('repositoryChanged'),
    repoId: z.string().regex(/^[0-9a-f]{64}$/),
    domains: z
      .array(
        z.enum([
          'status',
          'refs',
          'graph',
          'stash',
          'worktrees',
          'operationState',
          'config',
          'remotes',
        ]),
      )
      .max(8),
    mode: z.enum(['native', 'polling']),
  })
  .strict();
export type RepositoryEvent = z.infer<typeof repositoryEventSchema>;
export const EVENT_CHANNEL = 'openkraken:repository-event';

export const authenticationPromptSchema = z
  .object({
    type: z.literal('authenticationPrompt'),
    id: requestId,
    promptId: requestId,
    context: z.string().max(1024),
    message: z.string().max(4096),
    kind: z.enum(['username', 'secret', 'confirm']),
  })
  .strict();
export const authenticationClosedSchema = z
  .object({ type: z.literal('authenticationClosed'), id: requestId, promptId: requestId })
  .strict();
export type AuthenticationEvent =
  z.infer<typeof authenticationPromptSchema> | z.infer<typeof authenticationClosedSchema>;
export const transportProblemSchema = z
  .object({
    type: z.literal('transportProblem'),
    id: requestId,
    code: z.literal('SSH_HOST_KEY_CHANGED'),
    message: z.string().max(8192),
  })
  .strict();
export const gitProgressEventSchema = z
  .object({ type: z.literal('gitProgress'), id: requestId, text: z.string().max(4096) })
  .strict();
export const desktopEventSchema = z.discriminatedUnion('type', [
  repositoryEventSchema,
  gitProgressEventSchema,
  authenticationPromptSchema,
  authenticationClosedSchema,
  transportProblemSchema,
]);
export type DesktopEvent = z.infer<typeof desktopEventSchema>;
