import { _electron as electron, expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

const hasLfs = spawnSync('git', ['lfs', 'version']).status === 0;
if (process.env.OPENKRAKEN_LFS_TEST === '1' && !hasLfs)
  throw new Error('LFS acceptance requires git-lfs on PATH');

test('LFS setup reviews scope, cancels, rejects stale config and installs without downloading', async () => {
  test.skip(!hasLfs, 'Install git-lfs to run native LFS acceptance');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-lfs-setup-ui-'));
  const local = createFixture(join(root, 'local'));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  fixtureGit(local, ['config', 'lfs.url', `http://127.0.0.1:${address.port}/lfs`]);
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 20\n`;
  writeFileSync(join(local, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  writeFileSync(join(local, 'asset.bin'), pointer);
  fixtureGit(local, ['add', '.']);
  fixtureGit(local, ['commit', '-m', 'Existing pointer']);
  const globalFile = join(root, 'global-config');
  const globalContent = '[user]\n\tname = Retained global user\n';
  writeFileSync(globalFile, globalContent);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
    env: { ...process.env, GIT_CONFIG_GLOBAL: globalFile, GIT_CONFIG_NOSYSTEM: '1' },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, local);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Git LFS', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Git LFS', exact: true });
    const setup = dialog.getByRole('button', { name: 'Review local setup', exact: true });
    await expect(setup).toBeEnabled();
    const config = readFileSync(join(local, '.git/config'));
    const index = readFileSync(join(local, '.git/index'));
    const head = fixtureGit(local, ['rev-parse', 'HEAD']);
    await dialog.getByRole('checkbox', { name: 'Leave pointers during checkout' }).check();
    await setup.click();
    const review = dialog.getByRole('group', { name: 'Review LFS setup', exact: true });
    await expect(review).toContainText(join(local, '.git/config'));
    await expect(review).toContainText(join(local, '.git/hooks'));
    await expect(review).toContainText('Leave LFS pointers');
    await expect(review.getByRole('button', { name: 'Cancel setup review' })).toBeFocused();
    expect(readFileSync(join(local, '.git/config'))).toEqual(config);
    await review.getByRole('button', { name: 'Cancel setup review' }).click();
    await expect(setup).toBeFocused();
    await setup.click();
    await expect(review).toBeVisible();
    fixtureGit(local, ['config', 'lfs.concurrenttransfers', '2']);
    await review.getByRole('button', { name: 'Apply LFS setup' }).click();
    await expect(dialog.getByRole('alert')).toContainText('changed');
    await expect(review).toHaveCount(0);
    expect(fixtureGit(local, ['config', '--local', '--list'])).not.toContain('filter.lfs.process');
    await setup.click();
    await expect(review).toBeVisible();
    await page.screenshot({ path: 'test-results/lfs-setup-review.png' });
    await review.getByRole('button', { name: 'Apply LFS setup' }).click();
    await expect(dialog.getByRole('status')).toContainText('LFS setup complete');
    await expect(setup).toBeEnabled();
    expect(fixtureGit(local, ['config', '--local', 'filter.lfs.process'])).toBe(
      'git-lfs filter-process --skip',
    );
    expect(readFileSync(join(local, '.git/hooks/pre-push'), 'utf8')).toContain('git lfs pre-push');
    expect(readFileSync(join(local, 'asset.bin'), 'utf8')).toBe(pointer);
    expect(readFileSync(join(local, '.git/index'))).toEqual(index);
    expect(fixtureGit(local, ['rev-parse', 'HEAD'])).toBe(head);
    expect(readFileSync(globalFile, 'utf8')).toBe(globalContent);
    expect(requests).toBe(0);
    const refresh = dialog.getByRole('button', { name: 'Refresh local state', exact: true });
    await refresh.click();
    await expect(refresh).toBeEnabled();
    await expect(refresh).toBeFocused();
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('LFS setup preserves a custom hook and recovers after the owner resolves its conflict', async () => {
  test.skip(!hasLfs, 'Install git-lfs to run native LFS acceptance');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-lfs-hook-ui-'));
  const local = createFixture(join(root, 'local'));
  const path = join(local, '.git/hooks/post-merge');
  const hook = '#!/bin/sh\necho custom merge hook\n';
  writeFileSync(path, hook, { mode: 0o755 });
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, local);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Git LFS', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Git LFS', exact: true });
    const setup = dialog.getByRole('button', { name: 'Review local setup', exact: true });
    await expect(setup).toBeEnabled();
    const config = readFileSync(join(local, '.git/config'));
    await setup.click();
    await expect(dialog.getByRole('alert')).toContainText('Hook already exists');
    expect(readFileSync(path, 'utf8')).toBe(hook);
    expect(readFileSync(join(local, '.git/config'))).toEqual(config);
    await expect(dialog.getByRole('button', { name: 'Apply LFS setup' })).toHaveCount(0);
    // The owner resolves the conflict outside the application, retaining the custom script.
    writeFileSync(join(root, 'saved-custom-hook'), hook);
    rmSync(path);
    await setup.click();
    await dialog.getByRole('button', { name: 'Apply LFS setup' }).click();
    await expect(dialog.getByRole('status')).toContainText('LFS setup complete');
    expect(readFileSync(join(root, 'saved-custom-hook'), 'utf8')).toBe(hook);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
