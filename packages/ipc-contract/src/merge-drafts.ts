import { z } from 'zod';
import { commitDraftRevisionSchema } from './commit-drafts.js';
import { providerMergeMethodSchema, providerPullOptionsSchema } from './providers.js';

const account = z.object({ accountId: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const mergeDraftScopeSchema = providerPullOptionsSchema.extend(account.shape);
const message = z.string().max(65536);
export const mergeDraftSchema = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('github'),
      method: providerMergeMethodSchema,
      defaults: z.boolean(),
      title: z.string().max(256),
      message,
      uncertain: z.boolean(),
    })
    .strict(),
  z
    .object({
      provider: z.literal('gitlab'),
      selectedSquash: z.boolean().nullable(),
      removeSource: z.boolean(),
      defaults: z.boolean(),
      mergeMessage: message,
      squashMessage: message,
      uncertain: z.boolean(),
    })
    .strict(),
]);
export type MergeDraftScope = z.infer<typeof mergeDraftScopeSchema>;
export type MergeDraft = z.infer<typeof mergeDraftSchema>;
const base = z.object({ id: z.string().uuid(), scope: mergeDraftScopeSchema }).strict();
export const mergeDraftRequests = [
  base.extend({ method: z.literal('mergeDraftList'), scope: account }),
  base.extend({ method: z.literal('mergeDraftRead') }),
  base.extend({
    method: z.literal('mergeDraftSave'),
    revision: commitDraftRevisionSchema,
    draft: mergeDraftSchema.nullable(),
  }),
] as const;
export const mergeDraftResults = [
  z
    .object({
      kind: z.literal('mergeDraft'),
      revision: commitDraftRevisionSchema,
      draft: mergeDraftSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mergeDraftList'),
      entries: z.array(mergeDraftScopeSchema),
      unreadable: z.boolean(),
    })
    .strict(),
] as const;
