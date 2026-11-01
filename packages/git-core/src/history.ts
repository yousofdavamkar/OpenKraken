import { randomUUID } from 'node:crypto';
import type { Commit } from '@openkraken/ipc-contract';
import { HistoryParser, HISTORY_FORMAT } from './parsers.js';
import { GitError, runGit } from './runner.js';

/** One retained rev-list, backpressured at page boundaries. No skip/refetch or full-history buffer. */
export class HistoryCursor {
  readonly id = randomUUID();
  readonly starts: string[];
  private buffer: Commit[] = [];
  private bufferedBytes = 0;
  private size(commit: Commit) {
    return (
      256 +
      2 *
        (commit.body.length +
          commit.author.name.length +
          commit.author.email.length +
          commit.committer.name.length +
          commit.committer.email.length) +
      commit.parents.length * 128
    );
  }
  private offset = 0;
  private demand = 1;
  private done = false;
  private error?: Error;
  private reading = false;
  private changed?: () => void;
  private resume?: () => void;
  private controller = new AbortController();
  private completion: Promise<void>;
  constructor(
    git: string,
    cwd: string,
    starts: string[],
    readonly stashes: Commit[] = [],
  ) {
    this.starts = [...starts];
    const byBase = new Map<string, Commit[]>();
    const stashIds = new Set(stashes.map((c) => c.oid));
    const emittedStashes = new Set<string>();
    for (const stash of new Map(stashes.map((c) => [c.oid, c])).values()) {
      const base = stash.parents[0];
      if (base) byBase.set(base, [...(byBase.get(base) ?? []), stash]);
    }
    const parser = new HistoryParser((commit) => {
      // If a branch reaches a stash object, its real DAG takes precedence over the overlay.
      if (stashIds.has(commit.oid)) emittedStashes.add(commit.oid);
      const overlay = (byBase.get(commit.oid) ?? []).filter((c) => !emittedStashes.has(c.oid));
      overlay.forEach((c) => emittedStashes.add(c.oid));
      const records = [...overlay, commit];
      for (const record of records) this.bufferedBytes += this.size(record);
      if (this.bufferedBytes > 64 * 1024 * 1024)
        throw new GitError('OUTPUT_LIMIT', 'Buffered history exceeded 64 MiB; use a smaller page');
      this.buffer.push(...records);
      byBase.delete(commit.oid);
    });
    this.completion = (
      starts.length
        ? runGit(
            git,
            ['rev-list', '--date-order', '--parents', `--format=${HISTORY_FORMAT}`, '--stdin'],
            {
              cwd,
              stdin: starts.join('\n') + '\n',
              signal: this.controller.signal,
              timeoutMs: 0,
              maxBytes: 1024 * 1024 * 1024,
              onStdout: async (chunk) => {
                parser.push(chunk);
                this.changed?.();
                if (this.buffer.length >= this.demand && !this.controller.signal.aborted)
                  await new Promise<void>((resolve) => {
                    this.resume = resolve;
                  });
              },
            },
          )
        : Promise.resolve()
    )
      .then(() => {
        parser.finish();
        this.done = true;
      })
      .catch((error) => {
        this.error = error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        this.changed?.();
      });
  }
  async page(expectedOffset: number, count: number, signal?: AbortSignal) {
    if (this.reading) throw new GitError('PAGE_BUSY', 'A history page is already loading');
    if (expectedOffset !== this.offset)
      throw new GitError('STALE_PAGE', 'History page offset changed; refresh history');
    if (!Number.isInteger(count) || count < 1 || count > 5000)
      throw new GitError('INVALID_PAGE', 'Page size must be between 1 and 5000');
    this.reading = true;
    this.demand = count + 1;
    const abort = () =>
      this.stop(new GitError('CANCELLED', 'History loading cancelled; refresh to restart'));
    const timeout = setTimeout(
      () => this.stop(new GitError('TIMEOUT', 'History loading timed out; refresh to restart')),
      30000,
    );
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      while (this.buffer.length < this.demand && !this.done && !this.error) {
        await new Promise<void>((resolve) => {
          this.changed = resolve;
          const resume = this.resume;
          this.resume = undefined;
          resume?.();
        });
      }
      if (this.error) throw this.error;
      const commits = this.buffer.splice(0, count);
      for (const commit of commits) this.bufferedBytes -= this.size(commit);
      const offset = this.offset;
      this.offset += commits.length;
      return { cursor: this.id, offset, commits, hasMore: this.buffer.length > 0 || !this.done };
    } finally {
      this.reading = false;
      this.demand = 1;
      this.changed = undefined;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
  private stop(error: Error) {
    this.error ??= error;
    this.controller.abort();
    this.resume?.();
    this.resume = undefined;
    this.changed?.();
  }
  async close() {
    this.stop(new GitError('STALE_CURSOR', 'History has changed; refresh to restart'));
    await this.completion;
    this.buffer = [];
    this.bufferedBytes = 0;
  }
}
