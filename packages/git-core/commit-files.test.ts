import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepositoryService } from './src/repository.js';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-commit-files-'));
afterAll(() => rm(root, { recursive: true, force: true }));
test('commit file lists preserve rename paths, modes and native blob IDs', async () => {
  const path = createFixture(join(root, 'files'));
  await writeFile(join(path, 'old name.txt'), 'rename this file\n'.repeat(20));
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Original files']);
  const parent = fixtureGit(path, ['rev-parse', 'HEAD']);
  const renamed = 'new name\tline\n.txt';
  // Windows cannot store tab/newline names; its fixture still exercises spaces.
  const name = process.platform === 'win32' ? 'new name.txt' : renamed;
  await rename(join(path, 'old name.txt'), join(path, name));
  await writeFile(join(path, 'tracked.txt'), 'modified content\n');
  await writeFile(join(path, 'binary.dat'), Buffer.from([0, 1, 255]));
  fixtureGit(path, ['add', '-A']);
  fixtureGit(path, ['commit', '-m', 'Rename and modify']);
  const oid = fixtureGit(path, ['rev-parse', 'HEAD']);
  const service = new RepositoryService('git', { dataDir: join(root, 'profile') });
  try {
    const repo = await service.open(path);
    const result = await service.commitFiles(repo.id, oid);
    expect(result).toMatchObject({ commit: oid, parent, parents: [parent] });
    expect(result.files).toHaveLength(3);
    const move = result.files.find((file) => file.status === 'renamed');
    expect(move).toMatchObject({
      oldPath: 'old name.txt',
      newPath: name,
      oldPathBytes: Buffer.from('old name.txt').toString('base64'),
      newPathBytes: Buffer.from(name).toString('base64'),
      oldMode: '100644',
      newMode: '100644',
    });
    expect(move?.oldOid).toBe(fixtureGit(path, ['rev-parse', `${parent}:old name.txt`]));
    expect(move?.newOid).toBe(move?.oldOid);
    expect(result.files.find((file) => file.newPath === 'binary.dat')).toMatchObject({
      status: 'added',
      oldMode: '000000',
      newMode: '100644',
      newOid: fixtureGit(path, ['rev-parse', 'HEAD:binary.dat']),
    });
    expect(result.files.find((file) => file.newPath === 'tracked.txt')).toMatchObject({
      status: 'modified',
      oldOid: fixtureGit(path, ['rev-parse', `${parent}:tracked.txt`]),
      newOid: fixtureGit(path, ['rev-parse', 'HEAD:tracked.txt']),
    });
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await service.dispose();
  }
});
test('root and merge commits compare against the explicitly selected native parent', async () => {
  const path = createFixture(join(root, 'parents'), 'linear', 2);
  const rootCommit = fixtureGit(path, ['rev-list', '--max-parents=0', 'HEAD']);
  fixtureGit(path, ['switch', '-c', 'incoming']);
  await writeFile(join(path, 'incoming.txt'), 'incoming\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Incoming']);
  const incoming = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['switch', 'main']);
  await writeFile(join(path, 'local.txt'), 'local\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Local']);
  const local = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['merge', '--no-ff', '--no-edit', 'incoming']);
  const merge = fixtureGit(path, ['rev-parse', 'HEAD']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const first = await service.commitFiles(repo.id, rootCommit);
    expect(first.parents).toEqual([]);
    expect(first.parent).toBeUndefined();
    expect(first.files).toMatchObject([
      { status: 'added', path: 'tracked.txt', oldMode: '000000', newMode: '100644' },
    ]);
    const main = await service.commitFiles(repo.id, merge);
    expect(main.parent).toBe(local);
    expect(main.parents).toEqual([local, incoming]);
    expect(main.files.map((file) => file.path)).toEqual(['incoming.txt']);
    const second = await service.commitFiles(repo.id, merge, incoming);
    expect(second.files.map((file) => file.path)).toEqual(['local.txt']);
    await expect(service.commitFiles(repo.id, merge, rootCommit)).rejects.toMatchObject({
      code: 'INVALID_PARENT',
    });
    fixtureGit(path, ['rm', 'incoming.txt']);
    fixtureGit(path, ['commit', '-m', 'Delete']);
    const deletion = await service.commitFiles(repo.id, fixtureGit(path, ['rev-parse', 'HEAD']));
    expect(deletion.files).toMatchObject([
      {
        status: 'deleted',
        path: 'incoming.txt',
        oldPath: 'incoming.txt',
        oldMode: '100644',
        newMode: '000000',
      },
    ]);
    expect(deletion.files[0]?.newOid).toBeUndefined();
  } finally {
    await service.dispose();
  }
});
