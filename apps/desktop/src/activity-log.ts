import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  activityActions,
  activityEntrySchema,
  type ActivityAction,
  type ActivityEntry,
  type ActivityState,
  type Request,
  type Result,
} from '@openkraken/ipc-contract';
const diskSchema = z
  .object({ version: z.literal(1), entries: z.array(activityEntrySchema).max(500) })
  .strict();
const maxBytes = 256 * 1024;

export class ActivityLog {
  private file: string;
  private entries: ActivityEntry[] = [];
  private warning: ActivityState['warning'] = null;
  private source: string | null = null;
  private unavailable = false;
  private writes: Promise<void> = Promise.resolve();
  private ready: Promise<void>;
  constructor(
    private directory: string,
    private changed: () => void,
  ) {
    this.file = join(directory, 'activity.json');
    this.ready = this.load();
  }
  private async readSource() {
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.size > maxBytes) throw new Error('Unsupported activity file');
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
      this.entries = diskSchema.parse(JSON.parse(this.source)).entries;
      if (new Set(this.entries.map((entry) => entry.id)).size !== this.entries.length)
        throw new Error('Duplicate activity identities');
      let interrupted = false;
      this.entries = this.entries.map((entry) => {
        if (entry.outcome !== 'running') return entry;
        interrupted = true;
        return { ...entry, outcome: 'unknown', finishedAt: Date.now() };
      });
      if (interrupted) await this.persist(this.entries);
    } catch {
      this.entries = [];
      this.unavailable = true;
      this.warning = 'unavailable';
    }
  }
  private async persist(entries: ActivityEntry[]) {
    if (this.unavailable || (await this.readSource()) !== this.source)
      throw new Error('Activity file is unavailable or changed externally');
    const raw = JSON.stringify(diskSchema.parse({ version: 1, entries }));
    if (Buffer.byteLength(raw) > maxBytes) throw new Error('Activity file too large');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
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
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private save() {
    this.writes = this.writes.then(async () => {
      try {
        await this.persist(structuredClone(this.entries));
        this.warning = null;
      } catch {
        this.warning = this.unavailable ? 'unavailable' : 'unsaved';
      }
      this.changed();
    });
    this.changed();
  }
  async read(): Promise<ActivityState> {
    await this.ready;
    await this.writes;
    return structuredClone({ entries: this.entries, warning: this.warning });
  }
  async clear(): Promise<ActivityState> {
    await this.ready;
    // Serialize clearing with persistence without losing operations that start while it runs.
    const ids = new Set(
      this.entries.filter((entry) => entry.outcome !== 'running').map((entry) => entry.id),
    );
    let failed = false;
    this.writes = this.writes.then(async () => {
      const retained = this.entries.filter((entry) => !ids.has(entry.id));
      try {
        await this.persist(retained);
        this.entries = this.entries.filter((entry) => !ids.has(entry.id));
        this.warning = null;
      } catch {
        failed = true;
      }
      this.changed();
    });
    await this.writes;
    if (failed) throw new Error('Activity could not be cleared. The saved history was retained.');
    return this.read();
  }
  idle() {
    return this.writes;
  }
  async track(request: Request, execute: () => Promise<Result>): Promise<Result> {
    const method = request.method === 'providerGit' ? request.operation.method : request.method;
    if (!(method in activityActions) || (request.method === 'fetch' && request.background))
      return execute();
    // Main initializes this before exposing the window, so no operation waits for log I/O to start.
    const entry: ActivityEntry = {
      id: randomUUID(),
      action: method as ActivityAction,
      startedAt: Date.now(),
      finishedAt: null,
      outcome: 'running',
    };
    this.entries.unshift(entry);
    if (this.entries.length > 500) {
      const at = this.entries.findLastIndex((item) => item.outcome !== 'running');
      this.entries.splice(at < 0 ? this.entries.length - 1 : at, 1);
    }
    this.save();
    try {
      const result = await execute();
      entry.outcome =
        result.kind === 'cancelled'
          ? 'cancelled'
          : result.kind === 'error'
            ? /(?:SERVICE_EXIT|SERVICE_TIMEOUT|UNCERTAIN|UNKNOWN|TIMEOUT)/.test(result.code)
              ? 'unknown'
              : 'failed'
            : 'succeeded';
      if (
        (result.kind === 'workingState' || result.kind === 'stashAction') &&
        ((result.state.operation && result.state.operation.kind !== 'none') ||
          result.state.commitWarning)
      )
        entry.outcome = 'attention';
      if ((result.kind === 'pushed' || result.kind === 'stashAction') && result.warning)
        entry.outcome = 'attention';
      return result;
    } catch (error) {
      entry.outcome = 'unknown';
      throw error;
    } finally {
      entry.finishedAt = Date.now();
      this.save();
      await this.writes;
    }
  }
}
