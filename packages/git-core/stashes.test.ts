import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-stashes-'));
afterAll(() => rm(root, { recursive: true, force: true }));
const pick = (entry: { selector: string; oid: string }) => ({
  selector: entry.selector,
  oid: entry.oid,
});
const bytes = (path: string) => Buffer.from(path).toString('base64');
test('partial stash saves selected paths and untracked content; Undo restores work while retaining the stash', async () => {
  const path = createFixture(join(root, 'partial'));
  const service = new RepositoryService('git', { dataDir: join(root, 'profile') });
  const repo = await service.open(path);
  await writeFile(join(path, 'tracked.txt'), 'stash selected\n');
  await writeFile(join(path, '-literal space.txt'), 'new selected\n');
  await writeFile(join(path, 'unselected.txt'), 'leave here\n');
  const before = await service.workingState(repo.id);
  await service.stashPush(repo.id, {
    revision: before.revision,
    message: 'Selected work',
    includeUntracked: true,
    paths: [bytes('tracked.txt'), bytes('-literal space.txt')],
  });
  const state = await service.stashes(repo.id);
  expect(state.entries[0]?.subject).toContain('Selected work');
  const oid = state.entries[0]!.oid;
  expect(fixtureGit(path, ['show', `${oid}:tracked.txt`])).toBe('stash selected');
  expect(fixtureGit(path, ['show', `${oid}^3:-literal space.txt`])).toBe('new selected');
  expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('base\n');
  await expect(readFile(join(path, '-literal space.txt'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readFile(join(path, 'unselected.txt'), 'utf8')).toBe('leave here\n');
  await service.undo(repo.id);
  expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('stash selected\n');
  expect(await readFile(join(path, '-literal space.txt'), 'utf8')).toBe('new selected\n');
  expect((await service.stashes(repo.id)).entries[0]?.oid).toBe(oid);
  await service.dispose();
});
test('staged-only stash leaves unstaged files intact and refuses a stale index review', async () => {
  const path = createFixture(join(root, 'staged'));
  const service = new RepositoryService('git', { dataDir: join(root, 'profile') });
  const repo = await service.open(path);
  await writeFile(join(path, 'tracked.txt'), 'staged selection\n');
  fixtureGit(path, ['add', 'tracked.txt']);
  await writeFile(join(path, 'untouched.txt'), 'unstaged new content\n');
  let state = await service.workingState(repo.id);
  await service.stashPush(repo.id, {
    revision: state.revision,
    stagedOnly: true,
    message: 'Staged only',
  });
  expect(fixtureGit(path, ['diff', '--cached', '--name-only'])).toBe('');
  expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('base\n');
  expect(await readFile(join(path, 'untouched.txt'), 'utf8')).toBe('unstaged new content\n');
  await service.undo(repo.id);
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('staged selection');
  state = await service.workingState(repo.id);
  await writeFile(join(path, 'tracked.txt'), 'new staged content\n');
  fixtureGit(path, ['add', 'tracked.txt']);
  await expect(
    service.stashPush(repo.id, { revision: state.revision, stagedOnly: true }),
  ).rejects.toMatchObject({ code: 'STALE_STASH' });
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('new staged content');
  expect((await service.stashes(repo.id)).entries).toHaveLength(1);
  await service.dispose();
});
test('a partial stash excludes unselected staged files from both stash trees and preserves their staged work', async () => {
  const path = createFixture(join(root, 'partial-index'));
  await writeFile(join(path, 'other.txt'), 'old other\n');
  fixtureGit(path, ['add', 'other.txt']);
  fixtureGit(path, ['commit', '-m', 'Other tracked file']);
  await writeFile(join(path, 'tracked.txt'), 'selected edit\n');
  await writeFile(join(path, 'other.txt'), 'unselected staged edit\n');
  fixtureGit(path, ['add', 'other.txt']);
  const service = new RepositoryService('git', { dataDir: join(root, 'profile') });
  const repo = await service.open(path);
  await service.stashPush(repo.id, {
    revision: (await service.workingState(repo.id)).revision,
    paths: [bytes('tracked.txt')],
  });
  expect(fixtureGit(path, ['stash', 'show', '--name-only'])).toBe('tracked.txt');
  expect(fixtureGit(path, ['show', 'stash@{0}^2:other.txt'])).toBe('old other');
  expect(fixtureGit(path, ['show', ':other.txt'])).toBe('unselected staged edit');
  expect(await readFile(join(path, 'other.txt'), 'utf8')).toBe('unselected staged edit\n');
  await service.dispose();
});
test('apply and pop restore a reviewed stash; stale lists and failed applications preserve saved entries', async () => {
  const path = createFixture(join(root, 'apply'));
  for (const text of ['first', 'second']) {
    await writeFile(join(path, 'tracked.txt'), `${text}\n`);
    fixtureGit(path, ['add', 'tracked.txt']);
    fixtureGit(path, ['stash', 'push', '-m', text]);
  }
  const service = new RepositoryService('git', { dataDir: join(root, 'profile') });
  const repo = await service.open(path);
  let list = await service.stashes(repo.id);
  const first = list.entries[1]!;
  await service.stashAction(repo.id, {
    action: 'apply',
    ...pick(first),
    token: list.token,
    restoreIndex: true,
  });
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('first');
  expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('first\n');
  expect((await service.stashes(repo.id)).entries).toHaveLength(2);
  await expect(
    service.stashAction(repo.id, { action: 'pop', ...pick(list.entries[0]!), token: list.token }),
  ).rejects.toThrow();
  expect((await service.stashes(repo.id)).entries).toHaveLength(2);
  fixtureGit(path, ['restore', '--source=HEAD', '--staged', '--worktree', '.']);
  await service.stashAction(repo.id, {
    action: 'pop',
    ...pick(first),
    token: list.token,
    restoreIndex: true,
  });
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('first');
  list = await service.stashes(repo.id);
  expect(list.entries).toHaveLength(1);
  expect(list.entries[0]?.subject).toContain('second');
  const stale = list;
  fixtureGit(path, ['stash', 'push', '-m', 'external']);
  await expect(
    service.stashAction(repo.id, {
      action: 'drop',
      ...pick(stale.entries[0]!),
      token: stale.token,
    }),
  ).rejects.toMatchObject({ code: 'STALE_STASH_LIST' });
  expect((await service.stashes(repo.id)).entries).toHaveLength(2);
  await service.dispose();
});
test('a conflicted pop publishes native conflict stages and keeps the stash', async () => {
  const path = createFixture(join(root, 'conflict'));
  await writeFile(join(path, 'tracked.txt'), 'stashed side\n');
  fixtureGit(path, ['stash', 'push', '-m', 'Conflict candidate']);
  await writeFile(join(path, 'tracked.txt'), 'committed side\n');
  fixtureGit(path, ['add', 'tracked.txt']);
  fixtureGit(path, ['commit', '-m', 'Conflicting branch']);
  const service = new RepositoryService('git', { dataDir: join(root, 'profile') });
  const repo = await service.open(path);
  const list = await service.stashes(repo.id);
  await expect(
    service.stashAction(repo.id, { action: 'pop', ...pick(list.entries[0]!), token: list.token }),
  ).rejects.toThrow();
  expect(
    (await service.workingState(repo.id)).status.entries.find(
      (entry) => entry.path === 'tracked.txt',
    )?.kind,
  ).toBe('conflict');
  expect(fixtureGit(path, ['show', ':2:tracked.txt'])).toBe('committed side');
  expect(fixtureGit(path, ['show', ':3:tracked.txt'])).toBe('stashed side');
  expect((await service.stashes(repo.id)).entries[0]?.oid).toBe(list.entries[0]?.oid);
  await service.dispose();
});
test('renaming a stash retains its tree and parents and moves it to the top; drop removes only the reviewed entry', async () => {
  const path = createFixture(join(root, 'rename'));
  for (const text of ['first', 'second']) {
    await writeFile(join(path, 'tracked.txt'), `${text}\n`);
    fixtureGit(path, ['stash', 'push', '-m', text]);
  }
  const service = new RepositoryService('git', { dataDir: join(root, 'profile') });
  const repo = await service.open(path);
  let list = await service.stashes(repo.id);
  const first = list.entries[1]!;
  await service.stashAction(repo.id, {
    action: 'rename',
    ...pick(first),
    token: list.token,
    message: 'Renamed first',
  });
  list = await service.stashes(repo.id);
  expect(list.entries).toHaveLength(2);
  expect(list.entries[0]?.subject).toBe('Renamed first');
  expect(fixtureGit(path, ['show', '-s', '--format=%T %P', list.entries[0]!.oid])).toBe(
    fixtureGit(path, ['show', '-s', '--format=%T %P', first.oid]),
  );
  await service.stashAction(repo.id, {
    action: 'rename',
    ...pick(list.entries[0]!),
    token: list.token,
    message: 'Rename top too',
  });
  list = await service.stashes(repo.id);
  expect(list.entries).toHaveLength(2);
  expect(list.entries[0]?.subject).toBe('Rename top too');
  await service.stashAction(repo.id, {
    action: 'drop',
    ...pick(list.entries[0]!),
    token: list.token,
  });
  list = await service.stashes(repo.id);
  expect(list.entries).toHaveLength(1);
  expect(list.entries[0]?.subject).toContain('second');
  expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  await service.dispose();
});
