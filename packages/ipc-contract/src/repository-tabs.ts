import { z } from 'zod';

/** At most this many repository tabs are kept and restored across restarts. */
export const maxRepositoryTabs = 16;
const repoId = z.string().regex(/^[0-9a-f]{64}$/);
export const repositoryTabSchema = z.strictObject({
  repoId,
  name: z.string().min(1).max(255),
  path: z.string().min(1).max(4096),
});
export type RepositoryTab = z.infer<typeof repositoryTabSchema>;
export const repositoryTabsStateSchema = z.strictObject({
  tabs: z.array(repositoryTabSchema).max(maxRepositoryTabs),
  active: repoId.nullable(),
  /** Set when saved tabs could not be read or the latest change could not be saved. */
  warning: z.enum(['unreadable', 'corrupt', 'unsaved']).nullable(),
});
export type RepositoryTabsState = z.infer<typeof repositoryTabsStateSchema>;
export const repositoryTabRequests = [
  z.strictObject({ id: z.string().uuid(), method: z.literal('repositoryTabsRead') }),
  z.strictObject({ id: z.string().uuid(), method: z.literal('repositoryTabClose'), repoId }),
] as const;
