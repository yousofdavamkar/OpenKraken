import { z } from 'zod';
import { commitDraftRevisionSchema } from './commit-drafts.js';
import { providerRepositoryTargetSchema } from './providers.js';

const account = z.object({ accountId: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const pullDraftScopeSchema = account.extend({
  repository: providerRepositoryTargetSchema,
});
export const pullDraftSchema = z
  .object({
    owner: z.string().max(2200),
    repo: z.string().max(100),
    head: z.string().max(1024),
    base: z.string().max(1024),
    title: z.string().max(256),
    body: z.string().max(65536),
    draft: z.boolean(),
    maintainerCanModify: z.boolean(),
    uncertain: z.boolean(),
  })
  .strict();
export type PullDraftScope = z.infer<typeof pullDraftScopeSchema>;
export type PullDraft = z.infer<typeof pullDraftSchema>;
const base = z.object({ id: z.string().uuid(), scope: pullDraftScopeSchema }).strict();
export const pullDraftRequests = [
  base.extend({ method: z.literal('pullDraftList'), scope: account }),
  base.extend({ method: z.literal('pullDraftRead') }),
  base.extend({
    method: z.literal('pullDraftSave'),
    revision: commitDraftRevisionSchema,
    draft: pullDraftSchema.nullable(),
  }),
] as const;
export const pullDraftResults = [
  z
    .object({
      kind: z.literal('pullDraft'),
      revision: commitDraftRevisionSchema,
      draft: pullDraftSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pullDraftList'),
      entries: z.array(pullDraftScopeSchema),
      unreadable: z.boolean(),
    })
    .strict(),
] as const;
