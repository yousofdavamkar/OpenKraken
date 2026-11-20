import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { z } from 'zod';
import { commitSchema, type Commit } from '@openkraken/ipc-contract';
import { waitForHistoryCache, type HistorySeed } from './history.js';
const tailNames = ['tail-0.json', 'tail-1.json', 'tail-2.json'];
const prefixName = 'prefix.json';
const cacheNames = [prefixName, ...tailNames];
const pageSchema = z.object({
  key: z.string(),
  offset: z.number().int().nonnegative(),
  commits: z.array(z.unknown()).max(17000),
  hasMore: z.boolean(),
  digest: z.string(),
});
function fileStamp(file: BigIntStats) {
  return [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join('/');
}
function cacheDirectory(root: string, repoId: string) {
  if (!/^[0-9a-f]{64}$/.test(repoId)) throw new Error('Invalid cache repository');
  return join(root, 'history', repoId);
}

/** One bounded immutable-history window per repository, entirely under the app profile. */
export class HistoryCache {
  private records: Commit[] = [];
  private persisted = new Map<
    string,
    { offset: number; count: number; hasMore: boolean; stamp: string }
  >();
  private firstCount = 0;
  private hasMore = true;
  private tailRead = new AbortController();
  private ready = Promise.resolve();
  private writes = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private disabled = false;
  private directory: string;
  static async hasPrefix(root: string, repoId: string) {
    return stat(join(root, 'history', repoId, prefixName)).then(
      () => true,
      () => false,
    );
  }
  constructor(
    private root: string,
    private repoId: string,
    private key: string,
  ) {
    this.directory = cacheDirectory(root, repoId);
  }
  private static async readPage(
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
    key?: string,
  ) {
    try {
      const file = await open(path, 'r');
      let stamp: string, content: string;
      try {
        if (signal?.aborted) return;
        const metadata = await file.stat({ bigint: true });
        if (metadata.size > maxBytes) return;
        stamp = fileStamp(metadata);
        content = await file.readFile({ encoding: 'utf8', signal });
      } finally {
        await file.close();
      }
      const result = pageSchema.safeParse(JSON.parse(content));
      if (!result.success || (key !== undefined && result.data.key !== key)) return;
      const page = result.data,
        commits: Commit[] = [];
      const hash = createHash('sha256')
        .update(JSON.stringify({ offset: page.offset, hasMore: page.hasMore }))
        .update('[');
      // Do not let validation of later disk pages monopolize the service while
      // the UI is requesting a prefix that has already been decoded.
      for (let i = 0; i < page.commits.length; i += 100) {
        if (signal?.aborted) return;
        const batch = z.array(commitSchema).safeParse(page.commits.slice(i, i + 100));
        if (!batch.success) return;
        if (i) hash.update(',');
        hash.update(JSON.stringify(batch.data).slice(1, -1));
        commits.push(...batch.data);
        await yieldTurn();
      }
      if (hash.update(']').digest('hex') === page.digest) return { ...page, commits, stamp, path };
    } catch {
      /* A cache miss always falls back to the real Git stream. */
    }
  }
  static prefetchPrefix(root: string, repoId: string, signal: AbortSignal) {
    return HistoryCache.readPage(
      join(cacheDirectory(root, repoId), prefixName),
      8 * 1024 * 1024,
      signal,
    );
  }
  private async currentPrefix(
    signal?: AbortSignal,
    prefetched?: ReturnType<typeof HistoryCache.prefetchPrefix>,
  ) {
    const path = join(this.directory, prefixName);
    if (prefetched) {
      const prefix = await prefetched;
      if (signal?.aborted) return;
      if (
        prefix?.path === path &&
        (await stat(path, { bigint: true }).then(fileStamp, () => undefined)) === prefix.stamp
      )
        return prefix.key === this.key ? prefix : undefined;
    }
    return HistoryCache.readPage(path, 8 * 1024 * 1024, signal, this.key);
  }
  async load(
    signal?: AbortSignal,
    prefetched?: ReturnType<typeof HistoryCache.prefetchPrefix>,
  ): Promise<HistorySeed | undefined> {
    if (signal?.aborted) return;
    const read = this.currentPrefix(signal, prefetched);
    const prefix = signal ? await waitForHistoryCache(read, signal) : await read;
    if (!prefix || prefix.offset !== 0 || !prefix.commits.length || prefix.commits.length > 2000)
      return;
    this.persisted.set(prefixName, {
      offset: 0,
      count: prefix.commits.length,
      hasMore: prefix.hasMore,
      stamp: prefix.stamp,
    });
    this.records = [...prefix.commits];
    this.firstCount = prefix.commits.length;
    this.hasMore = prefix.hasMore;
    const continuation: NonNullable<HistorySeed['continuation']> = (append) => {
      const { signal } = this.tailRead;
      const reading = (async () => {
        if (!prefix.hasMore || signal.aborted) return;
        for (const name of tailNames) {
          const tail = await HistoryCache.readPage(
            join(this.directory, name),
            18 * 1024 * 1024,
            signal,
            this.key,
          );
          if (
            signal.aborted ||
            !tail ||
            tail.offset !== this.records.length ||
            !tail.commits.length ||
            tail.commits.length > 5000
          )
            return;
          if (!append({ commits: tail.commits, hasMore: tail.hasMore })) return;
          this.persisted.set(name, {
            offset: tail.offset,
            count: tail.commits.length,
            hasMore: tail.hasMore,
            stamp: tail.stamp,
          });
          this.records.push(...tail.commits);
          this.hasMore = tail.hasMore;
          if (!tail.hasMore) return;
        }
      })();
      this.ready = waitForHistoryCache(reading, signal);
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
      // A reopened page may begin in the disk prefix and finish in the live walk.
      const start = this.records.length - offset;
      const end = Math.min(commits.length, 17000 - offset);
      if (this.disabled || offset < 0 || start < 0 || start >= end) return;
      if (!this.firstCount) this.firstCount = commits.length;
      this.records.push(...commits.slice(start, end));
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
  stopReadingTails() {
    this.tailRead.abort();
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
          [prefixName, 0, records.slice(0, first), records.length > first || more, 8 * 1024 * 1024],
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
          const path = join(this.directory, name);
          // Records only grow at the end. Reuse a matching range while its file still exists intact.
          const previous = this.persisted.get(name);
          if (
            previous &&
            previous.offset === offset &&
            previous.count === commits.length &&
            previous.hasMore === hasMore
          ) {
            const stamp = await stat(path, { bigint: true }).then(fileStamp, () => undefined);
            if (stamp === previous.stamp) continue;
          }
          this.persisted.delete(name);
          // Serialize in bounded batches so an idle cache write cannot block paging.
          const header = Buffer.from(
            `{"key":${JSON.stringify(this.key)},"offset":${offset},"commits":[`,
          );
          const chunks = [header];
          let size = header.byteLength;
          const hash = createHash('sha256').update(JSON.stringify({ offset, hasMore })).update('[');
          for (let i = 0; i < commits.length; i += 100) {
            const batch = JSON.stringify(commits.slice(i, i + 100)).slice(1, -1);
            const chunk = Buffer.from((i ? ',' : '') + batch);
            size += chunk.byteLength;
            if (size > limit) break;
            hash.update(chunk);
            chunks.push(chunk);
            await yieldTurn();
            if (this.disabled) return;
          }
          const checksum = hash.update(']').digest('hex');
          const footer = Buffer.from(`],"hasMore":${hasMore},"digest":"${checksum}"}`);
          size += footer.byteLength;
          if (size > limit) {
            await rm(path, { force: true });
            continue;
          }
          chunks.push(footer);
          const temp = `${path}.${randomUUID()}.tmp`;
          const file = await open(temp, 'wx', 0o600);
          try {
            await file.writeFile(Buffer.concat(chunks, size));
            await rename(temp, path);
            const stamp = fileStamp(await file.stat({ bigint: true }));
            this.persisted.set(name, { offset, count: commits.length, hasMore, stamp });
          } finally {
            await file.close();
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
