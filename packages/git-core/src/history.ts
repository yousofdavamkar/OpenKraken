import { randomUUID } from 'node:crypto';
import type { Commit } from '@openkraken/ipc-contract';
import { HistoryParser, HISTORY_FORMAT } from './parsers.js';
import { GitError, runGit } from './runner.js';

/** One retained rev-list, backpressured at page boundaries. No skip/refetch or full-history buffer. */
export class HistoryCursor {
  readonly id = randomUUID();
  readonly starts: string[];
  private buffer: Commit[] = [];
  private offset = 0;
  private demand = 1;
  private done = false;
  private error?: Error;
  private reading = false;
  private changed?: () => void;
  private resume?: () => void;
  private controller = new AbortController();
  private completion: Promise<void>;
  constructor(git: string, cwd: string, starts: string[], stashes: Commit[] = []) {
    this.starts = [...starts];
    const byBase = new Map<string, Commit[]>();
    for (const stash of stashes) {
      const base = stash.parents[0];
      if (base) byBase.set(base, [...(byBase.get(base) ?? []), stash]);
    }
    const parser = new HistoryParser((commit) => {
      this.buffer.push(...(byBase.get(commit.oid) ?? []), commit);
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
  }
}
