import { z } from 'zod';

export const updateFormatSchema = z.enum(['AppImage', 'deb', 'rpm', 'dmg', 'zip', 'msi']);
export const updatesStateSchema = z.strictObject({
  channel: z.enum(['stable', 'beta']).optional(),
  phase: z.enum([
    'disabled',
    'idle',
    'checking',
    'current',
    'unsupported',
    'available',
    'downloading',
    'verifying',
    'verified',
    'saving',
    'saved',
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
  saveId: z.uuid().optional(),
  installId: z.uuid().nullable().default(null),
  recovery: z.literal('restored').nullable().default(null),
  automatic: z
    .strictObject({
      enabled: z.boolean(),
      revision: z.uuid().nullable(),
      nextCheckAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
      warning: z.enum(['storage']).nullable(),
      host: z.string().max(2048).nullable(),
    })
    .default({ enabled: false, revision: null, nextCheckAt: null, warning: null, host: null }),
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
      'unchanged-image',
      'save',
      'save-unconfirmed',
      'download-unconfirmed',
    ])
    .nullable(),
});
export type UpdateState = z.infer<typeof updatesStateSchema>;
export const updatesRequests = [
  z.strictObject({ id: z.uuid(), method: z.literal('updatesDismissRecovery') }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('updatesAutomatic'),
    enabled: z.boolean(),
    revision: z.uuid().nullable(),
  }),
  z.strictObject({ id: z.uuid(), method: z.literal('updatesStarted') }),
  z.strictObject({ id: z.uuid(), method: z.literal('updatesSave'), saveId: z.uuid() }),
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
