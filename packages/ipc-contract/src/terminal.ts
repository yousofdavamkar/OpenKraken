import { z } from 'zod';
const id = z.string().uuid();
export const terminalSizeSchema = z.object({
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(500),
});
const session = z.object({ id, sessionId: id });
export const terminalRequests = [
  session
    .extend({
      method: z.literal('terminalOpen'),
      repoId: z.string().regex(/^[0-9a-f]{64}$/),
      ...terminalSizeSchema.shape,
    })
    .strict(),
  session
    .extend({ method: z.literal('terminalInput'), data: z.string().min(1).max(8192) })
    .strict(),
  session.extend({ method: z.literal('terminalResize'), ...terminalSizeSchema.shape }).strict(),
  session
    .extend({
      method: z.literal('terminalAck'),
      sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  session.extend({ method: z.literal('terminalClose') }).strict(),
] as const;
export const terminalRequestSchema = z.discriminatedUnion('method', terminalRequests);
export type TerminalRequest = z.infer<typeof terminalRequestSchema>;
export const terminalEvents = [
  z
    .object({
      type: z.literal('terminalData'),
      id,
      sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      data: z.string().min(1).max(16384),
    })
    .strict(),
  z
    .object({
      type: z.literal('terminalExit'),
      id,
      exitCode: z.number().int().nullable(),
      signal: z.number().int().nullable(),
    })
    .strict(),
] as const;
export const terminalEventSchema = z.discriminatedUnion('type', terminalEvents);
export type TerminalEvent = z.infer<typeof terminalEventSchema>;
// Only main supplies the working directory. Renderer requests cannot choose shell, arguments or environment.
export const terminalStartSchema = z
  .object({
    type: z.literal('start'),
    sessionId: id,
    cwd: z.string().min(1).max(32768),
    ...terminalSizeSchema.shape,
  })
  .strict();
export const terminalReadySchema = z
  .object({ type: z.literal('ready'), id, shell: z.string().min(1).max(1024) })
  .strict();
