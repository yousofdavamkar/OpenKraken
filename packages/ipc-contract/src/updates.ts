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
  error: z
    .enum([
      'network',
      'invalid-release',
      'rollback',
      'storage',
      'integrity',
      'cancelled',
      'timeout',
    ])
    .nullable(),
});
export type UpdateState = z.infer<typeof updatesStateSchema>;
export const updatesRequests = [
  z.strictObject({ id: z.uuid(), method: z.literal('updatesRead') }),
  z.strictObject({ id: z.uuid(), method: z.literal('updatesCheck') }),
  z.strictObject({ id: z.uuid(), method: z.literal('updatesCancel') }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('updatesDownload'),
    format: updateFormatSchema,
  }),
] as const;
