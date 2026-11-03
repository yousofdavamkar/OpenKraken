import { afterAll, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';
import { RepositoryWatcher, classifyPath } from './src/watcher.js';
import * as runner from './src/runner.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-watch-'));
afterAll(() => rm(root, { recursive: true, force: true }));
async function setup(name: string) {
  const path = createFixture(join(root, name));
  const service = new RepositoryService('git');
  return { path, repo: await service.open(path) };
}
test('initial watcher baseline reuses snapshot refs and agrees with a fresh native fingerprint', async () => {
  const path = createFixture(join(root, 'snapshot-baseline'));
  fixtureGit(path, ['tag', '-d', 'annotated']);
  const service = new RepositoryService('git');
  const repo = await service.open(path);
  const events: string[][] = [];
  const watch = new RepositoryWatcher('git', repo, (event) => events.push(event.domains));
  const run = vi.spyOn(runner, 'runGit');
  try {
    const snapshot = await watch.primeSnapshot(() => service.snapshot(repo.id, undefined, false));
    expect(snapshot.refs.length).toBeGreaterThan(2);
    expect(run.mock.calls.filter(([, args]) => args[0] === 'for-each-ref')).toHaveLength(1);
    await watch.check();
    expect(events).toEqual([]);
    fixtureGit(path, ['branch', 'after-snapshot']);
    await watch.start();
    expect(events.flat()).toContain('refs');
    expect(events.flat()).toContain('graph');
  } finally {
    run.mockRestore();
    await watch.close();
    await service.dispose();
  }
});
test.each(['checkout', 'bare', 'linked'] as const)(
  'snapshot baseline preserves native tracking, tag and stash identities in a %s repository',
  async (kind) => {
    const source = createFixture(join(root, `seed-${kind}`), 'stash');
    const diverged = fixtureGit(source, [
      'commit-tree',
      'HEAD^{tree}',
      '-p',
      'HEAD~2',
      '-m',
      'diverged',
    ]);
    for (const [branch, target, upstream] of [
      ['behind', 'HEAD~2', 'refs/heads/main'],
      ['equal', 'HEAD~1', 'refs/heads/main'],
      ['diverged', diverged, 'refs/heads/main'],
      ['gone', 'HEAD', 'refs/heads/missing'],
    ]) {
      fixtureGit(source, ['branch', branch!, target!]);
      fixtureGit(source, ['config', `branch.${branch}.remote`, 'origin']);
      fixtureGit(source, ['config', `branch.${branch}.merge`, upstream!]);
    }
    fixtureGit(source, ['branch', 'Ångström']);
    const blob = fixtureGit(source, ['hash-object', '-w', '--stdin'], 'blob tag target');
    fixtureGit(source, ['update-ref', 'refs/tags/blob', blob]);
    let path = source;
    if (kind === 'bare') {
      path = join(root, 'seed-bare-clone.git');
      fixtureGit(source, ['clone', '--mirror', source, path]);
    } else if (kind === 'linked') {
      path = join(root, 'seed-linked-checkout');
      fixtureGit(source, ['worktree', 'add', '-b', 'linked', path]);
    }
    const service = new RepositoryService('git');
    const repo = await service.open(path);
    const events: string[][] = [];
    const watch = new RepositoryWatcher('git', repo, (event) => events.push(event.domains));
    try {
      const snapshot = await watch.primeSnapshot(() => service.snapshot(repo.id, undefined, false));
      expect(snapshot.refs.some((ref) => ref.peeled)).toBe(true);
      expect(snapshot.refs.some((ref) => ref.kind === 'stash')).toBe(true);
      if (kind !== 'bare') {
        expect(snapshot.refs.find((ref) => ref.shortName === 'diverged')?.upstream).toMatchObject({
          ahead: 1,
          behind: 1,
        });
        expect(snapshot.refs.find((ref) => ref.shortName === 'behind')?.upstream).toMatchObject({
          ahead: 0,
          behind: 1,
        });
        expect(snapshot.refs.find((ref) => ref.shortName === 'equal')?.upstream).toMatchObject({
          ahead: 0,
          behind: 0,
        });
        expect(snapshot.refs.find((ref) => ref.shortName === 'gone')?.upstream?.gone).toBe(true);
      }
      await watch.check();
      expect(events).toEqual([]);
    } finally {
      await watch.close();
      await service.dispose();
    }
  },
);
test('changes after snapshot capture are observed when subscriptions start', async () => {
  const path = createFixture(join(root, 'seed-handoff'), 'stash');
  const service = new RepositoryService('git');
  const repo = await service.open(path);
  const events: string[][] = [];
  const watch = new RepositoryWatcher('git', repo, (event) => events.push(event.domains));
  try {
    await watch.primeSnapshot(async () => {
      const snapshot = await service.snapshot(repo.id, undefined, false);
      fixtureGit(path, ['tag', '-d', 'annotated']);
      fixtureGit(path, ['update-ref', '-d', 'refs/stash']);
      fixtureGit(path, ['branch', 'new-branch']);
      fixtureGit(path, ['checkout', '--detach']);
      fixtureGit(path, ['config', 'watcher.test', 'changed']);
      await writeFile(join(path, 'tracked.txt'), 'after snapshot');
      return snapshot;
    });
    expect(events).toEqual([]);
    await watch.start();
    expect(events.flat()).toEqual(
      expect.arrayContaining(['refs', 'graph', 'stash', 'status', 'config', 'remotes']),
    );
  } finally {
    await watch.close();
    await service.dispose();
  }
});
test('failed or closed snapshot priming cannot publish a baseline or be reused', async () => {
  const path = createFixture(join(root, 'seed-lifecycle'));
  const service = new RepositoryService('git');
  const repo = await service.open(path);
  const events: string[][] = [];
  const failed = new RepositoryWatcher('git', repo, (event) => events.push(event.domains));
  const closing = new RepositoryWatcher('git', repo, (event) => events.push(event.domains));
  try {
    await expect(
      failed.primeSnapshot(async () => {
        throw new Error('snapshot interrupted');
      }),
    ).rejects.toThrow('snapshot interrupted');
    await expect(
      failed.primeSnapshot(() => service.snapshot(repo.id, undefined, false)),
    ).rejects.toThrow('fresh watcher');
    const snapshot = await service.snapshot(repo.id, undefined, false);
    let started!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = closing.primeSnapshot(async () => {
      started();
      await released;
      return snapshot;
    });
    await ready;
    const closed = closing.close();
    release();
    expect(await pending).toBe(snapshot);
    await closed;
    await closing.check();
    expect(events).toEqual([]);
  } finally {
    await failed.close();
    await closing.close();
    await service.dispose();
  }
});
test('other checkout edits publish status without invalidating history and new checkouts become watched', async () => {
  const { path, repo } = await setup('other-worktrees');
  const linked = join(root, 'observed-linked');
  fixtureGit(path, ['worktree', 'add', '-b', 'observed', linked]);
  const events: string[][] = [];
  const watch = new RepositoryWatcher('git', repo, (event) => {
    if (event.domains.length) events.push(event.domains);
  });
  try {
    await watch.start();
    expect(watch.mode).toBe('native');
    await writeFile(join(linked, 'draft.txt'), 'linked draft');
    await expect
      .poll(() => events.flat(), { timeout: 1400, interval: 20 })
      .toContain('worktreeStatus');
    expect(events.flat()).not.toContain('worktrees');
    expect(events.flat()).not.toContain('graph');
    const added = join(root, 'observed-added');
    events.length = 0;
    fixtureGit(path, ['worktree', 'add', '-b', 'added', added]);
    await expect.poll(() => events.flat(), { timeout: 1400, interval: 20 }).toContain('worktrees');
    events.length = 0;
    await writeFile(join(added, 'draft.txt'), 'new checkout draft');
    await expect
      .poll(() => events.flat(), { timeout: 1400, interval: 20 })
      .toContain('worktreeStatus');
    events.length = 0;
    watch.pause();
    await writeFile(join(added, 'while-paused.txt'), 'do not lose this update');
    await watch.check();
    expect(events).toEqual([]);
    watch.resume();
    await expect
      .poll(() => events.flat(), { timeout: 1400, interval: 20 })
      .toContain('worktreeStatus');
  } finally {
    await watch.close();
  }
});
test('an offline locked checkout is rediscovered without a parent-directory notification', async () => {
  const { path, repo } = await setup('offline-worktree');
  const linked = join(root, 'offline-linked');
  const offline = join(root, 'offline-storage');
  fixtureGit(path, ['worktree', 'add', '-b', 'offline', linked]);
  fixtureGit(path, ['worktree', 'lock', linked]);
  await rename(linked, offline);
  const events: string[][] = [];
  const watch = new RepositoryWatcher('git', repo, (event) => events.push(event.domains));
  try {
    await watch.start();
    expect(watch.mode).toBe('native');
    events.length = 0;
    await rename(offline, linked);
    await expect
      .poll(() => events.flat(), { timeout: 1400, interval: 20 })
      .toContain('worktreeStatus');
    events.length = 0;
    await writeFile(join(linked, 'reconnected.txt'), 'back online');
    await expect
      .poll(() => events.flat(), { timeout: 1400, interval: 20 })
      .toContain('worktreeStatus');
  } finally {
    await watch.close();
  }
});
test('replaced checkout metadata becomes unavailable and polling reconnects the registered checkout', async () => {
  const { path, repo } = await setup('replaced-worktree');
  const foreign = createFixture(join(root, 'foreign-worktree'));
  const linked = join(root, 'replaced-linked');
  fixtureGit(path, ['worktree', 'add', '-b', 'replaced', linked]);
  const pointer = await readFile(join(linked, '.git'));
  const events: string[][] = [];
  const watch = new RepositoryWatcher('git', repo, (event) => events.push(event.domains));
  try {
    await watch.start();
    events.length = 0;
    await writeFile(join(linked, '.git'), `gitdir: ${join(foreign, '.git')}\n`);
    await expect
      .poll(() => events.flat(), { timeout: 1400, interval: 20 })
      .toContain('worktreeStatus');
    events.length = 0;
    await writeFile(join(linked, '.git'), pointer);
    await expect
      .poll(() => events.flat(), { timeout: 1400, interval: 20 })
      .toContain('worktreeStatus');
    events.length = 0;
    await writeFile(join(linked, 'after-reconnect.txt'), 'now observed again');
    await expect
      .poll(() => events.flat(), { timeout: 1400, interval: 20 })
      .toContain('worktreeStatus');
  } finally {
    await watch.close();
  }
});
test('refresh classification separates worktree, refs, operations and ignored Git internals', async () => {
  const { path, repo } = await setup('classifier');
  expect(classifyPath(repo, join(path, 'tracked.txt'))).toEqual(['status']);
  expect(classifyPath(repo, join(repo.gitDir, 'index'))).toEqual(['status']);
  expect(classifyPath(repo, join(repo.gitDir, 'refs/heads/main'))).toEqual(['refs', 'graph']);
  expect(classifyPath(repo, join(repo.gitDir, 'refs/tags/v1'))).toEqual(['refs']);
  expect(classifyPath(repo, join(repo.gitDir, 'rebase-merge/done'))).toEqual(['operationState']);
  expect(classifyPath(repo, join(repo.gitDir, 'config'))).toEqual(['config', 'remotes']);
  expect(classifyPath(repo, join(repo.gitDir, 'objects/ab/cdef'))).toEqual([]);
  expect(classifyPath(repo, join(repo.gitDir, 'index.lock'))).toEqual([]);
});
test('native watcher detects external worktree, staging and commit changes within 1.5 seconds', async () => {
  const { path, repo } = await setup('native');
  const events: string[][] = [];
  const watch = new RepositoryWatcher('git', repo, (event) => {
    if (event.domains.length) events.push(event.domains);
  });
  try {
    await watch.start();
    expect(watch.mode).toBe('native');
    const expectChange = async (change: () => Promise<unknown> | unknown, domain: string) => {
      events.length = 0;
      const start = performance.now();
      await change();
      await expect
        .poll(() => events.some((domains) => domains.includes(domain)), {
          timeout: 1400,
          interval: 20,
        })
        .toBe(true);
      expect(performance.now() - start).toBeLessThan(1500);
    };
    await expectChange(() => writeFile(join(path, 'tracked.txt'), 'external\n'), 'status');
    await expectChange(() => fixtureGit(path, ['add', 'tracked.txt']), 'status');
    await expectChange(() => fixtureGit(path, ['commit', '-m', 'External commit']), 'graph');
    events.length = 0;
    await writeFile(join(path, '.gitignore'), 'ignored/\n');
    await expect.poll(() => events.length).toBeGreaterThan(0);
    // An own-write window coalesces without losing changes made while paused.
    events.length = 0;
    watch.pause();
    await writeFile(join(path, 'tracked.txt'), 'during write\n');
    await watch.check();
    expect(events).toEqual([]);
    watch.resume();
    await expect.poll(() => events.flat()).toContain('status');
  } finally {
    await watch.close();
  }
});
test('failed native self-test falls back to polling and stops cleanly', async () => {
  const { path, repo } = await setup('fallback');
  const linked = join(root, 'fallback-linked');
  fixtureGit(path, ['worktree', 'add', '-b', 'fallback-topic', linked]);
  const events: string[][] = [];
  const watch = new RepositoryWatcher('git', repo, (event) => events.push(event.domains), {
    subscribe: async () => ({ unsubscribe: async () => {} }),
    selfTestMs: 30,
  });
  await watch.start();
  expect(watch.mode).toBe('polling');
  events.length = 0;
  await writeFile(join(path, 'tracked.txt'), 'poll this\n');
  await expect.poll(() => events.flat(), { timeout: 1400, interval: 20 }).toContain('status');
  events.length = 0;
  await writeFile(join(linked, 'draft.txt'), 'poll other checkout');
  await expect
    .poll(() => events.flat(), { timeout: 1400, interval: 20 })
    .toContain('worktreeStatus');
  await watch.close();
  events.length = 0;
  await writeFile(join(path, 'tracked.txt'), 'after close\n');
  await watch.check();
  expect(events).toEqual([]);
});
test('linked worktrees watch both private HEAD and common refs; bare repositories have no status', async () => {
  const { path } = await setup('linked-main');
  const linked = join(root, 'linked-child');
  fixtureGit(path, ['worktree', 'add', '-b', 'child', linked]);
  const repo = await new RepositoryService('git').open(linked);
  const events: string[][] = [];
  const watch = new RepositoryWatcher('git', repo, (event) => events.push(event.domains));
  try {
    await watch.start();
    expect(watch.mode).toBe('native');
    fixtureGit(path, ['branch', 'external-branch']);
    await expect.poll(() => events.flat(), { timeout: 1400, interval: 20 }).toContain('refs');
    events.length = 0;
    fixtureGit(linked, ['checkout', '--detach']);
    await expect.poll(() => events.flat(), { timeout: 1400, interval: 20 }).toContain('graph');
    events.length = 0;
    await writeFile(join(path, 'main-draft.txt'), 'main checkout changed');
    await expect
      .poll(() => events.flat(), { timeout: 1400, interval: 20 })
      .toContain('worktreeStatus');
  } finally {
    await watch.close();
  }
  const bare = join(root, 'bare.git');
  fixtureGit(path, ['clone', '--bare', '.', bare]);
  const bareRepo = await new RepositoryService('git').open(bare);
  const bareEvents: string[][] = [];
  const bareWatch = new RepositoryWatcher('git', bareRepo, (event) =>
    bareEvents.push(event.domains),
  );
  try {
    await bareWatch.start();
    fixtureGit(bare, ['branch', 'bare-branch']);
    await expect.poll(() => bareEvents.flat(), { timeout: 1400, interval: 20 }).toContain('refs');
    expect(bareEvents.flat()).not.toContain('status');
  } finally {
    await bareWatch.close();
  }
});
