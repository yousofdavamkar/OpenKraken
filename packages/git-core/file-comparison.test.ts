import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepositoryService } from './src/repository.js';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-comparison-'));
afterAll(() => rm(root, { recursive: true, force: true }));
test('commit comparison returns native blob contents and Git hunks without changing the workspace', async () => {
  const path = createFixture(join(root, 'text'));
  await writeFile(join(path, 'sample.txt'), 'alpha\nbeta\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Before']);
  await writeFile(join(path, 'sample.txt'), 'alpha\nBETA\nlast\n');
  fixtureGit(path, ['commit', '-am', 'After']);
  const commit = fixtureGit(path, ['rev-parse', 'HEAD']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const result = await service.commitComparison(repo.id, {
      commit,
      pathBytes: Buffer.from('sample.txt').toString('base64'),
    });
    expect(result.oldVersion).toMatchObject({
      kind: 'text',
      text: 'alpha\nbeta\n',
      encoding: 'UTF-8',
      lines: 2,
    });
    expect(result.newVersion).toMatchObject({
      kind: 'text',
      text: 'alpha\nBETA\nlast\n',
      encoding: 'UTF-8',
      lines: 3,
    });
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 });
    expect(result.hunks[0]?.lines.map((line) => [line.kind, line.text])).toEqual([
      ['context', 'alpha'],
      ['del', 'beta'],
      ['add', 'BETA'],
      ['add', 'last'],
    ]);
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(commit);
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await service.dispose();
  }
});
test('comparison applies native whitespace modes and separates binary from large text', async () => {
  const path = createFixture(join(root, 'formats'));
  await writeFile(join(path, 'spaces.txt'), 'one two\n');
  await writeFile(join(path, 'binary.dat'), Buffer.from([0, 1, 2]));
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Before formats']);
  await writeFile(join(path, 'spaces.txt'), 'one   two\n');
  await writeFile(join(path, 'binary.dat'), Buffer.from([0, 3, 4]));
  await writeFile(
    join(path, 'large.txt'),
    Array.from({ length: 50000 }, (_, index) => `line ${index}\n`).join(''),
  );
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'After formats']);
  const commit = fixtureGit(path, ['rev-parse', 'HEAD']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const text = { commit, pathBytes: Buffer.from('spaces.txt').toString('base64') };
    expect((await service.commitComparison(repo.id, text)).hunks).toHaveLength(1);
    expect(
      (await service.commitComparison(repo.id, { ...text, whitespace: 'all' })).hunks,
    ).toHaveLength(0);
    expect(
      (await service.commitComparison(repo.id, { ...text, whitespace: 'changes' })).hunks,
    ).toHaveLength(0);
    const binary = await service.commitComparison(repo.id, {
      commit,
      pathBytes: Buffer.from('binary.dat').toString('base64'),
    });
    expect(binary.oldVersion).toMatchObject({ kind: 'binary', bytes: 3 });
    expect(binary.newVersion).toMatchObject({ kind: 'binary', bytes: 3 });
    expect(binary.hunks).toEqual([]);
    const selection = { commit, pathBytes: Buffer.from('large.txt').toString('base64') };
    const guarded = await service.commitComparison(repo.id, selection);
    expect(guarded.guard).toEqual({ reason: 'lines', limit: 10000, canLoad: true });
    expect(guarded.newVersion.text).toBeUndefined();
    const loaded = await service.commitComparison(repo.id, { ...selection, allowLarge: true });
    expect(loaded.guard).toBeUndefined();
    expect(loaded.oldVersion.kind).toBe('missing');
    expect(loaded.newVersion).toMatchObject({ kind: 'text', lines: 50000 });
    expect(loaded.hunks[0]?.lines).toHaveLength(50000);
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await service.dispose();
  }
});
