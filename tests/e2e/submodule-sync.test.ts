import { _electron as electron, expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('reviewed submodule URL synchronization preserves local work and recovers from stale reviews and write failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-submodule-sync-ui-'));
  const source = createFixture(join(root, 'source'));
  const parent = createFixture(join(root, 'parent'));
  fixtureGit(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child']);
  fixtureGit(parent, ['commit', '-am', 'Register child']);
  const child = join(parent, 'child');
  writeFileSync(join(child, 'tracked.txt'), 'local draft stays here\n');
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const destination = `http://127.0.0.1:${address.port}/new-child.git`;
  fixtureGit(parent, ['config', '--file', '.gitmodules', 'submodule.child.url', destination]);
  const before = [parent, child].map((path) => ({
    path,
    head: fixtureGit(path, ['rev-parse', 'HEAD']),
    index: fixtureGit(path, ['ls-files', '--stage']),
  }));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, parent);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Submodules', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Submodules', exact: true });
    const prepare = dialog.getByRole('button', { name: 'Review URL sync', exact: true });
    await prepare.click();
    const review = dialog.getByRole('group', {
      name: 'Review submodule URL synchronization',
      exact: true,
    });
    await expect(review).toContainText(destination);
    await expect(review).toContainText(source);
    await expect(review.getByRole('button', { name: 'Cancel URL review' })).toBeFocused();
    await review.getByRole('button', { name: 'Cancel URL review' }).click();
    await expect(prepare).toBeFocused();
    expect(fixtureGit(parent, ['config', 'submodule.child.url'])).toBe(source);
    await prepare.click();
    await expect(review).toBeVisible();
    fixtureGit(parent, ['config', 'submodule.child.url', 'https://example.test/external.git']);
    await review.getByRole('button', { name: 'Synchronize URLs', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('changed');
    await expect(review).toHaveCount(0);
    await prepare.click();
    await expect(review).toContainText('https://example.test/external.git');
    writeFileSync(join(parent, '.git/config.lock'), 'external write');
    await review.getByRole('button', { name: 'Synchronize URLs', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText(
      'Some URL settings may already have changed',
    );
    expect(fixtureGit(parent, ['config', 'submodule.child.url'])).toBe(
      'https://example.test/external.git',
    );
    rmSync(join(parent, '.git/config.lock'));
    await prepare.click();
    await expect(review).toBeVisible();
    await page.screenshot({ path: 'test-results/submodule-url-review.png' });
    await review.getByRole('button', { name: 'Synchronize URLs', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Submodule URLs synchronized');
    await expect(prepare).toBeFocused();
    expect(fixtureGit(parent, ['config', 'submodule.child.url'])).toBe(destination);
    expect(fixtureGit(child, ['config', 'remote.origin.url'])).toBe(destination);
    expect(readFileSync(join(child, 'tracked.txt'), 'utf8')).toBe('local draft stays here\n');
    expect(requests).toBe(0);
    for (const entry of before) {
      expect(fixtureGit(entry.path, ['rev-parse', 'HEAD'])).toBe(entry.head);
      expect(fixtureGit(entry.path, ['ls-files', '--stage'])).toBe(entry.index);
    }
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
