import { afterAll, expect, test } from 'vitest';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';
import { RepositoryWatcher, classifyPath } from './src/watcher.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-watch-'));
afterAll(() => rm(root, { recursive: true, force: true }));
async function setup(name: string) {
  const path = createFixture(join(root, name));
  const service = new RepositoryService('git');
  return { path, repo: await service.open(path) };
}
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
