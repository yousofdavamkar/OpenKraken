import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export class LocalDraftFiles<T> {
  private schema;
  private directory: string;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    profile: string,
    folder: string,
    draft: z.ZodType<T>,
    private maxBytes: number,
  ) {
    this.directory = join(profile, folder);
    this.schema = z.object({ version: z.literal(1), draft }).strict();
  }
  private async file(identity: readonly string[]) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory())
      throw new Error('Unsupported draft directory');
    return join(this.directory, `${digest(JSON.stringify(identity))}.json`);
  }
  private async source(file: string): Promise<string | null> {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > this.maxBytes) throw new Error('Unsupported draft file');
      const raw = await readFile(file, 'utf8');
      if (Buffer.byteLength(raw) > this.maxBytes) throw new Error('Unsupported draft size');
      return raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private state(raw: string | null): { revision: string | null; draft: T | null } {
    return raw === null
      ? { revision: null, draft: null }
      : { revision: digest(raw), draft: this.schema.parse(JSON.parse(raw)).draft };
  }
  async read(identity: readonly string[]) {
    await this.idle();
    return this.state(await this.source(await this.file(identity)));
  }
  save(identity: readonly string[], revision: string | null, draft: T | null) {
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        const file = await this.file(identity);
        const source = await this.source(file);
        if (this.state(source).revision !== revision) throw new Error('Draft changed');
        if (draft === null) {
          if ((await this.source(file)) !== source) throw new Error('Draft changed externally');
          if (source !== null) await rm(file);
          return this.state(null);
        }
        const raw = JSON.stringify(this.schema.parse({ version: 1, draft }));
        if (Buffer.byteLength(raw) > this.maxBytes) throw new Error('Draft too large');
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          const handle = await open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(raw);
            await handle.sync();
          } finally {
            await handle.close();
          }
          if ((await this.source(file)) !== source) throw new Error('Draft changed externally');
          await rename(temporary, file);
        } finally {
          await rm(temporary, { force: true });
        }
        return this.state(raw);
      });
    this.writes = next;
    return next;
  }
  idle() {
    return this.writes.catch(() => {});
  }
}
