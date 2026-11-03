import { z } from 'zod';
export const crashReportingStateSchema = z
  .object({
    enabled: z.boolean(),
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    destination: z.string().url().max(2048).nullable(),
    warning: z.enum(['unreadable', 'changed']).nullable(),
    delivery: z.enum(['idle', 'sending', 'sent', 'failed']),
  })
  .strict();
export type CrashReportingState = z.infer<typeof crashReportingStateSchema>;
