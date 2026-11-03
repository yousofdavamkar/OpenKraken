import { z } from 'zod';
import { activityActions } from './activity.js';

export const diagnosticActions = {
  ...activityActions,
  refresh: 'Refresh repository',
  page: 'Load history page',
  search: 'Search history',
  other: 'Other request',
} as const;
export type DiagnosticAction = keyof typeof diagnosticActions;
export const diagnosticCodes = [
  'GIT_FAILED',
  'GIT_NOT_FOUND',
  'NOT_REPOSITORY',
  'CANCELLED',
  'TIMEOUT',
  'OUTPUT_LIMIT',
  'SERVICE_EXIT',
  'SERVICE_TIMEOUT',
  'TLS_CERTIFICATE_INVALID',
  'AUTHENTICATION_FAILED',
  'SSH_HOST_KEY_CHANGED',
  'SSH_HOST_KEY_UNTRUSTED',
  'REMOTE_UNREACHABLE',
  'PUSH_REJECTED',
  'PUSH_LEASE_REJECTED',
  'BUSY',
  'DUPLICATE_REQUEST',
  'REQUEST_FAILED',
  'OTHER',
] as const;
export const diagnosticReasons = [
  'killed',
  'crashed',
  'oom',
  'abnormal-exit',
  'launch-failed',
  'integrity-failure',
  'unhandled-exception',
  'unhandled-rejection',
  'unknown',
] as const;
const identity = { id: z.uuid(), time: z.number().int().nonnegative() };
export const diagnosticEntrySchema = z.discriminatedUnion('type', [
  z
    .object({
      ...identity,
      type: z.enum(['started', 'stopped']),
      version: z
        .string()
        .max(64)
        .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
      platform: z.enum(['linux', 'darwin', 'win32']),
      arch: z.enum(['x64', 'arm64']),
    })
    .strict(),
  z
    .object({
      ...identity,
      type: z.literal('request'),
      action: z.enum(Object.keys(diagnosticActions) as [DiagnosticAction, ...DiagnosticAction[]]),
      outcome: z.enum(['succeeded', 'failed', 'cancelled', 'unknown']),
      code: z.enum(diagnosticCodes).nullable(),
      durationMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...identity,
      type: z.literal('process'),
      component: z.enum(['main', 'renderer', 'git', 'terminal', 'gpu']),
      reason: z.enum(diagnosticReasons),
    })
    .strict(),
  z
    .object({ ...identity, type: z.literal('dropped'), count: z.number().int().positive() })
    .strict(),
]);
export type DiagnosticEntry = z.infer<typeof diagnosticEntrySchema>;
export const diagnosticsStateSchema = z
  .object({
    entries: z.array(diagnosticEntrySchema).max(768),
    warning: z.enum(['unavailable', 'changed']).nullable(),
    dropped: z.number().int().nonnegative(),
  })
  .strict();
export type DiagnosticsState = z.infer<typeof diagnosticsStateSchema>;
export const diagnosticsRequests = [
  z.object({ id: z.uuid(), method: z.literal('diagnosticsRead') }).strict(),
  z.object({ id: z.uuid(), method: z.literal('diagnosticsClear') }).strict(),
] as const;
