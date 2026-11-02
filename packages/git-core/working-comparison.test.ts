import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepositoryService } from './src/repository.js';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-working-comparison-'));
afterAll(() => rm(root, { recursive: true, force: true }));
test('rich working comparisons distinguish HEAD, index and working contents without staging', async () => {
  const path = createFixture(join(root, 'three-versions'));
  await writeFile(join(path, 'file.txt'), 'base\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Base']);
  await writeFile(join(path, 'file.txt'), 'staged\n');
  fixtureGit(path, ['add', '.']);
  await writeFile(join(path, 'file.txt'), 'working\n');
  const tree = fixtureGit(path, ['write-tree']),
    status = fixtureGit(path, ['status', '--porcelain']);
  const service = new RepositoryService('git', { dataDir: join(root, 'profile') });
  try {
    const repo = await service.open(path),
      pathBytes = Buffer.from('file.txt').toString('base64');
    const staged = await service.workingComparison(repo.id, { pathBytes, side: 'index' });
    expect(staged.oldVersion.text).toBe('base\n');
    expect(staged.newVersion.text).toBe('staged\n');
    const working = await service.workingComparison(repo.id, { pathBytes, side: 'worktree' });
    expect(working.oldVersion.text).toBe('staged\n');
    expect(working.newVersion.text).toBe('working\n');
    expect(working.hunks[0]?.lines.map((line) => [line.kind, line.text])).toEqual([
      ['del', 'staged'],
      ['add', 'working'],
    ]);
    expect(fixtureGit(path, ['write-tree'])).toBe(tree);
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe(status);
  } finally {
    await service.dispose();
  }
});

test('working comparisons use native clean-filter output and preserve untracked and non-newline contents', async () => {
  const path = createFixture(join(root, 'filtered'));
  const filter = join(root, 'lowercase.cjs');
  await writeFile(
    filter,
    "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => input += value); process.stdin.on('end', () => process.stdout.write(input.toLowerCase()));\n",
  );
  fixtureGit(path, ['config', 'filter.lowercase.clean', `"${process.execPath}" "${filter}"`]);
  await writeFile(join(path, '.gitattributes'), '*.txt filter=lowercase\n');
  await writeFile(join(path, 'filtered.txt'), 'BASE\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Filtered baseline']);
  await writeFile(join(path, 'filtered.txt'), 'WORKING');
  await writeFile(join(path, 'untracked.txt'), 'NEW\n');
  const tree = fixtureGit(path, ['write-tree']);
  const service = new RepositoryService('git', { dataDir: join(root, 'filtered-profile') });
  try {
    const repo = await service.open(path);
    const compare = (name: string) =>
      service.workingComparison(repo.id, {
        pathBytes: Buffer.from(name).toString('base64'),
        side: 'worktree',
      });
    const filtered = await compare('filtered.txt');
    expect(filtered.oldVersion.text).toBe('base\n');
    expect(filtered.newVersion.text).toBe('working');
    expect(filtered.hunks[0]?.lines.at(-1)).toMatchObject({
      kind: 'add',
      text: 'working',
      noNewline: true,
    });
    const untracked = await compare('untracked.txt');
    expect(untracked.oldVersion.kind).toBe('missing');
    expect(untracked.newVersion.text).toBe('new\n');
    expect(fixtureGit(path, ['write-tree'])).toBe(tree);
    expect(fixtureGit(path, ['ls-files', '--', 'untracked.txt'])).toBe('');
  } finally {
    await service.dispose();
  }
});

test('an explicitly loaded large working comparison retains a long unchanged prefix', async () => {
  const path = createFixture(join(root, 'large-prefix'));
  const prefix = 'unchanged\n'.repeat(249999);
  await writeFile(join(path, 'large.txt'), prefix + 'before\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Large baseline']);
  await writeFile(join(path, 'large.txt'), prefix + 'after\n');
  const service = new RepositoryService('git', { dataDir: join(root, 'large-profile') });
  try {
    const repo = await service.open(path);
    const result = await service.workingComparison(repo.id, {
      pathBytes: Buffer.from('large.txt').toString('base64'),
      side: 'worktree',
      allowLarge: true,
    });
    expect(result.newVersion.lines).toBe(250000);
    expect(result.newVersion.text?.endsWith('unchanged\nafter\n')).toBe(true);
    expect(result.hunks[0]?.lines.at(-1)).toMatchObject({ kind: 'add', text: 'after' });
  } finally {
    await service.dispose();
  }
});
