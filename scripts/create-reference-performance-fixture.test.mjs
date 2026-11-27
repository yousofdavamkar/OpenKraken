import { expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPerformanceFixture, performanceGit as git } from './create-performance-fixture.mjs';
import { createReferenceFixture } from './create-reference-performance-fixture.mjs';

test('reference distributions use the specified commits and preserve the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-ref-scale-'));
  try {
    const { repository: source, head } = await createPerformanceFixture(join(root, 'source'), {
      commits: 50,
      files: 2,
    });
    const before = git(source, ['show-ref']);
    for (const mode of ['shared', 'distinct', 'one-annotation']) {
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
      if (mode === 'one-annotation') {
        const fields = git(result.repository, [
          'for-each-ref',
          '--format=%(refname) %(objecttype) %(*objectname)',
        ]);
        const annotations = fields.split('\n').filter((line) => line.includes(' tag '));
        const peeled = git(source, ['rev-parse', 'HEAD~5']);
        expect(annotations).toEqual([`refs/tags/benchmark-00004 tag ${peeled}`]);
        expect(git(result.repository, ['rev-list', '--date-order', '--parents', '--all'])).toBe(
          git(source, ['rev-list', '--date-order', '--parents', 'HEAD']),
        );
      }
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

test('grouped refs switch target every 100 refs, including a partial final group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-grouped-refs-'));
  try {
    const { repository: source } = await createPerformanceFixture(join(root, 'source'), {
      commits: 3,
      files: 2,
    });
    const result = await createReferenceFixture(source, join(root, 'grouped'), 'grouped', 201);
    const targets = git(result.repository, ['for-each-ref', '--format=%(objectname)']).split('\n');
    const commits = git(source, ['rev-list', 'HEAD']).split('\n');
    expect(result).toMatchObject({ refs: 201, distinctTargets: 3, head: commits[0] });
    expect(commits.map((oid) => targets.filter((target) => target === oid).length)).toEqual([
      100, 100, 1,
    ]);
    for (const [ref, target] of [
      ['refs/tags/benchmark-00098', commits[0]],
      ['refs/tags/benchmark-00099', commits[1]],
      ['refs/tags/benchmark-00199', commits[2]],
    ]) {
      expect(git(result.repository, ['rev-parse', ref])).toBe(target);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('nested aliases reach one independent commit and leave the source refs and objects intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-nested-refs-'));
  try {
    const { repository: source, head } = await createPerformanceFixture(join(root, 'source'), {
      commits: 3,
      files: 2,
    });
    const original = git(source, ['show-ref']);
    const result = await createReferenceFixture(
      source,
      join(root, 'nested'),
      'nested-aliases',
      201,
    );
    const repo = result.repository;
    expect(result).toMatchObject({ head, refs: 201, distinctTargets: 2 });
    const tags = git(repo, ['for-each-ref', '--format=%(objectname)', 'refs/tags']).split('\n');
    expect(tags).toHaveLength(200);
    expect(new Set(tags).size).toBe(1);
    let target = tags[0];
    for (let level = 0; level < 3; level++) {
      expect(git(repo, ['cat-file', '-t', target])).toBe('tag');
      target = git(repo, ['cat-file', '-p', target]).split('\n')[0].slice('object '.length);
    }
    expect(result.annotation.commit).toBe(target);
    expect(git(repo, ['rev-list', '--date-order', '--max-count=1', '--all'])).toBe(target);
    expect(git(repo, ['rev-list', '--parents', target])).toBe(target);
    expect(git(repo, ['rev-list', '--count', '--all'])).toBe('4');
    expect(git(source, ['show-ref'])).toBe(original);
    expect(() => git(source, ['cat-file', '-e', target])).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
