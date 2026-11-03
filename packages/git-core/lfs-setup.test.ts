import { afterAll, expect, test, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, symlink, rename, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';

const hasLfs = spawnSync('git', ['lfs', 'version']).status === 0;
if (process.env.OPENKRAKEN_LFS_TEST === '1' && !hasLfs)
  throw new Error('LFS acceptance requires git-lfs on PATH');
const root = await mkdtemp(join(tmpdir(), 'openkraken-lfs-setup-'));
afterAll(() => rm(root, { recursive: true, force: true }));

test.skipIf(!hasLfs)(
  'setup detects an included standard filter that still overrides the requested checkout mode',
  async () => {
    const local = createFixture(join(root, 'overridden-mode'));
    fixtureGit(local, ['lfs', 'install', '--local']);
    const included = join(local, '.git/included-config');
    const retained = '[filter "lfs"]\nprocess = git-lfs filter-process --skip\n';
    await writeFile(included, retained);
    fixtureGit(local, ['config', '--add', 'include.path', 'included-config']);
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(local);
      const review = await service.lfsSetupPreview(repo.id, false);
      await expect(service.lfsSetup(repo.id, review.token)).rejects.toMatchObject({
        code: 'LFS_SETUP_OVERRIDDEN',
      });
      expect(await readFile(included, 'utf8')).toBe(retained);
    } finally {
      await service.dispose();
    }
  },
);

test.skipIf(!hasLfs)(
  'setup reviews a configured hook directory and refuses expired tokens',
  async () => {
    const local = createFixture(join(root, 'custom-location'));
    fixtureGit(local, ['config', 'core.hooksPath', 'custom hooks/雪']);
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(local);
      const review = await service.lfsSetupPreview(repo.id, false);
      expect(review.hooksPath).toBe(join(local, 'custom hooks/雪'));
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001);
      try {
        await expect(service.lfsSetup(repo.id, review.token)).rejects.toMatchObject({
          code: 'STALE_LFS_SETUP',
        });
      } finally {
        clock.mockRestore();
      }
      const next = await service.lfsSetupPreview(repo.id, false);
      await service.lfsSetup(repo.id, next.token);
      expect(await readFile(join(next.hooksPath, 'pre-push'), 'utf8')).toContain(
        'git lfs pre-push',
      );
      await expect(readFile(join(local, '.git/hooks/pre-push'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await service.dispose();
    }
  },
);

test.skipIf(!hasLfs)(
  'setup diagnoses conflicts from relative included filter configuration before changing files',
  async () => {
    const local = createFixture(join(root, 'included-filter'));
    fixtureGit(local, ['lfs', 'install', '--local']);
    const included = join(local, '.git/included-config');
    await writeFile(included, '[filter "lfs"]\nprocess = custom-process\n');
    fixtureGit(local, ['config', '--add', 'include.path', 'included-config']);
    const before = await readFile(join(local, '.git/config'));
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(local);
      await expect(service.lfsSetupPreview(repo.id, false)).rejects.toMatchObject({
        code: 'LFS_SETUP_CONFLICT',
        message: expect.stringContaining('attribute'),
      });
      expect(await readFile(join(local, '.git/config'))).toEqual(before);
      expect(await readFile(included, 'utf8')).toBe('[filter "lfs"]\nprocess = custom-process\n');
    } finally {
      await service.dispose();
    }
  },
);

test.skipIf(!hasLfs || process.platform === 'win32')(
  'setup refuses to report success for an existing disabled LFS hook',
  async () => {
    const local = createFixture(join(root, 'disabled-hook'));
    fixtureGit(local, ['lfs', 'install', '--local']);
    await chmod(join(local, '.git/hooks/pre-push'), 0o644);
    const before = await readFile(join(local, '.git/config'));
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(local);
      await expect(service.lfsSetupPreview(repo.id, false)).rejects.toMatchObject({
        code: 'LFS_HOOK_PERMISSIONS',
      });
      expect(await readFile(join(local, '.git/config'))).toEqual(before);
    } finally {
      await service.dispose();
    }
  },
);

