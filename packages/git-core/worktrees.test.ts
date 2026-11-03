import { afterAll, expect, test, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-worktrees-'));
afterAll(() => rm(root, { recursive: true, force: true }));

test('history includes detached worktree HEADs and checkout state while respecting solo and hidden branches', async () => {
  const path = createFixture(join(root, 'history-source'), 'linear', 3);
  const detached = join(root, 'history-detached');
  const branch = join(root, 'history-branch');
  fixtureGit(path, ['worktree', 'add', '--detach', detached]);
  fixtureGit(detached, ['commit', '--allow-empty', '-m', 'Detached checkout only']);
  const detachedHead = fixtureGit(detached, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['worktree', 'add', '-b', 'linked-topic', branch]);
  fixtureGit(branch, ['commit', '--allow-empty', '-m', 'Linked branch only']);
  const branchHead = fixtureGit(branch, ['rev-parse', 'HEAD']);
  await writeFile(join(detached, 'draft.txt'), 'unfinished');
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const snapshot = await service.snapshot(repo.id);
    expect(snapshot.commits.map((commit) => commit.oid)).toContain(detachedHead);
    expect(snapshot.worktrees?.entries.find((entry) => entry.path === detached)).toMatchObject({
      head: detachedHead,
      detached: true,
      current: false,
      changedFiles: 1,
    });
    expect(
      (await service.search(repo.id, snapshot.cursor, 'Detached checkout only')).commits.map(
        (commit) => commit.oid,
      ),
    ).toEqual([detachedHead]);
    const hidden = await service.snapshot(repo.id, undefined, true, {
      hiddenRefs: ['refs/heads/linked-topic'],
    });
    expect(hidden.commits.map((commit) => commit.oid)).not.toContain(branchHead);
    expect(hidden.commits.map((commit) => commit.oid)).toContain(detachedHead);
    const solo = await service.snapshot(repo.id, undefined, true, {
      hiddenRefs: [],
      soloRef: 'refs/heads/main',
    });
    expect(solo.commits.map((commit) => commit.oid)).not.toContain(detachedHead);
    expect(solo.commits.map((commit) => commit.oid)).not.toContain(branchHead);
  } finally {
    await service.dispose();
  }
});

