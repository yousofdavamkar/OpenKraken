import { expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPerformanceFixture, performanceGit as git } from './create-performance-fixture.mjs';
import { createReferenceFixture } from './create-reference-performance-fixture.mjs';

test('both reference distributions use the specified commits and preserve the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-ref-scale-'));
  try {
    const { repository: source, head } = await createPerformanceFixture(join(root, 'source'), {
      commits: 50,
      files: 2,
    });
    const before = git(source, ['show-ref']);
    for (const mode of ['shared', 'distinct']) {
      const destination = join(root, mode);
      const result = await createReferenceFixture(source, destination, mode, 20);
      expect(JSON.parse(await readFile(join(destination, 'fixture.json'), 'utf8'))).toEqual(result);
      expect(result).toMatchObject({ head, refs: 20, distinctTargets: mode === 'shared' ? 1 : 20 });
      const list = (namespace) =>
        git(result.repository, ['for-each-ref', '--format=%(refname)', namespace]).split('\n');
      expect(list('refs/heads')).toHaveLength(3);
      expect(list('refs/remotes')).toHaveLength(2);
      expect(list('refs/tags')).toHaveLength(15);
      expect(git(result.repository, ['rev-parse', 'refs/tags/benchmark-00018'])).toBe(
        git(source, ['rev-parse', mode === 'shared' ? 'HEAD' : 'HEAD~19']),
      );
      await expect(createReferenceFixture(source, destination, mode, 20)).rejects.toMatchObject({
        code: 'EEXIST',
      });
    }
    await expect(
      createReferenceFixture(source, join(root, 'short'), 'distinct', 51),
    ).rejects.toThrow('Insufficient');
    await expect(
      createReferenceFixture(source, join(source, 'nested'), 'shared', 20),
    ).rejects.toThrow('outside');
    expect(git(source, ['show-ref'])).toBe(before);
    expect(git(source, ['status', '--porcelain'])).toBe('');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
