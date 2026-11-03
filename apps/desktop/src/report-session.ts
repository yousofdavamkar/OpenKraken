import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const reportingRuntimeSchema = z
  .object({
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)
      .max(64),
    platform: z.enum(['linux', 'darwin', 'win32']),
    arch: z.enum(['x64', 'arm64']),
  })
  .strict();
export type ReportingRuntime = z.infer<typeof reportingRuntimeSchema>;
const markerSchema = z
  .object({
    version: z.literal(1),
    session: z.string().uuid(),
    consent: z.string().regex(/^[a-f0-9]{64}$/),
    runtime: reportingRuntimeSchema,
  })
  .strict();

export class ReportSession {
  private file: string;
  private owned: string | undefined;
  constructor(private directory: string) {
    this.file = join(directory, 'reporting-session.json');
  }
  private async read() {
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.size > 4096) throw new Error('Unsupported report session marker');
      const raw = await readFile(this.file, 'utf8');
      if (Buffer.byteLength(raw) > 4096) throw new Error('Unsupported report session size');
      return raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async begin(consent: string, runtime: ReportingRuntime): Promise<ReportingRuntime | null> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory())
      throw new Error('Unsupported profile directory');
    const source = await this.read();
    if (this.owned !== undefined && source !== this.owned)
      throw new Error('Report session changed');
    const previous = source === null ? null : markerSchema.parse(JSON.parse(source));
    const raw = JSON.stringify(
      markerSchema.parse({ version: 1, session: randomUUID(), consent, runtime }),
    );
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(raw);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if ((await this.read()) !== source) throw new Error('Report session changed');
      await rename(temporary, this.file);
      this.owned = raw;
    } finally {
      await rm(temporary, { force: true });
    }
    return previous?.consent === consent ? previous.runtime : null;
  }
  async end() {
    if (this.owned === undefined) return;
    if ((await this.read()) !== this.owned) throw new Error('Report session changed');
    await rm(this.file);
    this.owned = undefined;
  }
}
