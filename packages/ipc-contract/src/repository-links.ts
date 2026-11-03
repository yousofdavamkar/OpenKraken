import { z } from 'zod';

export const repositoryLinkSchema = z
  .object({ id: z.uuid(), path: z.string().min(1).max(16384) })
  .strict();
export type RepositoryLink = z.infer<typeof repositoryLinkSchema>;
export const repositoryLinkRequests = [
  z.object({ id: z.uuid(), method: z.literal('repositoryLink') }).strict(),
  z.object({ id: z.uuid(), method: z.literal('repositoryLinkOpen'), linkId: z.uuid() }).strict(),
  z.object({ id: z.uuid(), method: z.literal('repositoryLinkDismiss'), linkId: z.uuid() }).strict(),
] as const;
