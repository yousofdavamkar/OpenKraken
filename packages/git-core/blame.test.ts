import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepositoryService } from './src/repository.js';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-blame-'));
afterAll(() => rm(root, { recursive: true, force: true }));
test('blame streams native line attribution for a 10k-line file before completion', async () => {
  const path = createFixture(join(root, 'lines'));
  const lines = Array.from({ length: 10000 }, (_, index) => `line ${index + 1}\n`);
  await writeFile(join(path, 'lines.txt'), lines.join(''));
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Original lines']);
  const original = fixtureGit(path, ['rev-parse', 'HEAD']);
  lines[0] = 'changed first\n';
  lines[9999] = 'changed last\n';
  await writeFile(join(path, 'lines.txt'), lines.join(''));
  fixtureGit(path, ['commit', '-am', 'Change boundary lines']);
  const commit = fixtureGit(path, ['rev-parse', 'HEAD']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const chunks: { oid: string; line: number; text: string }[][] = [];
    let complete = false,
      firstScreen = 0;
    const start = performance.now();
    const result = await service.blame(
      repo.id,
      { commit, pathBytes: Buffer.from('lines.txt').toString('base64') },
      undefined,
      (rows) => {
        expect(complete).toBe(false);
        if (!chunks.length) firstScreen = performance.now() - start;
        chunks.push(rows);
      },
    );
    complete = true;
    const rows = chunks.flat();
    expect(result.lines).toBe(10000);
    expect(rows).toHaveLength(10000);
    expect(rows[0]).toMatchObject({ oid: commit, line: 1, text: 'changed first' });
    expect(rows[1]).toMatchObject({ oid: original, line: 2, text: 'line 2' });
    expect(rows[9999]).toMatchObject({ oid: commit, line: 10000, text: 'changed last' });
    console.log(`10k-line blame first screen: ${firstScreen.toFixed(1)}ms`);
    expect(firstScreen).toBeGreaterThan(0); // Timing acceptance runs in the isolated desktop test.
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await service.dispose();
  }
});

test('cancelling streamed blame releases the read queue and refuses binary input', async () => {
  const path = createFixture(join(root, 'cancel'));
  await writeFile(join(path, 'lines.txt'), 'a line\n'.repeat(10000));
  await writeFile(join(path, 'binary.dat'), Buffer.from([0, 1, 2]));
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Blame inputs']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path),
      commit = fixtureGit(path, ['rev-parse', 'HEAD']);
    const controller = new AbortController();
    await expect(
      service.blame(
        repo.id,
        { commit, pathBytes: Buffer.from('lines.txt').toString('base64') },
        controller.signal,
        () => controller.abort(),
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(
      service.blame(
        repo.id,
        { commit, pathBytes: Buffer.from('binary.dat').toString('base64') },
        undefined,
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'BLAME_UNSUPPORTED' });
    expect((await service.commitFiles(repo.id, commit)).files).toHaveLength(2);
  } finally {
    await service.dispose();
  }
});