test.skipIf(!hasLfs).each(['config', 'hook'] as const)(
  'setup consumes a review after %s changes and preserves the external change',
  async (change) => {
    const local = createFixture(join(root, `stale-${change}`));
    const other = createFixture(join(root, `other-${change}`));
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(local);
      const foreign = await service.open(other);
      const review = await service.lfsSetupPreview(repo.id, false);
      await expect(service.lfsSetup(foreign.id, review.token)).rejects.toMatchObject({
        code: 'STALE_LFS_SETUP',
      });
      if (change === 'config') fixtureGit(local, ['config', 'lfs.concurrenttransfers', '3']);
      else
        await writeFile(
          join(review.hooksPath, 'post-commit'),
          '#!/bin/sh\necho externally added\n',
        );
      const config = await readFile(review.configPath);
      await expect(service.lfsSetup(repo.id, review.token)).rejects.toMatchObject({
        code: 'STALE_LFS_SETUP',
      });
      expect(await readFile(review.configPath)).toEqual(config);
      await expect(readFile(join(review.hooksPath, 'pre-push'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(service.lfsSetup(repo.id, review.token)).rejects.toMatchObject({
        code: 'STALE_LFS_SETUP',
      });
    } finally {
      await service.dispose();
    }
  },
);

test.skipIf(!hasLfs || process.platform === 'win32')(
  'setup rejects redirected config and hook files without changing their targets',
  async () => {
    const local = createFixture(join(root, 'redirected'));
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(local);
      const configPath = join(repo.commonDir, 'config');
      const target = join(root, 'redirected-config');
      const before = await readFile(configPath);
      await rename(configPath, target);
      await symlink(target, configPath);
      await expect(service.lfsSetupPreview(repo.id, false)).rejects.toMatchObject({
        code: 'LFS_SETUP_PATH',
      });
      expect(await readFile(target)).toEqual(before);
      await rm(configPath);
      await rename(target, configPath);
      const hookTarget = join(root, 'redirected-hook');
      await writeFile(hookTarget, '#!/bin/sh\ncustom\n');
      await symlink(hookTarget, join(repo.commonDir, 'hooks/pre-push'));
      await expect(service.lfsSetupPreview(repo.id, false)).rejects.toMatchObject({
        code: 'LFS_SETUP_PATH',
      });
      expect(await readFile(hookTarget, 'utf8')).toBe('#!/bin/sh\ncustom\n');
      expect(await readFile(configPath)).toEqual(before);
    } finally {
      await service.dispose();
    }
  },
);

test.skipIf(!hasLfs).each([false, true])(
  'linked worktree setup respects worktreeConfig=%s and supports changing checkout mode',
  async (worktreeConfig) => {
    const main = createFixture(join(root, `main-${worktreeConfig}`));
    const linked = join(root, `linked-${worktreeConfig}`);
    fixtureGit(main, ['worktree', 'add', '-b', 'linked', linked]);
    if (worktreeConfig) fixtureGit(main, ['config', 'extensions.worktreeConfig', 'true']);
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(linked);
      const review = await service.lfsSetupPreview(repo.id, true);
      expect(review.scope).toBe(worktreeConfig ? 'worktree' : 'repository');
      expect(review.hooksPath).toBe(join(main, '.git/hooks'));
      await service.lfsSetup(repo.id, review.token);
      expect(fixtureGit(linked, ['config', '--get', 'filter.lfs.process'])).toBe(
        'git-lfs filter-process --skip',
      );
      if (worktreeConfig)
        expect(fixtureGit(main, ['config', '--local', '--list'])).not.toContain(
          'filter.lfs.process',
        );
      else
        expect(fixtureGit(main, ['config', '--get', 'filter.lfs.process'])).toBe(
          'git-lfs filter-process --skip',
        );
      fixtureGit(linked, ['lfs', 'track', '*.bin']);
      await writeFile(join(linked, 'asset.bin'), 'cached LFS content\n');
      fixtureGit(linked, ['add', '.']);
      await rm(join(linked, 'asset.bin'));
      fixtureGit(linked, ['checkout', '--', 'asset.bin']);
      expect(await readFile(join(linked, 'asset.bin'), 'utf8')).toContain(
        'version https://git-lfs.github.com/spec/v1',
      );
      const next = await service.lfsSetupPreview(repo.id, false);
      await service.lfsSetup(repo.id, next.token);
      expect(fixtureGit(linked, ['config', '--get', 'filter.lfs.process'])).toBe(
        'git-lfs filter-process',
      );
      await rm(join(linked, 'asset.bin'));
      fixtureGit(linked, ['checkout', '--', 'asset.bin']);
      expect(await readFile(join(linked, 'asset.bin'), 'utf8')).toBe('cached LFS content\n');
    } finally {
      await service.dispose();
    }
  },
);

