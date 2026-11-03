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
export const lfsLocksSchema = z
  .object({
    remote: z.string().min(1).max(1024),
    endpoint: z.string().url().max(32768),
    checkedAt: z.string().datetime(),
    locks: lfsStateSchema.shape.locks,
  })
  .strict();
export type LfsLocks = z.infer<typeof lfsLocksSchema>;
export const lfsRequests = [
  z
    .object({
      id: z.string().uuid(),
      method: z.literal('lfsState'),
      repoId: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
] as const;

export const lfsPullPreviewSchema = z
  .object({
    token: z.string().uuid(),
    remote: z.string().min(1).max(1024),
    endpoint: z.string().url().max(32768),
    files: lfsStateSchema.shape.files,
    filters: z.array(z.string().max(32768)).max(2),
  })
  .strict();
export type LfsPullPreview = z.infer<typeof lfsPullPreviewSchema>;
export const lfsTransferRequests = [
  z
    .object({
      id: z.string().uuid(),
      method: z.literal('lfsLocks'),
      repoId: z.string().regex(/^[0-9a-f]{64}$/),
      remote: z
        .string()
        .min(1)
        .max(1024)
        .refine(
          (value) =>
            !value.startsWith('-') &&
            !Array.from(value).some(
              (character) =>
                /\s/.test(character) ||
                character.charCodeAt(0) < 32 ||
                character.charCodeAt(0) === 127,
            ),
        ),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      method: z.literal('lfsPullPreview'),
      repoId: z.string().regex(/^[0-9a-f]{64}$/),
      remote: z
        .string()
        .min(1)
        .max(1024)
        .refine(
          (value) =>
            !value.startsWith('-') &&
            !Array.from(value).some(
              (character) =>
                /\s/.test(character) ||
                character.charCodeAt(0) < 32 ||
                character.charCodeAt(0) === 127,
            ),
        ),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      method: z.literal('lfsPull'),
      repoId: z.string().regex(/^[0-9a-f]{64}$/),
      token: z.string().uuid(),
    })
    .strict(),
] as const;
