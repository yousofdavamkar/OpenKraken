import { z } from 'zod';

const identity = z.string().regex(/^[0-9a-f]{64}$/);
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const submoduleStateSchema = z
  .object({
    revision: identity,
    entries: z
      .array(
        z
          .object({
            id: identity,
            parentId: identity.optional(),
            path: z.string().max(32768),
            depth: z.number().int().min(0).max(15),
            name: z.string().max(4096).optional(),
            url: z.string().max(32768).optional(),
            indexOid: oid.optional(),
            head: oid.optional(),
            initialized: z.boolean(),
            available: z.boolean(),
            outOfDate: z.boolean(),
            changedFiles: z.number().int().nonnegative().nullable(),
            state: z.enum([
              'uninitialized',
              'clean',
              'modified',
              'out-of-date',
              'conflict',
              'unavailable',
            ]),
            problem: z.string().optional(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
export type SubmoduleState = z.infer<typeof submoduleStateSchema>;
export type Submodule = SubmoduleState['entries'][number];
export const submoduleUpdatePreviewSchema = z
  .object({
    token: z.string().uuid(),
    entries: submoduleStateSchema.shape.entries,
    sources: z
      .array(
        z
          .object({
            repository: z.string().max(32768),
            setting: z.string().max(32768),
            value: z.string().max(32768),
          })
          .strict(),
      )
      .max(2048),
  })
  .strict();
export type SubmoduleUpdatePreview = z.infer<typeof submoduleUpdatePreviewSchema>;
export const submoduleRequests = [
  z
    .object({
      id: z.string().uuid(),
      method: z.literal('submoduleUpdatePreview'),
      repoId: identity,
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      method: z.literal('updateSubmodules'),
      repoId: identity,
      token: z.string().uuid(),
      allowLocal: z.boolean(),
    })
    .strict(),
  z.object({ id: z.string().uuid(), method: z.literal('submodules'), repoId: identity }).strict(),
  z
    .object({
      id: z.string().uuid(),
      method: z.literal('openSubmodule'),
      repoId: identity,
      submoduleId: identity,
      revision: identity,
    })
    .strict(),
] as const;
