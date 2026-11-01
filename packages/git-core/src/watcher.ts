import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Repository } from '@openkraken/ipc-contract';
import type { subscribe, AsyncSubscription } from '@parcel/watcher';
import { runGit } from './runner.js';
export type RefreshDomain =
  'status' | 'refs' | 'graph' | 'stash' | 'worktrees' | 'operationState' | 'config' | 'remotes';
export interface WatchEvent {
  repoId: string;
  domains: RefreshDomain[];
  mode: 'native' | 'polling';
}
function within(root: string, path: string) {
  const name = relative(root, path);
  return !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`)
    ? name.split(sep).join('/')
    : undefined;
}
export function classifyPath(repo: Repository, path: string): RefreshDomain[] {
  for (const root of [...new Set([repo.gitDir, repo.commonDir])].sort(
    (a, b) => b.length - a.length,
  )) {
    const name = within(root, path);
    if (name === undefined) continue;
    if (
      name.endsWith('.lock') ||
      name.startsWith('objects/') ||
      name.startsWith('openkraken-watch-')
    )
      return [];
    if (name === 'index') return ['status'];
    if (
      name === 'HEAD' ||
      name === 'packed-refs' ||
      name === 'FETCH_HEAD' ||
      name.startsWith('refs/heads/') ||
      name.startsWith('refs/remotes/')
    )
      return ['refs', 'graph'];
    if (name.startsWith('refs/tags/')) return ['refs'];
    if (name === 'refs/stash' || name === 'logs/refs/stash') return ['stash', 'graph'];
    if (name.startsWith('worktrees/')) return ['worktrees'];
    if (
      /^(MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|BISECT_LOG|rebase-merge|rebase-apply|sequencer)(\/|$)/.test(
        name,
      )
    )
      return ['operationState'];
    if (name === 'config' || name === 'config.worktree') return ['config', 'remotes'];
    if (name === 'info/exclude' || name === 'info/sparse-checkout') return ['status'];
    if (name === 'shallow' || name.startsWith('refs/')) return ['refs', 'graph'];
    return [];
  }
  return !repo.isBare && within(repo.path, path) !== undefined ? ['status'] : [];
}
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
/** Native notifications are hints. Git determines whether observable state actually changed. */
export class RepositoryWatcher {
  mode: 'native' | 'polling' = 'polling';
  private subscriptions: AsyncSubscription[] = [];
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private paused = 0;
  private closed = false;
  private baseline?: Record<RefreshDomain, string>;
  private checking?: Promise<void>;
  private starting?: Promise<void>;
  private again = false;
  private probe?: { path: string; observed: () => void };
  constructor(
    private git: string,
    readonly repo: Repository,
    private notify: (event: WatchEvent) => void,
    private options: { subscribe?: typeof subscribe; selfTestMs?: number } = {},
  ) {}
  private emit(domains: RefreshDomain[]) {
    if (!this.closed) this.notify({ repoId: this.repo.id, domains, mode: this.mode });
  }
  private async metadata(path: string, depth = 0): Promise<string> {
    try {
      const info = await stat(path);
      if (info.isDirectory()) {
        if (depth > 2) return '';
        const names = (await readdir(path)).filter((name) => !name.endsWith('.lock')).sort();
        return JSON.stringify(
          await Promise.all(
            names.map(async (name) => [name, await this.metadata(join(path, name), depth + 1)]),
          ),
        );
      }
      // State/config files are small; cap reads of unusual repository-supplied metadata.
      return info.size <= 1024 * 1024
        ? digest(await readFile(path))
        : `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }
  private async fingerprint(): Promise<Record<RefreshDomain, string>> {
    const run = (args: string[]) =>
      runGit(this.git, args, {
        cwd: this.repo.path,
        signal: this.controller.signal,
        timeoutMs: 10000,
      });
    const [status, refs, head, operation, config, worktrees, shallow, fetch] = await Promise.all([
      this.repo.isBare
        ? undefined
        : run(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--renames']),
      run([
        'for-each-ref',
        '--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track)',
      ]),
      this.metadata(join(this.repo.gitDir, 'HEAD')),
      Promise.all(
        [
          'MERGE_HEAD',
          'CHERRY_PICK_HEAD',
          'REVERT_HEAD',
          'BISECT_LOG',
          'rebase-merge',
          'rebase-apply',
          'sequencer',
        ].map((name) => this.metadata(join(this.repo.gitDir, name))),
      ),
      Promise.all(
        [join(this.repo.commonDir, 'config'), join(this.repo.gitDir, 'config.worktree')].map((p) =>
          this.metadata(p),
        ),
      ),
      this.metadata(join(this.repo.commonDir, 'worktrees')),
      this.metadata(join(this.repo.commonDir, 'shallow')),
      this.metadata(join(this.repo.gitDir, 'FETCH_HEAD')),
    ]);
    const lines = refs.stdout.toString().split('\n');
    const refHash = digest(refs.stdout);
    return {
      status: digest(status?.stdout ?? ''),
      refs: digest(refHash + head + fetch),
      graph: digest(lines.filter((l) => !l.startsWith('refs/tags/')).join('\n') + head + shallow),
      stash: digest(lines.filter((l) => l.startsWith('refs/stash\0')).join('\n')),
      worktrees,
      operationState: digest(JSON.stringify(operation)),
      config: digest(JSON.stringify(config)),
      remotes: digest(JSON.stringify(config)),
    };
  }
  async start() {
    await (this.starting ??= this.startNative());
    this.emit([]);
  }
  private async startNative() {
    await this.check();
    if (this.closed) return;
    try {
      const subscribe = this.options.subscribe ?? (await import('@parcel/watcher')).subscribe;
      const roots = [
        ...new Set([
          ...(this.repo.isBare ? [] : [this.repo.path]),
          this.repo.gitDir,
          this.repo.commonDir,
        ]),
      ];
      for (const root of roots) {
        if (this.closed) return;
        const isWorktree = root === this.repo.path && !this.repo.isBare;
        const subscription = await subscribe(
          root,
          (error, events) => {
            if (this.closed) return;
            if (error) {
              this.fallback();
              return;
            }
            let delay = Infinity;
            for (const event of events) {
              if (event.path === this.probe?.path) this.probe.observed();
              const domains = classifyPath(this.repo, event.path);
              if (domains.length) delay = Math.min(delay, isWorktree ? 300 : 120);
            }
            if (Number.isFinite(delay)) this.schedule(delay);
          },
          {
            ignore: isWorktree
              ? [this.repo.gitDir, this.repo.commonDir, join(this.repo.path, '.git')]
              : [join(root, 'objects'), join(root, 'logs/HEAD')],
          },
        );
        if (this.closed) {
          await subscription.unsubscribe();
          return;
        }
        this.subscriptions.push(subscription);
      }
      if (this.closed) return;
      const path = join(this.repo.gitDir, `openkraken-watch-${randomUUID()}`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const seen = new Promise<boolean>((resolve) => {
        this.probe = { path, observed: () => resolve(true) };
        timer = setTimeout(() => resolve(false), this.options.selfTestMs ?? 1000);
      });
      let working = false;
      try {
        await writeFile(path, '', { flag: 'wx', mode: 0o600 });
        working = await seen;
      } finally {
        clearTimeout(timer);
        this.probe = undefined;
        await rm(path, { force: true });
      }
      if (!working) {
        this.fallback();
        return;
      }
      this.mode = 'native';
      this.emit([]);
      await this.check(); // Close the snapshot-to-subscribe race.
    } catch {
      if (!this.closed) this.fallback();
    }
  }
  private fallback() {
    if (this.closed) return;
    this.mode = 'polling';
    void Promise.allSettled(this.subscriptions.splice(0).map((s) => s.unsubscribe()));
    if (!this.poll)
      this.poll = setInterval(() => {
        void this.check();
      }, 750);
    this.emit([]);
  }
  private schedule(delay: number) {
    if (this.closed || this.paused || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check();
    }, delay);
  }
  pause() {
    this.paused++;
  }
  resume() {
    this.paused = Math.max(0, this.paused - 1);
    if (!this.paused) this.schedule(120);
  }
  async check(): Promise<void> {
    if (this.closed || this.paused) return;
    if (this.checking) {
      this.again = true;
      return this.checking;
    }
    this.checking = (async () => {
      try {
        const next = await this.fingerprint();
        if (this.closed || this.paused) return;
        const changed = this.baseline
          ? (Object.keys(next) as RefreshDomain[]).filter(
              (key) => next[key] !== this.baseline![key],
            )
          : [];
        this.baseline = next;
        if (changed.length) this.emit(changed);
      } catch {
        if (!this.closed) this.fallback();
      }
    })();
    try {
      await this.checking;
    } finally {
      this.checking = undefined;
      if (this.again) {
        this.again = false;
        this.schedule(120);
      }
    }
  }
  async close() {
    this.closed = true;
    this.controller.abort();
    clearTimeout(this.timer);
    clearInterval(this.poll);
    this.probe?.observed();
    await Promise.allSettled(this.subscriptions.splice(0).map((s) => s.unsubscribe()));
    await this.checking;
    await this.starting;
  }
}
