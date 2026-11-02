import { afterAll, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepositoryService } from './src/repository.js';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-reset-'));
afterAll(() => rm(root, { recursive: true, force: true }));
for (const mode of ['soft', 'mixed', 'hard'] as const)
  test(`${mode} reset preserves native semantics and undo restores HEAD, index and working bytes`, async () => {
    const path = createFixture(join(root, mode));
    const target = fixtureGit(path, ['rev-parse', 'HEAD']);
    const base = await readFile(join(path, 'tracked.txt'));
    await writeFile(join(path, 'tracked.txt'), 'committed version\n');
    fixtureGit(path, ['commit', '-am', 'Latest version']);
    const original = fixtureGit(path, ['rev-parse', 'HEAD']);
    await writeFile(join(path, 'tracked.txt'), 'staged version\n');
    fixtureGit(path, ['add', 'tracked.txt']);
    const raw = Buffer.from([0xff, 0, 1, 3, 10]);
    await writeFile(join(path, 'tracked.txt'), raw);
    const service = new RepositoryService('git', { dataDir: join(root, `${mode}-profile`) });
    try {
      const repo = await service.open(path);
      const selection = { mode, target };
      const preview = await service.resetPreview(repo.id, selection);
      await service.reset(repo.id, selection, preview.token);
      expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(target);
      expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe(
        mode === 'soft' ? 'staged version' : base.toString().trim(),
      );
      expect(await readFile(join(path, 'tracked.txt'))).toEqual(mode === 'hard' ? base : raw);
      await service.undo(repo.id);
      expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
      expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('staged version');
      expect(await readFile(join(path, 'tracked.txt'))).toEqual(raw);
      await service.undo(repo.id, true);
      expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(target);
      expect(await readFile(join(path, 'tracked.txt'))).toEqual(mode === 'hard' ? base : raw);
    } finally {
      await service.dispose();
    }
  });
test('hard reset backs up hidden tracked edits and untracked target collisions, and rejects stale reviews', async () => {
  const path = createFixture(join(root, 'hard-collisions'));
  const original = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['switch', '-c', 'target']);
  await writeFile(join(path, 'collision.txt'), 'committed target\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Target file']);
  const target = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['switch', 'main']);
  await writeFile(join(path, 'collision.txt'), 'untracked original\n');
  fixtureGit(path, ['update-index', '--assume-unchanged', 'tracked.txt']);
  await writeFile(join(path, 'tracked.txt'), 'hidden edit\n');
  const service = new RepositoryService('git', { dataDir: join(root, 'collisions-profile') });
  try {
    const repo = await service.open(path);
    const selection = { mode: 'hard', target } as const;
    const preview = await service.resetPreview(repo.id, selection);
    await writeFile(join(path, 'collision.txt'), 'newer untracked original\n');
    await expect(service.reset(repo.id, selection, preview.token)).rejects.toMatchObject({
      code: 'STALE_RESET',
    });
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
    const current = await service.resetPreview(repo.id, selection);
    await service.reset(repo.id, selection, current.token);
    expect(await readFile(join(path, 'collision.txt'), 'utf8')).toBe('committed target\n');
    await service.undo(repo.id);
    expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('hidden edit\n');
    expect(await readFile(join(path, 'collision.txt'), 'utf8')).toBe('newer untracked original\n');
    expect(fixtureGit(path, ['ls-files', '-v', 'tracked.txt'])).toBe('h tracked.txt');
    await writeFile(join(path, 'tracked.txt'), 'later editor changes\n');
    await expect(service.undo(repo.id, true)).rejects.toMatchObject({ code: 'STALE_UNDO' });
    expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('later editor changes\n');
  } finally {
    await service.dispose();
  }
});
