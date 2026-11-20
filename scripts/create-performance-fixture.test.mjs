import { expect, test } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPerformanceFixture } from './create-performance-fixture.mjs';

test('the scale fixture has deterministic complete history, genuine merges and a clean full checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-scale-'));
  try {
    const first = await createPerformanceFixture(join(root, 'first'), { commits: 1002, files: 12 });
    const second = await createPerformanceFixture(join(root, 'second'), {
      commits: 1002,
      files: 12,
    });
    const git = (...args) =>
      execFileSync('git', args, { cwd: first.repository, encoding: 'utf8' }).trim();
    expect(first.head).toBe(second.head);
    expect(first.commits).toBe(1002);
    expect(first.files).toBe(12);
    expect(first.merges).toBe(1);
    expect(git('rev-parse', '--is-shallow-repository')).toBe('false');
    expect(git('status', '--porcelain')).toBe('');
    const parents = git('rev-list', '--all', '--min-parents=2', '--parents').split(' ').slice(1);
    expect(parents).toHaveLength(2);
    const base = git('merge-base', ...parents);
    expect(parents).not.toContain(base);
    expect(git('ls-files').split('\n')).toHaveLength(12);
    expect(await readFile(join(first.repository, 'status-probe.txt'), 'utf8')).toBe(
      'Revision 1001\n',
    );
    expect(JSON.parse(await readFile(join(root, 'first', 'fixture.json'), 'utf8'))).toEqual(first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the status benchmark manifest identifies the canonical checkout through a directory alias', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-scale-path-'));
  try {
    const alias = join(root, 'alias');
    const original = join(root, 'original');
    await mkdir(original);
    await symlink(original, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const destination = join(alias, 'fixture');
    await createPerformanceFixture(destination, { commits: 2, files: 2 });
    const manifest = JSON.parse(await readFile(join(destination, 'fixture.json'), 'utf8'));
    expect(manifest.repository).toBe(await realpath(join(destination, 'repository')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fixture creation refuses existing destinations and invalid sizes before changing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-scale-guard-'));
  try {
    await writeFile(join(root, 'keep.txt'), 'existing work');
    await expect(createPerformanceFixture(root, { commits: 2, files: 2 })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    for (const options of [{ commits: 0 }, { commits: 2.5 }, { files: 0 }, { files: 250001 }])
      await expect(createPerformanceFixture(join(root, 'invalid'), options)).rejects.toThrow(
        'Invalid fixture size',
      );
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('existing work');
    await expect(readFile(join(root, 'invalid', 'fixture.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inherited Git routing cannot redirect fixture writes into another repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-scale-routing-'));
  try {
    const foreign = join(root, 'foreign.git');
    execFileSync('git', ['init', '--bare', foreign], { stdio: 'ignore' });
    const head = await readFile(join(foreign, 'HEAD'));
    const output = execFileSync(
      process.execPath,
      ['scripts/create-performance-fixture.mjs', join(root, 'fixture'), '2', '2'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_DIR: foreign,
          GIT_WORK_TREE: root,
          GIT_OBJECT_DIRECTORY: join(foreign, 'objects'),
        },
      },
    );
    const manifest = JSON.parse(output);
    expect(await readFile(join(foreign, 'HEAD'))).toEqual(head);
    expect(
      execFileSync('git', ['--git-dir', foreign, 'rev-list', '--all', '--count'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('0');
    await rm(foreign, { recursive: true, force: true });
    expect(
      execFileSync('git', ['rev-list', '--all', '--count'], {
        cwd: manifest.repository,
        encoding: 'utf8',
      }).trim(),
    ).toBe('2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
