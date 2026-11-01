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
export const requestSchema = z.discriminatedUnion('method', [
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
}

export const shutdownSchema = z.object({ shutdown: z.literal(true) }).strict();
