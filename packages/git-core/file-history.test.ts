import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepositoryService } from './src/repository.js';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-file-history-'));
afterAll(() => rm(root, { recursive: true, force: true }));
test('file history follows renames across stable pages and treats pathspec characters literally', async () => {
  const path = createFixture(join(root, 'history'));
  await writeFile(join(path, 'old.txt'), 'first\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Create file']);
  const created = fixtureGit(path, ['rev-parse', 'HEAD']);
  await writeFile(join(path, 'old.txt'), 'first\nsecond\n');
  fixtureGit(path, ['commit', '-am', 'Extend file']);
  fixtureGit(path, ['mv', 'old.txt', '[new].txt']);
  fixtureGit(path, ['commit', '-m', 'Rename file']);
  await writeFile(join(path, '[new].txt'), 'first\nsecond\nthird\n');
  fixtureGit(path, ['commit', '-am', 'Latest file']);
  const commit = fixtureGit(path, ['rev-parse', 'HEAD']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const selection = { commit, pathBytes: Buffer.from('[new].txt').toString('base64'), limit: 2 };
    const first = await service.fileHistory(repo.id, selection);
    expect(first.entries.map((entry) => entry.summary)).toEqual(['Latest file', 'Rename file']);
    expect(first.entries.map((entry) => entry.path)).toEqual(['[new].txt', '[new].txt']);
    expect(first.nextOffset).toBe(2);
    await writeFile(join(path, '[new].txt'), 'new head\n');
    fixtureGit(path, ['commit', '-am', 'Later commit outside snapshot']);
    const second = await service.fileHistory(repo.id, { ...selection, offset: first.nextOffset });
    expect(second.entries.map((entry) => entry.summary)).toEqual(['Extend file', 'Create file']);
    expect(second.entries.map((entry) => entry.path)).toEqual(['old.txt', 'old.txt']);
    expect(second.entries[1]?.oid).toBe(created);
    expect(second.nextOffset).toBeUndefined();
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await service.dispose();
  }
});

test('file history handles a merge resolution and agrees with native follow traversal', async () => {
  const path = createFixture(join(root, 'merge-history'));
  await writeFile(join(path, 'shared.txt'), 'base\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Shared base']);
  fixtureGit(path, ['switch', '-c', 'other']);
  await writeFile(join(path, 'shared.txt'), 'other\n');
  fixtureGit(path, ['commit', '-am', 'Other edit']);
  fixtureGit(path, ['switch', 'main']);
  await writeFile(join(path, 'shared.txt'), 'main\n');
  fixtureGit(path, ['commit', '-am', 'Main edit']);
  try {
    fixtureGit(path, ['merge', '--no-edit', 'other']);
  } catch {
    /* Expected content conflict. */
  }
  await writeFile(join(path, 'shared.txt'), 'combined\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Combined resolution']);
  const commit = fixtureGit(path, ['rev-parse', 'HEAD']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const result = await service.fileHistory(repo.id, {
      commit,
      pathBytes: Buffer.from('shared.txt').toString('base64'),
    });
    const native = fixtureGit(path, [
      'log',
      '--follow',
      '--format=%s',
      commit,
      '--',
      'shared.txt',
    ]).split('\n');
    expect(result.entries.map((entry) => entry.summary)).toEqual(native);
  } finally {
    await service.dispose();
  }
});
