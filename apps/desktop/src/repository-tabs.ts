import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  maxRepositoryTabs,
  type RepositoryTab,
  type RepositoryTabsState,
} from '@openkraken/ipc-contract';

const diskSchema = z.strictObject({
  version: z.literal(1),
  tabs: z
    .array(
      z
        .string()
        .min(1)
        .max(4096)
        .refine((path) => isAbsolute(path) && !path.includes('\0')),
    )
    .max(maxRepositoryTabs),
  active: z.number().int().min(0).max(maxRepositoryTabs).nullable(),
});
const maxBytes = 96 * 1024;
/** Repository ids are derived from the canonical path, matching the Git service. */
export const repositoryIdOf = (path: string) => createHash('sha256').update(path).digest('hex');
const nameOf = (path: string) =>
  (path.split(/[\\/]/).filter(Boolean).at(-1) ?? path).slice(0, 255) || path.slice(0, 255);

/**
 * Main-owned list of repository tabs, persisted atomically in the profile so a restart
 * restores them. The renderer never supplies paths: tabs are recorded only from
 * repositories the Git service opened and are addressed by repository id afterwards.
 */
export class RepositoryTabStore {
  private file: string;
  private source: string | null = null;
  private paths: string[] = [];
  private active: number | null = null;
  private warning: RepositoryTabsState['warning'] = null;
  private ready: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {
    this.file = join(directory, 'repository-tabs.json');
    this.ready = this.load();
  }
  private async readSource() {
    try {
      const info = await stat(this.file);
      if (!info.isFile() || info.size > maxBytes) throw new Error('Unsupported tab file.');
      return await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private async load() {
    try {
      this.source = await this.readSource();
      if (this.source === null) return;
      try {
        const disk = diskSchema.parse(JSON.parse(this.source));
        this.paths = [...new Set(disk.tabs)];
        this.active =
          disk.active !== null && disk.active < this.paths.length
            ? this.paths.indexOf(disk.tabs[disk.active]!)
            : null;
      } catch {
        this.warning = 'corrupt';
      }
    } catch {
      this.warning = 'unreadable';
    }
  }
  private snapshot(): RepositoryTabsState {
    const tabs: RepositoryTab[] = this.paths.map((path) => ({
      repoId: repositoryIdOf(path),
      name: nameOf(path),
      path,
    }));
    return {
      tabs,
      active: this.active === null ? null : tabs[this.active]!.repoId,
      warning: this.warning,
    };
  }
  private enqueue<T>(work: () => Promise<T>) {
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        await this.ready;
        return work();
      });
    this.writes = next;
    return next;
  }
  async read() {
    await this.ready;
    await this.writes.catch(() => {});
    return this.snapshot();
  }
  /** Returns the saved path for a tab, for reopening it after a restart. */
  async pathOf(repoId: string) {
    await this.ready;
    return this.paths.find((path) => repositoryIdOf(path) === repoId);
  }
  /** Records a repository the Git service opened and makes it the active tab. */
  opened(path: string) {
    return this.enqueue(async () => {
      let index = this.paths.indexOf(path);
      if (index >= 0 && index === this.active) return this.snapshot();
      const paths = [...this.paths];
      if (index < 0) {
        // Keep the newest tabs; the oldest inactive tab gives way.
        if (paths.length >= maxRepositoryTabs)
          paths.splice(
            Math.max(
              0,
              paths.findIndex((_, i) => i !== this.active),
            ),
            1,
          );
        paths.push(path);
        index = paths.length - 1;
      }
      return this.persist(paths, index);
    });
  }
  /** Removes a tab. Closing the active tab activates its right neighbour, or the new last tab. */
  close(repoId: string) {
    return this.enqueue(async () => {
      const index = this.paths.findIndex((path) => repositoryIdOf(path) === repoId);
      if (index < 0) return this.snapshot();
      const paths = this.paths.filter((_, i) => i !== index);
      const active =
        this.active === null || paths.length === 0
          ? null
          : this.active === index
            ? Math.min(index, paths.length - 1)
            : this.active > index
              ? this.active - 1
              : this.active;
      return this.persist(paths, active);
    });
  }
  idle() {
    return this.writes.catch(() => {});
  }
  private async persist(paths: string[], active: number | null) {
    // A save failure keeps the in-memory tabs for this session and reports the warning.
    const commit = () => {
      this.paths = paths;
      this.active = active;
    };
    try {
      if (this.warning === 'unreadable') throw new Error('Saved tabs could not be read.');
      if ((await this.readSource()) !== this.source) throw new Error('Saved tabs changed on disk.');
      const raw = JSON.stringify(diskSchema.parse({ version: 1, tabs: paths, active }), null, 2);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (this.warning === 'corrupt' && this.source !== null)
        await writeFile(
          join(this.directory, `repository-tabs.corrupt-${randomUUID()}.json`),
          this.source,
          { flag: 'wx', mode: 0o600 },
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
        await rename(temporary, this.file);
        this.source = raw;
        this.warning = null;
      } finally {
        await rm(temporary, { force: true });
      }
    } catch {
      if (this.warning !== 'unreadable') this.warning = 'unsaved';
    }
    commit();
    return this.snapshot();
  }
}
