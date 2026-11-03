import { z } from 'zod';

const path = z
  .string()
  .max(32768)
  .refine((value) => !value.includes('\0'));
export const lfsStateSchema = z
  .object({
    available: z.boolean(),
    version: z.string().max(1024).optional(),
    files: z
      .array(
        z
          .object({
            path,
            oid: z.string().regex(/^[0-9a-f]{64}$/),
            size: z.number().int().nonnegative(),
            checkout: z.boolean(),
            downloaded: z.boolean(),
          })
          .strict(),
      )
      .max(10000),
    locks: z
      .array(
        z
          .object({
            id: z.string().max(4096),
            path,
            owner: z.string().max(4096).optional(),
            lockedAt: z.string().max(128).optional(),
          })
          .strict(),
      )
      .max(10000),
    lockError: z.string().max(4096).optional(),
  })
  .strict();
export type LfsState = z.infer<typeof lfsStateSchema>;
export const lfsRequests = [
  z
    .object({
      id: z.string().uuid(),
      method: z.literal('lfsState'),
      repoId: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
] as const;
