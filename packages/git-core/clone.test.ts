import { afterAll, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-clone-'));
afterAll(() => rm(root, { recursive: true, force: true }));
test('clone supports shallow, sparse and blob-filtered repositories and reports native progress', async () => {
  const source = createFixture(join(root, 'source'));
  await mkdir(join(source, 'src dir'));
  await mkdir(join(source, 'docs'));
  await writeFile(join(source, 'src dir/app.txt'), 'selected directory\n');
  await writeFile(join(source, 'docs/readme.txt'), 'excluded directory\n');
  fixtureGit(source, ['add', '.']);
  fixtureGit(source, ['commit', '-m', 'Directories']);
  const remote = join(root, 'remote.git');
  fixtureGit(source, ['clone', '--bare', '.', remote]);
  fixtureGit(remote, ['config', 'uploadpack.allowFilter', 'true']);
  const target = join(root, 'target');
  await mkdir(target);
  const service = new RepositoryService('git');
  const progress: string[] = [];
  const repo = await service.clone(
    target,
    { url: remote, depth: 1, filter: 'blob:none', sparse: ['src dir'] },
    undefined,
    (line) => progress.push(line),
  );
  expect(repo.isShallow).toBe(true);
  expect(repo.isSparse).toBe(true);
  expect(fixtureGit(target, ['rev-list', '--count', 'HEAD'])).toBe('1');
  expect(fixtureGit(target, ['config', 'remote.origin.partialclonefilter'])).toBe('blob:none');
  expect(await readFile(join(target, 'src dir/app.txt'), 'utf8')).toBe('selected directory\n');
  await expect(readFile(join(target, 'docs/readme.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(progress.join('\n')).toMatch(/Cloning|Receiving|remote:/);
  expect((await service.snapshot(repo.id)).commits).toHaveLength(1);
  await service.dispose();
});
test('clone refuses nonempty destinations without touching existing files', async () => {
  const source = createFixture(join(root, 'protected-source'));
  const target = join(root, 'protected-target');
  await mkdir(target);
  await writeFile(join(target, 'keep.txt'), 'keep unchanged\n');
  const service = new RepositoryService('git');
  await expect(service.clone(target, { url: source })).rejects.toMatchObject({
    code: 'CLONE_DESTINATION_NOT_EMPTY',
  });
  expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('keep unchanged\n');
  await service.dispose();
});
test('clone supports a named branch and root-only sparse checkout', async () => {
  const source = createFixture(join(root, 'branch-source'));
  await mkdir(join(source, 'nested'));
  await writeFile(join(source, 'nested/file.txt'), 'nested\n');
  fixtureGit(source, ['add', '.']);
  fixtureGit(source, ['commit', '-m', 'Nested file']);
  fixtureGit(source, ['branch', 'topic']);
  const target = join(root, 'branch-target');
  await mkdir(target);
  const service = new RepositoryService('git');
  const repo = await service.clone(target, { url: source, branch: 'topic', sparse: [] });
  expect(repo.head).toMatchObject({ kind: 'branch', ref: 'refs/heads/topic' });
  expect(repo.isSparse).toBe(true);
  expect(await readFile(join(target, 'tracked.txt'), 'utf8')).toBe('base\n');
  await expect(readFile(join(target, 'nested/file.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await service.dispose();
});
test('clone cancellation stops an active transport and does not register an incomplete repository', async () => {
  const { createServer } = await import('node:http');
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const server = createServer(() => requested());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const target = join(root, 'cancel-target');
  await mkdir(target);
  const service = new RepositoryService('git');
  const controller = new AbortController();
  try {
    const pending = service.clone(
      target,
      { url: `http://127.0.0.1:${address.port}/repo.git` },
      controller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await started;
    controller.abort();
    await rejected;
    await expect(service.open(target)).rejects.toThrow();
  } finally {
    controller.abort();
    await service.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
