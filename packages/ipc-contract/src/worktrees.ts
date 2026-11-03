import { z } from 'zod';

const identity = z.string().regex(/^[0-9a-f]{64}$/);
export const worktreeStateSchema = z
  .object({
    revision: identity,
    entries: z
      .array(
        z
          .object({
            id: identity,
            path: z.string().max(32768),
            main: z.boolean(),
            current: z.boolean(),
            bare: z.boolean(),
            detached: z.boolean(),
            head: z
              .string()
              .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
              .optional(),
            branch: z.string().max(4096).optional(),
            locked: z.boolean(),
            lockReason: z.string().max(32768).optional(),
            prunable: z.boolean(),
            pruneReason: z.string().max(32768).optional(),
            available: z.boolean(),
            changedFiles: z.number().int().nonnegative().nullable(),
            problem: z.string().optional(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
export type WorktreeState = z.infer<typeof worktreeStateSchema>;
export type Worktree = WorktreeState['entries'][number];

const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const branch = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith('-') && !value.includes('\0'));
export const worktreeAddSchema = z.discriminatedUnion('mode', [
  z.object({ revision: identity, mode: z.literal('new'), branch, oid }).strict(),
  z.object({ revision: identity, mode: z.literal('existing'), branch, oid }).strict(),
  z.object({ revision: identity, mode: z.literal('detached'), oid }).strict(),
]);
export type WorktreeAdd = z.infer<typeof worktreeAddSchema>;
const selection = { worktreeId: identity, revision: identity };
export const worktreeActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...selection,
      action: z.literal('lock'),
      reason: z
        .string()
        .max(1024)
        .refine((value) => !value.includes('\0')),
    })
    .strict(),
  z.object({ ...selection, action: z.literal('unlock') }).strict(),
  z.object({ ...selection, action: z.literal('remove') }).strict(),
]);
export type WorktreeAction = z.infer<typeof worktreeActionSchema>;
export const worktreeAddRequest = z
  .object({
    id: z.string().uuid(),
    method: z.literal('addWorktree'),
    repoId: identity,
    options: worktreeAddSchema,
  })
  .strict();

export const worktreeRequests = [
  z
    .object({
      id: z.string().uuid(),
      method: z.literal('worktreeAction'),
      repoId: identity,
      options: worktreeActionSchema,
    })
    .strict(),
  z.object({ id: z.string().uuid(), method: z.literal('worktrees'), repoId: identity }).strict(),
  z
    .object({
      id: z.string().uuid(),
      method: z.literal('openWorktree'),
      repoId: identity,
      worktreeId: identity,
      revision: identity,
    })
    .strict(),
] as const;
