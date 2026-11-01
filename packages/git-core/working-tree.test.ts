import { afterAll, expect, test } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';
import { WorkingTree } from './src/working-tree.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-working-'));
afterAll(() => rm(root, { recursive: true, force: true }));
async function setup(name: string) {
  const path = createFixture(join(root, name));
  const service = new RepositoryService('git');
  const repo = await service.open(path);
  const work = new WorkingTree('git', repo, join(root, 'profile'));
  return { path, repo, work };
}
const bytes = (path: string) => Buffer.from(path).toString('base64');
test('stage and unstage only literal selected files; persistent undo preserves later working edits', async () => {
  const { path, repo, work } = await setup('files');
  await writeFile(join(path, 'tracked.txt'), 'changed\n');
  await writeFile(join(path, ':special\nfile.txt'), 'new\n');
  await writeFile(join(path, 'other.txt'), 'leave alone\n');
  await work.files('stage', [bytes('tracked.txt'), bytes(':special\nfile.txt')]);
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('changed');
  expect((await work.state()).status.entries.find((e) => e.path === 'other.txt')?.kind).toBe(
    'untracked',
  );
  await work.files('unstage', [bytes('tracked.txt')]);
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('base');
  await writeFile(join(path, 'tracked.txt'), 'edited after unstage\n');
  const reopened = new WorkingTree('git', repo, join(root, 'profile'));
  await reopened.undo();
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('changed');
  expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('edited after unstage\n');
  await reopened.undo();
  expect(fixtureGit(path, ['diff', '--cached', '--name-only'])).toBe('');
  await reopened.undo(true);
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('changed');
});
test('external staging and existing locks prevent undo or writes from overwriting newer work', async () => {
  const { path, work } = await setup('stale');
  await writeFile(join(path, 'tracked.txt'), 'first\n');
  await work.files('stage', [bytes('tracked.txt')]);
  await writeFile(join(path, 'tracked.txt'), 'external\n');
  fixtureGit(path, ['add', 'tracked.txt']);
  await expect(work.undo()).rejects.toMatchObject({ code: 'STALE_UNDO' });
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('external');
  await writeFile(join(path, '.git/index.lock'), 'owned by another process');
  await expect(work.files('unstage', [bytes('tracked.txt')])).rejects.toMatchObject({
    code: 'INDEX_LOCKED',
  });
  expect(await readFile(join(path, '.git/index.lock'), 'utf8')).toBe('owned by another process');
});
test('unstaging on unborn HEAD keeps working files, including edits made after staging', async () => {
  const path = join(root, 'unborn');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path);
  fixtureGit(path, ['init', '-b', 'main']);
  const repo = await new RepositoryService('git').open(path);
  const work = new WorkingTree('git', repo, join(root, 'profile'));
  await writeFile(join(path, 'new.txt'), 'initial\n');
  await work.files('stage', [bytes('new.txt')]);
  await writeFile(join(path, 'new.txt'), 'later\n');
  await work.files('unstage', [bytes('new.txt')]);
  expect(fixtureGit(path, ['ls-files'])).toBe('');
  expect(await readFile(join(path, 'new.txt'), 'utf8')).toBe('later\n');
  await work.undo();
  expect(fixtureGit(path, ['show', ':new.txt'])).toBe('initial');
});
