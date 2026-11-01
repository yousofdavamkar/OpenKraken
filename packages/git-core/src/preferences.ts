import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { graphViewSchema, type GraphView } from '@openkraken/ipc-contract';

/** Profile-owned preferences; no files or configuration are written into repositories. */
export class RepositoryPreferences {
  constructor(private directory?: string) {}
  private path(id: string) {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid repository preference key');
    return this.directory ? join(this.directory, 'repos', `${id}.json`) : undefined;
  }
  async load(id: string): Promise<GraphView> {
    const path = this.path(id);
    if (path)
      try {
        const parsed = graphViewSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
        if (parsed.success) return parsed.data;
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error;
      }
    return { hiddenRefs: [] };
  }
  async save(id: string, view: GraphView) {
    const path = this.path(id);
    if (!path) return;
    const value = graphViewSchema.parse(view);
    await mkdir(join(this.directory!, 'repos'), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