test('prune tokens are repository-bound and expire; a restored checkout invalidates the review', async () => {
  const path = createFixture(join(root, 'prune-token-source'), 'linear', 3);
  const other = createFixture(join(root, 'prune-token-other'), 'linear', 2);
  const linked = join(root, 'prune-token-linked');
  fixtureGit(path, ['worktree', 'add', '-b', 'token-topic', linked]);
  const gitDir = fixtureGit(linked, ['rev-parse', '--absolute-git-dir']);
  await rm(linked, { recursive: true });
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const foreign = await service.open(other);
    const preview = await service.worktreePrunePreview(repo.id);
    await expect(service.pruneWorktrees(foreign.id, preview.token)).rejects.toMatchObject({
      code: 'STALE_WORKTREE_PRUNE',
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001);
    try {
      await expect(service.pruneWorktrees(repo.id, preview.token)).rejects.toMatchObject({
        code: 'STALE_WORKTREE_PRUNE',
      });
    } finally {
      clock.mockRestore();
    }
    const fresh = await service.worktreePrunePreview(repo.id);
    await mkdir(linked);
    await writeFile(join(linked, '.git'), `gitdir: ${gitDir}\n`);
    await expect(service.pruneWorktrees(repo.id, fresh.token)).rejects.toMatchObject({
      code: 'STALE_WORKTREE_PRUNE',
    });
    expect((await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()).toBe(
      'ref: refs/heads/token-topic',
    );
    expect((await service.worktreePrunePreview(repo.id)).report).toBe('');
  } finally {
    await service.dispose();
  }
});

test('prune review exposes invalid registrations that do not appear in the checkout list', async () => {
  const path = createFixture(join(root, 'prune-invalid-source'), 'linear', 3);
  const registration = join(path, '.git/worktrees/broken-registration');
  await mkdir(registration, { recursive: true });
  await writeFile(join(registration, 'note'), 'invalid registration');
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const preview = await service.worktreePrunePreview(repo.id);
    expect(preview.candidates).toHaveLength(0);
    expect(preview.report).toContain('broken-registration');
    expect((await service.pruneWorktrees(repo.id, preview.token)).entries).toHaveLength(1);
    await expect(readFile(join(registration, 'note'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await service.dispose();
  }
});

test('prune preserves a missing detached checkout until its commit has a retaining branch', async () => {
  const path = createFixture(join(root, 'prune-detached-source'), 'linear', 3);
  const linked = join(root, 'prune-detached-linked');
  fixtureGit(path, ['worktree', 'add', '--detach', linked]);
  fixtureGit(linked, ['commit', '--allow-empty', '-m', 'detached recovery']);
  const head = fixtureGit(linked, ['rev-parse', 'HEAD']);
  const gitDir = fixtureGit(linked, ['rev-parse', '--absolute-git-dir']);
  await rm(linked, { recursive: true });
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    await expect(service.worktreePrunePreview(repo.id)).rejects.toMatchObject({
      code: 'WORKTREE_UNREFERENCED',
    });
    expect((await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()).toBe(head);
    fixtureGit(path, ['branch', 'recovered-pruned-work', head]);
    const preview = await service.worktreePrunePreview(repo.id);
    fixtureGit(path, ['branch', '-D', 'recovered-pruned-work']);
    await expect(service.pruneWorktrees(repo.id, preview.token)).rejects.toMatchObject({
      code: 'WORKTREE_UNREFERENCED',
    });
    expect((await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()).toBe(head);
    fixtureGit(path, ['branch', 'recovered-pruned-work', head]);
    const reviewed = await service.worktreePrunePreview(repo.id);
    expect((await service.pruneWorktrees(repo.id, reviewed.token)).entries).toHaveLength(1);
    expect(fixtureGit(path, ['rev-parse', 'recovered-pruned-work'])).toBe(head);
  } finally {
    await service.dispose();
  }
});

test('prune confirmation refuses registration metadata changed after the review', async () => {
  const path = createFixture(join(root, 'prune-metadata-source'), 'linear', 3);
  const linked = join(root, 'prune-metadata-linked');
  fixtureGit(path, ['worktree', 'add', '-b', 'metadata-topic', linked]);
  const gitDir = fixtureGit(linked, ['rev-parse', '--absolute-git-dir']);
  await rm(linked, { recursive: true });
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const preview = await service.worktreePrunePreview(repo.id);
    await writeFile(join(gitDir, 'new-recovery-note'), 'created after review');
    await expect(service.pruneWorktrees(repo.id, preview.token)).rejects.toMatchObject({
      code: 'STALE_WORKTREE_PRUNE',
    });
    expect(await readFile(join(gitDir, 'new-recovery-note'), 'utf8')).toBe('created after review');
    const next = await service.worktreePrunePreview(repo.id);
    expect(next.token).not.toBe(preview.token);
    expect((await service.pruneWorktrees(repo.id, next.token)).entries).toHaveLength(1);
  } finally {
    await service.dispose();
  }
});

test('prune review removes missing registrations while retaining live and locked worktrees and their branches', async () => {
  const path = createFixture(join(root, 'prune-source'), 'linear', 3);
  const live = join(root, 'prune-live');
  const missing = join(root, 'prune-missing');
  const locked = join(root, 'prune-locked');
  for (const [folder, branch] of [
    [live, 'prune-live'],
    [missing, 'prune-missing'],
    [locked, 'prune-locked'],
  ] as const)
    fixtureGit(path, ['worktree', 'add', '-b', branch, folder]);
  fixtureGit(path, ['worktree', 'lock', '--reason', 'offline drive', locked]);
  await rm(missing, { recursive: true });
  await rm(locked, { recursive: true });
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const preview = await service.worktreePrunePreview(repo.id);
    expect(preview.report).toContain('prune-missing');
    expect(preview.report).not.toContain('prune-locked');
    expect((await service.worktrees(repo.id)).entries).toHaveLength(4);
    const result = await service.pruneWorktrees(repo.id, preview.token);
    expect(result.entries.map((entry) => entry.path).sort()).toEqual([path, live, locked].sort());
    expect(result.entries.find((entry) => entry.path === locked)).toMatchObject({
      locked: true,
      lockReason: 'offline drive',
    });
    expect(fixtureGit(path, ['rev-parse', 'prune-missing'])).toBe(repo.head.oid);
    await expect(service.pruneWorktrees(repo.id, preview.token)).rejects.toMatchObject({
      code: 'STALE_WORKTREE_PRUNE',
    });
    expect((await service.worktreePrunePreview(repo.id)).report).toBe('');
  } finally {
    await service.dispose();
  }
});

test('removal preserves an in-progress merge even when its index and files are clean', async () => {
  const path = createFixture(join(root, 'merging-source'), 'linear', 3);
  const linked = join(root, 'merging-linked');
  fixtureGit(path, ['worktree', 'add', '-b', 'merging-topic', linked]);
  fixtureGit(path, ['checkout', '-b', 'merge-feature']);
  fixtureGit(path, ['commit', '--allow-empty', '-m', 'empty feature']);
  fixtureGit(path, ['checkout', 'main']);
  fixtureGit(linked, ['merge', '--no-ff', '--no-commit', 'merge-feature']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const state = await service.worktrees(repo.id);
    const entry = state.entries.find((item) => item.path === linked)!;
    expect(entry.changedFiles).toBe(0);
    await expect(
      service.worktreeAction(repo.id, {
        action: 'remove',
        worktreeId: entry.id,
        revision: state.revision,
      }),
    ).rejects.toMatchObject({ code: 'WORKTREE_OPERATION' });
    expect(fixtureGit(linked, ['rev-parse', 'MERGE_HEAD'])).toBe(
      fixtureGit(path, ['rev-parse', 'merge-feature']),
    );
  } finally {
    await service.dispose();
  }
});

for (const flag of ['assume-unchanged', 'skip-worktree']) {
  test(`removal refuses ${flag} index flags that can conceal modified files`, async () => {
    const path = createFixture(join(root, `${flag}-source`), 'linear', 3);
    const linked = join(root, `${flag}-linked`);
    fixtureGit(path, ['worktree', 'add', '-b', flag, linked]);
    fixtureGit(linked, ['update-index', `--${flag}`, 'tracked.txt']);
    await writeFile(join(linked, 'tracked.txt'), 'hidden edits');
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(path);
      const state = await service.worktrees(repo.id);
      const target = state.entries.find((entry) => entry.path === linked)!;
      expect(target.changedFiles).toBe(0);
      await expect(
        service.worktreeAction(repo.id, {
          action: 'remove',
          worktreeId: target.id,
          revision: state.revision,
        }),
      ).rejects.toMatchObject({ code: 'WORKTREE_INDEX_FLAGS' });
      expect(await readFile(join(linked, 'tracked.txt'), 'utf8')).toBe('hidden edits');
    } finally {
      await service.dispose();
    }
  });
}

test('removing a detached worktree requires a ref that retains its commits', async () => {
  const path = createFixture(join(root, 'detached-removal-source'), 'linear', 3);
  const linked = join(root, 'detached-removal-linked');
  fixtureGit(path, ['worktree', 'add', '--detach', linked]);
  fixtureGit(linked, ['commit', '--allow-empty', '-m', 'unreferenced work']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const state = await service.worktrees(repo.id);
    const entry = state.entries.find((item) => item.path === linked)!;
    const options = { action: 'remove' as const, worktreeId: entry.id, revision: state.revision };
    await expect(service.worktreeAction(repo.id, options)).rejects.toMatchObject({
      code: 'WORKTREE_UNREFERENCED',
    });
    expect(fixtureGit(linked, ['rev-parse', 'HEAD'])).toBe(entry.head);
    fixtureGit(path, ['branch', 'retained-work', entry.head!]);
    expect(
      (await service.worktreeAction(repo.id, options)).entries.some((item) => item.id === entry.id),
    ).toBe(false);
    expect(fixtureGit(path, ['rev-parse', 'retained-work'])).toBe(entry.head);
  } finally {
    await service.dispose();
  }
});

test('worktree removal refuses current, locked, dirty and ignored files and retains the branch after clean removal', async () => {
  const path = createFixture(join(root, 'removal-source'), 'linear', 3);
  const linked = join(root, 'removal-linked');
  fixtureGit(path, ['worktree', 'add', '-b', 'keep-branch', linked]);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    let state = await service.worktrees(repo.id);
    const target = state.entries.find((entry) => entry.path === linked)!;
    const remove = () =>
      service.worktreeAction(repo.id, {
        action: 'remove',
        worktreeId: target.id,
        revision: state.revision,
      });
    await writeFile(join(linked, 'draft.txt'), 'untracked draft');
    await expect(remove()).rejects.toMatchObject({ code: 'WORKTREE_NOT_CLEAN' });
    expect(await readFile(join(linked, 'draft.txt'), 'utf8')).toBe('untracked draft');
    await rm(join(linked, 'draft.txt'));
    await appendFile(join(path, '.git/info/exclude'), '\nignored.txt\n');
    await writeFile(join(linked, 'ignored.txt'), 'ignored but valuable');
    expect(
      (await service.worktrees(repo.id)).entries.find((entry) => entry.id === target.id)
        ?.changedFiles,
    ).toBe(0);
    await expect(remove()).rejects.toMatchObject({ code: 'WORKTREE_NOT_CLEAN' });
    expect(await readFile(join(linked, 'ignored.txt'), 'utf8')).toBe('ignored but valuable');
    await rm(join(linked, 'ignored.txt'));
    state = await service.worktreeAction(repo.id, {
      action: 'lock',
      worktreeId: target.id,
      revision: state.revision,
      reason: 'keep',
    });
    await expect(remove()).rejects.toMatchObject({ code: 'WORKTREE_LOCKED' });
    state = await service.worktreeAction(repo.id, {
      action: 'unlock',
      worktreeId: target.id,
      revision: state.revision,
    });
    const current = await service.open(linked);
    await expect(
      service.worktreeAction(current.id, {
        action: 'remove',
        worktreeId: target.id,
        revision: state.revision,
      }),
    ).rejects.toMatchObject({ code: 'CURRENT_WORKTREE' });
    await expect(
      service.worktreeAction(repo.id, {
        action: 'remove',
        worktreeId: state.entries[0]!.id,
        revision: state.revision,
      }),
    ).rejects.toMatchObject({ code: 'MAIN_WORKTREE' });
    state = await remove();
    expect(state.entries.some((entry) => entry.id === target.id)).toBe(false);
    await expect(readFile(join(linked, 'tracked.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fixtureGit(path, ['rev-parse', 'keep-branch'])).toBe(target.head);
  } finally {
    await service.dispose();
  }
});

test('worktree locks retain a reason, reject stale reviews and can protect an offline checkout', async () => {
  const path = createFixture(join(root, 'locks-source'), 'linear', 3);
  const linked = join(root, 'locks-linked');
  fixtureGit(path, ['worktree', 'add', '-b', 'locked-topic', linked]);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    let state = await service.worktrees(repo.id);
    const target = state.entries.find((entry) => entry.path === linked)!;
    const original = state.revision;
    state = await service.worktreeAction(repo.id, {
      action: 'lock',
      worktreeId: target.id,
      revision: original,
      reason: 'Portable drive',
    });
    expect(state.entries.find((entry) => entry.id === target.id)).toMatchObject({
      locked: true,
      lockReason: 'Portable drive',
    });
    await expect(
      service.worktreeAction(repo.id, {
        action: 'unlock',
        worktreeId: target.id,
        revision: original,
      }),
    ).rejects.toMatchObject({ code: 'STALE_WORKTREES' });
    await rm(linked, { recursive: true });
    state = await service.worktrees(repo.id);
    state = await service.worktreeAction(repo.id, {
      action: 'unlock',
      worktreeId: target.id,
      revision: state.revision,
    });
    expect(state.entries.find((entry) => entry.id === target.id)).toMatchObject({
      locked: false,
      available: false,
    });
    state = await service.worktreeAction(repo.id, {
      action: 'lock',
      worktreeId: target.id,
      revision: state.revision,
      reason: 'Still offline',
    });
    expect(state.entries.find((entry) => entry.id === target.id)).toMatchObject({
      locked: true,
      lockReason: 'Still offline',
    });
    await expect(
      service.worktreeAction(repo.id, {
        action: 'lock',
        worktreeId: state.entries[0]!.id,
        revision: state.revision,
        reason: '',
      }),
    ).rejects.toMatchObject({ code: 'MAIN_WORKTREE' });
  } finally {
    await service.dispose();
  }
});

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