test.skipIf(!hasLfs).each(['hook', 'filter'] as const)(
  'setup refuses a custom %s before changing repository configuration or hooks',
  async (conflict) => {
    const local = createFixture(join(root, conflict));
    const customHook = '#!/bin/sh\necho custom integration\n';
    if (conflict === 'hook') await writeFile(join(local, '.git/hooks/post-merge'), customHook);
    else fixtureGit(local, ['config', 'filter.lfs.clean', 'custom-clean %f']);
    const before = await readFile(join(local, '.git/config'));
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(local);
      await expect(service.lfsSetupPreview(repo.id, false)).rejects.toThrow();
      expect(await readFile(join(local, '.git/config'))).toEqual(before);
      await expect(readFile(join(local, '.git/hooks/pre-push'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      if (conflict === 'hook')
        expect(await readFile(join(local, '.git/hooks/post-merge'), 'utf8')).toBe(customHook);
    } finally {
      await service.dispose();
    }
  },
);

test.skipIf(!hasLfs)(
  'reviewed local LFS setup installs working filters and hooks without changing checkout contents',
  async () => {
    const local = createFixture(join(root, 'local'));
    fixtureGit(local, ['config', 'lfs.https://fixture.invalid.access', 'private']);
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(local);
      const config = await readFile(join(repo.commonDir, 'config'));
      const index = await readFile(join(repo.gitDir, 'index'));
      const head = fixtureGit(local, ['rev-parse', 'HEAD']);
      const preview = await service.lfsSetupPreview(repo.id, false);
      expect(preview.scope).toBe('repository');
      expect(preview.configPath).toBe(join(repo.commonDir, 'config'));
      expect(preview.hooksPath).toBe(join(repo.commonDir, 'hooks'));
      expect(await readFile(preview.configPath)).toEqual(config);
      await expect(readFile(join(preview.hooksPath, 'pre-push'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await service.lfsSetup(repo.id, preview.token);
      expect(fixtureGit(local, ['config', '--local', 'filter.lfs.process'])).toBe(
        'git-lfs filter-process',
      );
      expect(fixtureGit(local, ['config', '--local', 'filter.lfs.required'])).toBe('true');
      for (const hook of ['pre-push', 'post-checkout', 'post-commit', 'post-merge'])
        expect(await readFile(join(preview.hooksPath, hook), 'utf8')).toContain(`git lfs ${hook}`);
      expect(await readFile(join(repo.gitDir, 'index'))).toEqual(index);
      expect(fixtureGit(local, ['rev-parse', 'HEAD'])).toBe(head);
      expect(await readFile(join(local, 'tracked.txt'), 'utf8')).toBe('base\n');
      fixtureGit(local, ['lfs', 'track', '*.bin']);
      await writeFile(join(local, 'asset.bin'), 'content through the installed filter\n');
      fixtureGit(local, ['add', '.']);
      expect(fixtureGit(local, ['show', ':asset.bin'])).toContain(
        'version https://git-lfs.github.com/spec/v1',
      );
      await expect(service.lfsSetup(repo.id, preview.token)).rejects.toMatchObject({
        code: 'STALE_LFS_SETUP',
      });
    } finally {
      await service.dispose();
    }
  },
);
