import { z } from 'zod';

export const commitDraftSchema = z
  .object({
    message: z.string().max(65536),
    amendMessage: z.string().max(65536),
    amend: z.boolean(),
    amendHead: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
      .nullable(),
    sign: z.enum(['default', 'on', 'off']),
  })
  .strict();
export const commitDraftRevisionSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .nullable();
export const commitDraftStateSchema = z
  .object({
    revision: commitDraftRevisionSchema,
    draft: commitDraftSchema.nullable(),
  })
  .strict();
export type CommitDraft = z.infer<typeof commitDraftSchema>;
export type CommitDraftState = z.infer<typeof commitDraftStateSchema>;
export const commitDraftRequests = [
  z
    .object({
      id: z.string().uuid(),
      method: z.literal('commitDraftRead'),
      repoId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      method: z.literal('commitDraftSave'),
      repoId: z.string().min(1).max(128),
      revision: commitDraftRevisionSchema,
      draft: commitDraftSchema,
    })
    .strict(),
] as const;
