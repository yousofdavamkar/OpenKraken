import { _electron as electron, expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
import { lfsRemote } from '../../packages/test-fixtures/src/lfs-remote.js';

const hasLfs = spawnSync('git', ['lfs', 'version']).status === 0;
if (process.env.OPENKRAKEN_LFS_TEST === '1' && !hasLfs)
  throw new Error('LFS acceptance requires git-lfs on PATH');

for (const outcome of ['authenticated', 'rejected', 'cancelled'] as const) {
  test(`reviewed Push handles ${outcome} LFS upload through the installed hook`, async () => {
    test.skip(!hasLfs, 'Install git-lfs to run native LFS acceptance');
    const remote = await lfsRemote({ authenticated: outcome === 'authenticated' });
    const root = mkdtempSync(join(tmpdir(), 'openkraken-lfs-push-ui-'));
    const local = createFixture(join(root, 'local'));
    const bare = join(root, 'remote.git');
    fixtureGit(local, ['clone', '--bare', '.', bare]);
    fixtureGit(local, ['remote', 'set-url', 'origin', bare]);
    fixtureGit(local, ['lfs', 'install', '--local']);
    fixtureGit(local, ['lfs', 'track', '*.bin']);
    fixtureGit(local, ['config', 'lfs.url', remote.url]);
    fixtureGit(local, ['config', 'credential.helper', '']);
    fixtureGit(local, ['config', 'lfs.transfer.maxretries', '1']);
    fixtureGit(local, ['config', 'lfs.transfer.maxretrydelay', '0']);
    const content = Buffer.from('LFS upload from the desktop Push dialog\n');
    const oid = createHash('sha256').update(content).digest('hex');
    writeFileSync(join(local, 'asset.bin'), content);
    fixtureGit(local, ['add', '.']);
    fixtureGit(local, ['commit', '-m', 'Publish LFS content']);
    const before = fixtureGit(bare, ['rev-parse', 'main']);
    const tip = fixtureGit(local, ['rev-parse', 'HEAD']);
    const app = await electron.launch({
      args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
    });
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, local);
      await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
      await page.getByRole('button', { name: 'Push', exact: true }).click();
      const push = page.getByRole('dialog', { name: 'Push to remote', exact: true });
      await push.getByRole('button', { name: 'Review push', exact: true }).click();
      await expect(push.getByRole('region', { name: 'Reviewed push' })).toContainText(tip);
      expect(remote.events).toEqual([]);
      if (outcome === 'rejected') remote.setUploadMode('reject');
      if (outcome === 'cancelled') remote.setUploadMode('stall');
      await push.getByRole('button', { name: 'Push reviewed tip', exact: true }).click();
      const completed = push.getByText('Push completed', { exact: true });
      if (outcome === 'authenticated') {
        const auth = page.getByRole('dialog', { name: 'Git authentication', exact: true });
        let prompts = 0;
        // Native locks verification and batch requests may each ask for credentials.
        for (let attempt = 0; attempt < 4; attempt++) {
          const username = auth.getByLabel('Username', { exact: true });
          await expect(username.or(completed)).toBeVisible();
          if (await completed.isVisible()) break;
          prompts++;
          await username.fill(remote.credentials.username);
          await auth.getByRole('button', { name: 'Continue', exact: true }).click();
          const secret = auth.getByLabel('Password or passphrase', { exact: true });
          await expect(secret).toHaveAttribute('type', 'password');
          await secret.fill(remote.credentials.password);
          await auth.getByRole('button', { name: 'Continue', exact: true }).click();
        }
        expect(prompts).toBeGreaterThan(0);
        await expect(completed).toBeVisible();
        await expect(auth).toHaveCount(0);
        expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
          remote.credentials.password,
        );
      } else {
        if (outcome === 'cancelled') {
          await remote.uploadStarted;
          await push.getByRole('button', { name: 'Cancel operation', exact: true }).click();
          await expect(push.getByRole('status')).toContainText('Push cancelled');
          await expect(push.getByRole('status')).toContainText('server may have received updates');
        } else {
          await expect(push.getByRole('alert')).toContainText('Fixture upload denied');
        }
        await expect(completed).toHaveCount(0);
        expect(remote.uploads.size).toBe(0);
        expect(fixtureGit(bare, ['rev-parse', 'main'])).toBe(before);
        expect(fixtureGit(local, ['rev-parse', 'HEAD'])).toBe(tip);
        expect(readFileSync(join(local, 'asset.bin'))).toEqual(content);
        remote.setUploadMode('accept');
        await push.getByRole('button', { name: 'Review again', exact: true }).click();
        await push.getByRole('button', { name: 'Review push', exact: true }).click();
        await push.getByRole('button', { name: 'Push reviewed tip', exact: true }).click();
        await expect(completed).toBeVisible();
      }
      expect(remote.uploads.get(oid)).toEqual(content);
      expect(fixtureGit(bare, ['rev-parse', 'main'])).toBe(tip);
      expect(fixtureGit(bare, ['show', 'main:asset.bin'])).toContain(`oid sha256:${oid}`);
      expect(readFileSync(join(local, 'asset.bin'))).toEqual(content);
      await expect(push.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
      if (outcome === 'authenticated')
        await page.screenshot({ path: 'test-results/lfs-ordinary-push.png' });
    } finally {
      await app.close();
      await remote.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
