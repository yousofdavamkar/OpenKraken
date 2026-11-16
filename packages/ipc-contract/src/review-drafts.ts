import { z } from 'zod';
import { commitDraftRevisionSchema } from './commit-drafts.js';
import {
  providerCommentTargetSchema,
  providerPullOptionsSchema,
  providerPullRevisionSchema,
} from './providers.js';

export const reviewDraftScopeSchema = providerPullOptionsSchema.extend({
  accountId: z.string().regex(/^[0-9a-f]{64}$/),
});
export const reviewDraftTargetSchema = providerCommentTargetSchema.nullable();
export const reviewDraftSchema = z
  .object({
    body: z.string().max(65536),
    event: z.enum(['APPROVE', 'COMMENT', 'REQUEST_CHANGES']),
    source: providerPullRevisionSchema,
    uncertain: z.boolean(),
  })
  .strict();
export type ReviewDraftScope = z.infer<typeof reviewDraftScopeSchema>;
export type ReviewDraft = z.infer<typeof reviewDraftSchema>;
const base = z.object({ id: z.string().uuid(), scope: reviewDraftScopeSchema }).strict();
export const reviewDraftRequests = [
  base.extend({
    method: z.literal('reviewDraftList'),
    scope: z.union([reviewDraftScopeSchema, reviewDraftScopeSchema.pick({ accountId: true })]),
  }),
  base.extend({ method: z.literal('reviewDraftRead'), target: reviewDraftTargetSchema }),
  base.extend({
    method: z.literal('reviewDraftSave'),
    target: reviewDraftTargetSchema,
    revision: commitDraftRevisionSchema,
    draft: reviewDraftSchema.nullable(),
  }),
] as const;
export const reviewDraftResults = [
  z
    .object({
      kind: z.literal('reviewDraft'),
      revision: commitDraftRevisionSchema,
      draft: reviewDraftSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reviewDraftList'),
      entries: z.array(
        z.object({ scope: reviewDraftScopeSchema, target: reviewDraftTargetSchema }).strict(),
      ),
      unreadable: z.boolean(),
    })
    .strict(),
] as const;
