import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { z } from 'zod';
import { commitSchema, type Commit } from '@openkraken/ipc-contract';
import type { HistorySeed } from './history.js';
const tailNames = ['tail-0.json', 'tail-1.json', 'tail-2.json'];
const cacheNames = ['prefix.json', ...tailNames];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const pageSchema = z.object({
  key: z.string(),
  offset: z.number().int().nonnegative(),
  commits: z.array(commitSchema).max(17000),
  hasMore: z.boolean(),
  digest: z.string(),
});
/** One bounded immutable-history window per repository, entirely under the app profile. */
export class HistoryCache {
  private records: Commit[] = [];
  private firstCount = 0;
  private hasMore = true;
  private ready = Promise.resolve();
  private writes = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private disabled = false;
  private directory: string;
  constructor(
    private root: string,
    private repoId: string,
    private key: string,
  ) {
    if (!/^[0-9a-f]{64}$/.test(repoId)) throw new Error('Invalid cache repository');
    this.directory = join(root, 'history', repoId);
  }
  private async read(name: string, maxBytes: number) {
    try {
      const path = join(this.directory, name);
      if ((await stat(path)).size > maxBytes) return;
      const result = pageSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (
        result.success &&
        result.data.key === this.key &&
        result.data.digest ===
          digest(
            JSON.stringify({ offset: result.data.offset, hasMore: result.data.hasMore }) +
              JSON.stringify(result.data.commits),
          )
      )
        return result.data;
    } catch {
      /* A cache miss always falls back to the real Git stream. */
    }
  }
  async load(): Promise<HistorySeed | undefined> {
    const prefix = await this.read('prefix.json', 8 * 1024 * 1024);
    if (!prefix || prefix.offset !== 0 || !prefix.commits.length || prefix.commits.length > 2000)
      return;
    this.records = [...prefix.commits];
    this.firstCount = prefix.commits.length;
    this.hasMore = prefix.hasMore;
    const continuation: NonNullable<HistorySeed['continuation']> = (append) => {
      this.ready = (async () => {
        if (!prefix.hasMore) return;
        for (const name of tailNames) {
          const tail = await this.read(name, 18 * 1024 * 1024);
          if (
            !tail ||
            tail.offset !== this.records.length ||
            !tail.commits.length ||
            tail.commits.length > 5000
          )
            return;
          if (!append({ commits: tail.commits, hasMore: tail.hasMore })) return;
          this.records.push(...tail.commits);
          this.hasMore = tail.hasMore;
          if (!tail.hasMore) return;
        }
      })();
      return this.ready;
    };
    return {
      commits: prefix.commits,
      hasMore: prefix.hasMore,
      continuation,
      invalidate: () => {
        void this.invalidate();
      },
    };
  }
  record(offset: number, commits: Commit[], hasMore: boolean) {
    this.ready = this.ready.then(() => {
      if (this.disabled || offset !== this.records.length || offset >= 17000 || !commits.length)
        return;
      if (!this.firstCount) this.firstCount = commits.length;
      this.records.push(...commits.slice(0, 17000 - offset));
      this.hasMore = hasMore || offset + commits.length > 17000;
      this.dirty = true;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.flush();
      }, 5000);
      this.timer.unref();
    });
  }
  async invalidate() {
    this.disabled = true;
    clearTimeout(this.timer);
    this.writes = this.writes.then(async () => {
      await Promise.all(
        cacheNames.map((name) => rm(join(this.directory, name), { force: true }).catch(() => {})),
      );
    });
    await this.writes;
  }
  async flush() {
    clearTimeout(this.timer);
    await this.ready;
    if (!this.dirty || this.disabled) {
      await this.writes;
      return;
    }
    this.dirty = false;
    const records = this.records.slice(),
      first = this.firstCount,
      more = this.hasMore;
    this.writes = this.writes
      .then(async () => {
        if (this.disabled) return;
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        for (const [name, offset, commits, hasMore, limit] of [
          [
            'prefix.json',
            0,
            records.slice(0, first),
            records.length > first || more,
            8 * 1024 * 1024,
          ],
          ...tailNames.map((name, i) => {
            const offset = first + i * 5000;
            return [
              name,
              offset,
              records.slice(offset, offset + 5000),
              records.length > offset + 5000 || more,
              18 * 1024 * 1024,
            ] as const;
          }),
        ] as const) {
          // Serialize in bounded batches so an idle cache write cannot block paging.
          const chunks: string[] = [],
            hash = createHash('sha256').update(JSON.stringify({ offset, hasMore })).update('[');
          for (let i = 0; i < commits.length; i += 100) {
            const chunk = commits
              .slice(i, i + 100)
              .map((c) => JSON.stringify(c))
              .join(',');
            if (i) hash.update(',');
            hash.update(chunk);
            chunks.push(chunk);
            await yieldTurn();
            if (this.disabled) return;
          }
          const checksum = hash.update(']').digest('hex');
          const data = `{"key":${JSON.stringify(this.key)},"offset":${offset},"commits":[${chunks.join(',')}],"hasMore":${hasMore},"digest":"${checksum}"}`;
          if (Buffer.byteLength(data) > limit) {
            await rm(join(this.directory, name), { force: true });
            continue;
          }
          const path = join(this.directory, name),
            temp = `${path}.${randomUUID()}.tmp`;
          try {
            await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
            await rename(temp, path);
          } finally {
            await rm(temp, { force: true });
          }
        }
        await this.trim();
      })
      .catch(() => {
        /* Cache storage failures never prevent reading a repository. */
      });
    await this.writes;
  }
  private async trim() {
    const base = join(this.root, 'history');
    const entries = (await readdir(base, { withFileTypes: true })).filter(
      (e) => e.isDirectory() && /^[0-9a-f]{64}$/.test(e.name),
    );
    const sizes = await Promise.all(
      entries.map(async (e) => {
        const files = await Promise.all(
          cacheNames.map((f) => stat(join(base, e.name, f)).catch(() => undefined)),
        );
        return {
          name: e.name,
          bytes: files.reduce((n, f) => n + (f?.size ?? 0), 0),
          time: Math.max(...files.map((f) => f?.mtimeMs ?? 0)),
        };
      }),
    );
    let bytes = sizes.reduce((n, s) => n + s.bytes, 0),
      count = sizes.length;
    for (const item of sizes.sort((a, b) => a.time - b.time)) {
      if (bytes <= 128 * 1024 * 1024 && count <= 16) break;
      if (item.name === this.repoId) continue;
      await rm(join(base, item.name), { recursive: true, force: true });
      bytes -= item.bytes;
      count--;
    }
  }
}
