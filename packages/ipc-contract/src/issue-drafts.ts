import { z } from 'zod';
import { commitDraftRevisionSchema } from './commit-drafts.js';
import { providerIssueOptionsSchema, providerRepositoryTargetSchema } from './providers.js';

const number = providerIssueOptionsSchema.shape.number;
export const issueDraftIntentSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create') }).strict(),
  z.object({ action: z.literal('comment'), number }).strict(),
  z.object({ action: z.literal('state'), number, state: z.enum(['open', 'closed']) }).strict(),
]);
const account = z.object({ accountId: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const issueDraftScopeSchema = account.extend({
  repository: providerRepositoryTargetSchema,
  intent: issueDraftIntentSchema,
});
export const issueDraftSchema = z
  .object({
    title: z.string().max(256),
    body: z.string().max(65536),
    confidential: z.boolean(),
    internal: z.boolean(),
    reason: z.enum(['completed', 'not_planned']),
    uncertain: z.boolean(),
  })
  .strict();
export type IssueDraftScope = z.infer<typeof issueDraftScopeSchema>;
export type IssueDraft = z.infer<typeof issueDraftSchema>;
const base = z.object({ id: z.string().uuid(), scope: issueDraftScopeSchema }).strict();
export const issueDraftRequests = [
  base.extend({ method: z.literal('issueDraftList'), scope: account }),
  base.extend({ method: z.literal('issueDraftRead') }),
  base.extend({
    method: z.literal('issueDraftSave'),
    revision: commitDraftRevisionSchema,
    draft: issueDraftSchema.nullable(),
  }),
] as const;
export const issueDraftResults = [
  z
    .object({
      kind: z.literal('issueDraft'),
      revision: commitDraftRevisionSchema,
      draft: issueDraftSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('issueDraftList'),
      entries: z.array(issueDraftScopeSchema),
      unreadable: z.boolean(),
    })
    .strict(),
] as const;
