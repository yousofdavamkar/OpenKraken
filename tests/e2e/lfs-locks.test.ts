import { _electron as electron, expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

const hasLfs = spawnSync('git', ['lfs', 'version']).status === 0;
if (process.env.OPENKRAKEN_LFS_TEST === '1' && !hasLfs)
  throw new Error('LFS acceptance requires git-lfs on PATH');

test('server locks use native authentication, allow cancellation and distinguish an empty checked result', async () => {
  test.skip(!hasLfs, 'Install git-lfs to run native LFS acceptance');
  let authenticated = 0;
  const server = createServer((request, response) => {
    if (
      request.headers.authorization !==
      `Basic ${Buffer.from('fixture:lock-password').toString('base64')}`
    ) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="LFS locks"' });
      response.end();
      return;
    }
    authenticated++;
    response.writeHead(200, { 'Content-Type': 'application/vnd.git-lfs+json' });
    response.end(JSON.stringify({ locks: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-lfs-lock-auth-'));
  const path = createFixture(join(root, 'repo'));
  fixtureGit(path, ['config', 'lfs.url', `http://127.0.0.1:${address.port}/lfs`]);
  fixtureGit(path, ['config', 'credential.helper', '']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Git LFS', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Git LFS', exact: true });
    const refresh = dialog.getByRole('button', { name: 'Refresh server locks', exact: true });
    const auth = page.getByRole('dialog', { name: 'Git authentication', exact: true });
    await refresh.click();
    await expect(auth).toContainText('Refresh LFS server locks');
    await auth.getByRole('button', { name: 'Cancel operation', exact: true }).click();
    await expect(auth).toHaveCount(0);
    await expect(dialog.getByRole('alert')).toContainText('Server lock refresh cancelled');
    await expect(refresh).toBeEnabled();
    expect(authenticated).toBe(0);
    await refresh.click();
    await auth.getByLabel('Username', { exact: true }).fill('fixture');
    await auth.getByRole('button', { name: 'Continue', exact: true }).click();
    await auth.getByLabel('Password or passphrase', { exact: true }).fill('lock-password');
    await auth.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(auth).toHaveCount(0);
    const locks = dialog.getByRole('region', { name: 'Server LFS locks', exact: true });
    await expect(locks).toContainText('No locks were reported by this server at the last check.');
    expect(authenticated).toBe(1);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('lock-password');
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test('server lock snapshots show their source and time and are cleared on refresh failure or remote changes', async () => {
  test.skip(!hasLfs, 'Install git-lfs to run native LFS acceptance');
  let owner = 'First Owner';
  let broken = false;
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'Content-Type': 'application/vnd.git-lfs+json' });
    response.end(
      broken
        ? '{invalid json'
        : JSON.stringify({
            locks: [
              {
                id: 'lock',
                path: 'asset.bin',
                owner: { name: owner },
                locked_at: '2026-11-02T00:00:00Z',
              },
            ],
          }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const endpoint = `http://127.0.0.1:${address.port}/lfs`;
  const root = mkdtempSync(join(tmpdir(), 'openkraken-lfs-locks-ui-'));
  const path = createFixture(join(root, 'repo'));
  fixtureGit(path, ['config', 'lfs.url', endpoint]);
  writeFileSync(join(path, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  writeFileSync(
    join(path, 'asset.bin'),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 123\n`,
  );
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Tracked LFS pointer']);
  fixtureGit(path, ['remote', 'add', 'backup', 'https://backup.example.test/repo.git']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Git LFS', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Git LFS', exact: true });
    const refresh = dialog.getByRole('button', { name: 'Refresh server locks', exact: true });
    await expect(refresh).toBeEnabled();
    expect(requests).toBe(0);
    await refresh.click();
    const locks = dialog.getByRole('region', { name: 'Server LFS locks', exact: true });
    await expect(locks).toContainText('First Owner');
    const files = dialog.getByRole('list', { name: 'LFS tracked files', exact: true });
    await expect(files).toContainText('Lock reported at last check: First Owner');
    await expect(locks).toContainText('Remote: origin');
    await expect(locks).toContainText(endpoint);
    await expect(locks.locator('time')).toHaveAttribute('datetime', /T.*Z$/);
    owner = 'New Owner';
    await dialog.getByRole('button', { name: 'Refresh local state', exact: true }).click();
    await expect(locks).toHaveCount(0);
    await expect(files).toContainText('Server lock state unknown');
    expect(requests).toBe(1);
    await refresh.click();
    await expect(locks).toContainText('New Owner');
    await expect(files).toContainText('Lock reported at last check: New Owner');
    await page.screenshot({ path: 'test-results/lfs-server-locks.png' });
    await dialog.getByRole('combobox', { name: 'LFS remote', exact: true }).selectOption('backup');
    await expect(locks).toHaveCount(0);
    await refresh.click();
    await expect(locks).toContainText('Remote: backup');
    broken = true;
    await refresh.click();
    await expect(dialog.getByRole('alert')).toContainText('Server lock state is unknown');
    await expect(files).toContainText('Cached lock: New Owner');
    await expect(files).toContainText('Server lock state unknown');
    await expect(locks).toHaveCount(0);
    await expect(refresh).toBeEnabled();
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
});
