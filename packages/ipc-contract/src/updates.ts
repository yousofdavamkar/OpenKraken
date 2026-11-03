import { z } from 'zod';

export const updateFormatSchema = z.enum(['AppImage', 'deb', 'rpm', 'dmg', 'zip', 'msi']);
export const updatesStateSchema = z.strictObject({
  phase: z.enum([
    'disabled',
    'idle',
    'checking',
    'current',
    'unsupported',
    'available',
    'downloading',
    'verified',
    'preparing',
    'restart-ready',
    'installed',
    'error',
  ]),
  version: z.string().max(100).nullable(),
  artifacts: z
    .array(
      z.strictObject({
        format: updateFormatSchema,
        size: z
          .number()
          .int()
          .min(1)
          .max(2 * 1024 ** 3),
      }),
    )
    .max(16),
  selected: updateFormatSchema.nullable(),
  downloaded: z
    .number()
    .int()
    .min(0)
    .max(2 * 1024 ** 3),
  installId: z.uuid().nullable().default(null),
  error: z
    .enum([
      'network',
      'invalid-release',
      'rollback',
      'storage',
      'integrity',
      'cancelled',
      'timeout',
      'installation',
    ])
    .nullable(),
});
export type UpdateState = z.infer<typeof updatesStateSchema>;
export const updatesRequests = [
  z.strictObject({ id: z.uuid(), method: z.literal('updatesStarted') }),
  z.strictObject({ id: z.uuid(), method: z.literal('updatesInstall'), installId: z.uuid() }),
  z.strictObject({ id: z.uuid(), method: z.literal('updatesRead') }),
  z.strictObject({ id: z.uuid(), method: z.literal('updatesCheck') }),
  z.strictObject({ id: z.uuid(), method: z.literal('updatesCancel') }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('updatesDownload'),
    format: updateFormatSchema,
  }),
] as const;
