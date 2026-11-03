import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  commitDraftSchema,
  type CommitDraft,
  type CommitDraftState,
  type Repository,
} from '@openkraken/ipc-contract';

const diskSchema = z.object({ version: z.literal(1), draft: commitDraftSchema }).strict();
const maxBytes = 1024 * 1024;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export class CommitDrafts {
  private directory: string;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(profile: string) {
    this.directory = join(profile, 'commit-drafts');
  }
  private async file(repository: Repository) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory())
      throw new Error('Unsupported draft directory');
    return join(
      this.directory,
      `${digest(JSON.stringify([repository.path, repository.gitDir]))}.json`,
    );
  }
  private async source(file: string): Promise<string | null> {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > maxBytes) throw new Error('Unsupported draft file');
      const raw = await readFile(file, 'utf8');
      if (Buffer.byteLength(raw) > maxBytes) throw new Error('Unsupported draft size');
      return raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private state(raw: string | null): CommitDraftState {
    return raw === null
      ? { revision: null, draft: null }
      : { revision: digest(raw), draft: diskSchema.parse(JSON.parse(raw)).draft };
  }
  async read(repository: Repository) {
    await this.idle();
    return this.state(await this.source(await this.file(repository)));
  }
  save(repository: Repository, revision: string | null, draft: CommitDraft) {
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        const file = await this.file(repository);
        const source = await this.source(file);
        if (this.state(source).revision !== revision) throw new Error('Draft changed');
        const raw = JSON.stringify(diskSchema.parse({ version: 1, draft }));
        if (Buffer.byteLength(raw) > maxBytes) throw new Error('Draft too large');
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
