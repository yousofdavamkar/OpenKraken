import { afterAll, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-submodule-sync-'));
afterAll(() => rm(root, { recursive: true, force: true }));
function add(parent: string, source: string, path: string) {
  fixtureGit(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--', source, path]);
  fixtureGit(parent, ['commit', '-am', 'Register submodule']);
}

test('sync uses native relative URL and branch remote resolution, skips unregistered modules and redacts source credentials', async () => {
  const source = createFixture(join(root, 'relative-source'));
  const parent = createFixture(join(root, 'relative-parent'));
  add(parent, source, 'active');
  add(parent, source, 'inactive');
  fixtureGit(parent, ['submodule', 'deinit', '--', 'inactive']);
  fixtureGit(parent, ['remote', 'set-url', 'origin', 'https://example.test/team/super.git']);
  fixtureGit(parent, ['config', '--file', '.gitmodules', 'submodule.active.url', '../changed.git']);
  const child = join(parent, 'active');
  fixtureGit(child, ['checkout', '-b', 'local']);
  fixtureGit(child, [
    'remote',
    'add',
    'upstream',
    'https://fixture-user:fixture-secret@example.test/old.git',
  ]);
  fixtureGit(child, ['config', 'branch.local.remote', 'upstream']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(parent);
    const review = await service.submoduleSyncPreview(repo.id);
    expect(review.entries.find((entry) => entry.path === 'inactive')?.registered).toBe(false);
    expect(JSON.stringify(review)).not.toContain('fixture-secret');
    await service.syncSubmodules(repo.id, review.token);
    expect(fixtureGit(parent, ['config', 'submodule.active.url'])).toBe(
      'https://example.test/team/changed.git',
    );
    expect(fixtureGit(child, ['config', 'remote.upstream.url'])).toBe(
      'https://example.test/team/changed.git',
    );
    expect(fixtureGit(child, ['config', 'remote.origin.url'])).toBe(source);
    expect(fixtureGit(parent, ['config', '--local', '--list'])).not.toContain(
      'submodule.inactive.url',
    );
    await expect(readFile(join(parent, 'inactive/.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await service.dispose();
  }
});

test.each(['declaration', 'remote', 'branch'] as const)(
  'sync refuses a stale %s review before changing URLs',
  async (change) => {
    const source = createFixture(join(root, `stale-source-${change}`));
    const parent = createFixture(join(root, `stale-parent-${change}`));
    add(parent, source, 'child');
    const child = join(parent, 'child');
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(parent);
      const other = await service.open(source);
      const review = await service.submoduleSyncPreview(repo.id);
      await expect(service.syncSubmodules(other.id, review.token)).rejects.toMatchObject({
        code: 'STALE_SUBMODULE_SYNC',
      });
      if (change === 'declaration')
        fixtureGit(parent, [
          'config',
          '--file',
          '.gitmodules',
          'submodule.child.url',
          'https://example.test/changed.git',
        ]);
      if (change === 'remote')
        fixtureGit(child, ['remote', 'set-url', 'origin', 'https://example.test/override.git']);
      if (change === 'branch') fixtureGit(child, ['checkout', '-b', 'another']);
      const config = await readFile(join(parent, '.git/config'));
      await expect(service.syncSubmodules(repo.id, review.token)).rejects.toMatchObject({
        code: 'STALE_SUBMODULE_SYNC',
      });
      expect(await readFile(join(parent, '.git/config'))).toEqual(config);
      await expect(service.syncSubmodules(repo.id, review.token)).rejects.toMatchObject({
        code: 'STALE_SUBMODULE_SYNC',
      });
    } finally {
      await service.dispose();
    }
  },
);

test('a failed native sync consumes the review and supports a new review after recovery', async () => {
  const source = createFixture(join(root, 'failed-source'));
  const parent = createFixture(join(root, 'failed-parent'));
  add(parent, source, 'child');
  fixtureGit(parent, [
    'config',
    '--file',
    '.gitmodules',
    'submodule.child.url',
    'https://example.test/new.git',
  ]);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(parent);
    const review = await service.submoduleSyncPreview(repo.id);
    await writeFile(join(parent, '.git/config.lock'), 'external write');
    await expect(service.syncSubmodules(repo.id, review.token)).rejects.toThrow();
    expect(fixtureGit(parent, ['config', 'submodule.child.url'])).toBe(source);
    await rm(join(parent, '.git/config.lock'));
    await expect(service.syncSubmodules(repo.id, review.token)).rejects.toMatchObject({
      code: 'STALE_SUBMODULE_SYNC',
    });
    await service.syncSubmodules(repo.id, (await service.submoduleSyncPreview(repo.id)).token);
    expect(fixtureGit(parent, ['config', 'submodule.child.url'])).toBe(
      'https://example.test/new.git',
    );
  } finally {
    await service.dispose();
  }
});

test.skipIf(process.platform === 'win32')(
  'sync refuses redirected repository configuration',
  async () => {
    const source = createFixture(join(root, 'redirect-source'));
    const parent = createFixture(join(root, 'redirect-parent'));
    add(parent, source, 'child');
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(parent);
      const configPath = join(parent, '.git/config');
      const target = join(root, 'redirect-config');
      await rename(configPath, target);
      await symlink(target, configPath);
      const before = await readFile(target);
      await expect(service.submoduleSyncPreview(repo.id)).rejects.toMatchObject({
        code: 'SUBMODULE_SYNC_CONFIG',
      });
      expect(await readFile(target)).toEqual(before);
    } finally {
      await service.dispose();
    }
  },
);

test('reviewed recursive URL sync preserves dirty files, staged changes and checked-out commits', async () => {
  const leaf = createFixture(join(root, 'leaf'));
  const child = createFixture(join(root, 'child'));
  add(child, leaf, 'nested');
  const parent = createFixture(join(root, 'parent'));
  add(parent, child, 'child[1]');
  fixtureGit(parent, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'update',
    '--init',
    '--recursive',
  ]);
  const checkout = join(parent, 'child[1]');
  const nested = join(checkout, 'nested');
  fixtureGit(parent, [
    'config',
    '--file',
    '.gitmodules',
    'submodule.child[1].url',
    'https://example.test/new-child.git',
  ]);
  fixtureGit(checkout, [
    'config',
    '--file',
    '.gitmodules',
    'submodule.nested.url',
    'https://example.test/new-leaf.git',
  ]);
  await writeFile(join(checkout, 'tracked.txt'), 'staged work\n');
  fixtureGit(checkout, ['add', 'tracked.txt']);
  await writeFile(join(checkout, 'tracked.txt'), 'unstaged work\n');
  const before = [parent, checkout, nested].map((path) => ({
    path,
    head: fixtureGit(path, ['rev-parse', 'HEAD']),
    index: fixtureGit(path, ['ls-files', '--stage']),
  }));
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(parent);
    const review = await service.submoduleSyncPreview(repo.id);
    expect(review.entries.map((entry) => entry.path)).toEqual(['child[1]', 'child[1]/nested']);
    expect(review.entries[0]).toMatchObject({
      configuredUrl: child,
      declaredUrl: 'https://example.test/new-child.git',
    });
    expect(fixtureGit(parent, ['config', 'submodule.child[1].url'])).toBe(child);
    await service.syncSubmodules(repo.id, review.token);
    expect(fixtureGit(parent, ['config', 'submodule.child[1].url'])).toBe(
      'https://example.test/new-child.git',
    );
    expect(fixtureGit(checkout, ['config', 'remote.origin.url'])).toBe(
      'https://example.test/new-child.git',
    );
    expect(fixtureGit(checkout, ['config', 'submodule.nested.url'])).toBe(
      'https://example.test/new-leaf.git',
    );
    expect(fixtureGit(nested, ['config', 'remote.origin.url'])).toBe(
      'https://example.test/new-leaf.git',
    );
    for (const entry of before) {
      expect(fixtureGit(entry.path, ['rev-parse', 'HEAD'])).toBe(entry.head);
      expect(fixtureGit(entry.path, ['ls-files', '--stage'])).toBe(entry.index);
    }
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('unstaged work\n');
    expect(fixtureGit(checkout, ['show', ':tracked.txt'])).toBe('staged work');
    await expect(service.syncSubmodules(repo.id, review.token)).rejects.toMatchObject({
      code: 'STALE_SUBMODULE_SYNC',
    });
  } finally {
    await service.dispose();
  }
});
