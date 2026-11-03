import { afterAll, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-worktrees-'));
afterAll(() => rm(root, { recursive: true, force: true }));

test('worktree inventory distinguishes the main, dirty, detached, locked and missing checkouts', async () => {
  const path = createFixture(
    join(root, process.platform === 'win32' ? 'inventory' : 'inventory\nrepo'),
    'linear',
    3,
  );
  const linked = join(root, process.platform === 'win32' ? 'linked space ü' : 'linked space\nü');
  const missing = join(root, 'missing');
  fixtureGit(path, ['worktree', 'add', '-b', 'topic', linked]);
  fixtureGit(path, ['worktree', 'lock', '--reason', 'portable drive', linked]);
  fixtureGit(path, ['worktree', 'add', '--detach', missing]);
  await rm(missing, { recursive: true });
  await writeFile(join(linked, 'untracked.txt'), 'work in progress');
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const state = await service.worktrees(repo.id);
    expect(state.entries).toHaveLength(3);
    expect(state.entries[0]).toMatchObject({ path, main: true, current: true, changedFiles: 0 });
    expect(state.entries.find((entry) => entry.path === linked)).toMatchObject({
      branch: 'refs/heads/topic',
      locked: true,
      lockReason: 'portable drive',
      available: true,
      changedFiles: 1,
    });
    const absent = state.entries.find((entry) => entry.path === missing)!;
    expect(absent).toMatchObject({ detached: true, available: false, prunable: true });
    await expect(service.openWorktree(repo.id, absent.id, state.revision)).rejects.toMatchObject({
      code: 'WORKTREE_UNAVAILABLE',
    });
    const target = state.entries.find((entry) => entry.path === linked)!;
    const opened = await service.openWorktree(repo.id, target.id, state.revision);
    expect(opened.path).toBe(linked);
    expect(opened.commonDir).toBe(repo.commonDir);
    expect((await service.worktrees(opened.id)).entries.find((entry) => entry.current)?.id).toBe(
      target.id,
    );
    await expect(
      service.openWorktree(repo.id, 'f'.repeat(64), state.revision),
    ).rejects.toMatchObject({
      code: 'WORKTREE_NOT_FOUND',
    });
  } finally {
    await service.dispose();
  }
});

test('existing branches require the reviewed tip and cannot be checked out twice; detached worktrees retain the selected commit', async () => {
  const path = createFixture(join(root, 'checkout-modes'), 'linear', 3);
  const service = new RepositoryService('git');
  const destination = join(root, 'existing-branch');
  const detached = join(root, 'detached-checkout');
  await mkdir(destination);
  await mkdir(detached);
  fixtureGit(path, ['branch', 'available', 'HEAD~1']);
  try {
    const repo = await service.open(path);
    let state = await service.worktrees(repo.id);
    await expect(
      service.addWorktree(repo.id, destination, {
        revision: state.revision,
        mode: 'existing',
        branch: 'available',
        oid: repo.head.oid!,
      }),
    ).rejects.toMatchObject({ code: 'STALE_WORKTREE_BRANCH' });
    const selected = fixtureGit(path, ['rev-parse', 'available']);
    state = await service.addWorktree(repo.id, destination, {
      revision: state.revision,
      mode: 'existing',
      branch: 'available',
      oid: selected,
    });
    expect(fixtureGit(destination, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/available');
    expect(fixtureGit(destination, ['rev-parse', 'HEAD'])).toBe(selected);
    await expect(
      service.addWorktree(repo.id, detached, {
        revision: state.revision,
        mode: 'existing',
        branch: 'available',
        oid: selected,
      }),
    ).rejects.toThrow('already');
    state = await service.addWorktree(repo.id, detached, {
      revision: state.revision,
      mode: 'detached',
      oid: selected,
    });
    expect(state.entries.find((entry) => entry.path === detached)).toMatchObject({
      detached: true,
      head: selected,
      changedFiles: 0,
    });
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(repo.head.oid);
    const controller = new AbortController();
    controller.abort();
    await expect(service.worktrees(repo.id, controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  } finally {
    await service.dispose();
  }
});

test('bare and unborn worktree inventories retain their distinct states', async () => {
  const source = createFixture(join(root, 'bare-source'), 'linear', 3);
  const bare = join(root, 'bare.git');
  const unborn = join(root, 'unborn');
  fixtureGit(root, ['clone', '--bare', source, bare]);
  await mkdir(unborn);
  const service = new RepositoryService('git');
  try {
    const bareRepo = await service.open(bare);
    expect((await service.worktrees(bareRepo.id)).entries).toEqual([
      expect.objectContaining({
        path: bare,
        bare: true,
        main: true,
        current: true,
        available: true,
        changedFiles: null,
      }),
    ]);
    const unbornRepo = await service.init(unborn, 'main');
    const entry = (await service.worktrees(unbornRepo.id)).entries[0]!;
    expect(entry).toMatchObject({
      path: unborn,
      branch: 'refs/heads/main',
      available: true,
      changedFiles: 0,
    });
    expect(entry.head).toBeUndefined();
  } finally {
    await service.dispose();
  }
});

test('a registered path replaced by an unrelated repository cannot be opened as a linked worktree', async () => {
  const path = createFixture(join(root, 'replacement-source'), 'linear', 3);
  const linked = join(root, 'replacement-target');
  fixtureGit(path, ['worktree', 'add', '-b', 'linked', linked]);
  await rm(linked, { recursive: true });
  createFixture(linked, 'linear', 2);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const state = await service.worktrees(repo.id);
    const entry = state.entries.find((item) => item.path === linked)!;
    expect(entry.available).toBe(false);
    await expect(service.openWorktree(repo.id, entry.id, state.revision)).rejects.toMatchObject({
      code: 'WORKTREE_UNAVAILABLE',
    });
    expect(fixtureGit(path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
  } finally {
    await service.dispose();
  }
});

test('creating a worktree uses an empty folder and a reviewed commit without changing the current checkout', async () => {
  const path = createFixture(join(root, 'creation'), 'linear', 3);
  const destination = join(root, 'new checkout');
  const nonempty = join(root, 'occupied');
  await mkdir(destination);
  await mkdir(nonempty);
  await writeFile(join(nonempty, 'keep.txt'), 'keep me');
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const before = await service.worktrees(repo.id);
    const state = await service.addWorktree(repo.id, destination, {
      revision: before.revision,
      mode: 'new',
      branch: 'feature/worktree',
      oid: repo.head.oid!,
    });
    expect(state.entries.find((entry) => entry.path === destination)).toMatchObject({
      head: repo.head.oid,
      branch: 'refs/heads/feature/worktree',
      changedFiles: 0,
      available: true,
    });
    expect(fixtureGit(path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    expect(fixtureGit(destination, ['rev-parse', 'HEAD'])).toBe(repo.head.oid);
    await expect(
      service.addWorktree(repo.id, nonempty, {
        revision: state.revision,
        mode: 'new',
        branch: 'should-not-exist',
        oid: repo.head.oid!,
      }),
    ).rejects.toMatchObject({ code: 'WORKTREE_DESTINATION_NOT_EMPTY' });
    expect(fixtureGit(path, ['branch', '--list', 'should-not-exist'])).toBe('');
    await expect(
      service.addWorktree(repo.id, nonempty, {
        revision: before.revision,
        mode: 'detached',
        oid: repo.head.oid!,
      }),
    ).rejects.toMatchObject({ code: 'STALE_WORKTREES' });
  } finally {
    await service.dispose();
  }
});
