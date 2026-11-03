import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('a failed initial snapshot can be reopened and observes subsequent native changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-watcher-startup-'));
  const repository = createFixture(join(root, 'repo'), 'linear', 10);
  const broken = join(repository, '.git', 'refs', 'tags', 'missing-object');
  writeFileSync(broken, `${'1'.repeat(40)}\n`);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    const failed = await page.evaluate(() =>
      window.openkraken.request({ id: crypto.randomUUID(), method: 'open' }),
    );
    expect(failed.kind).toBe('error');
    rmSync(broken);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByTestId('commit-graph')).toBeVisible();
    await expect(page.getByText('Watching for changes', { exact: true })).toBeVisible();
    fixtureGit(repository, ['branch', 'after-retry']);
    await expect(page.locator('.refs .ref', { hasText: 'after-retry' })).toBeVisible();
    writeFileSync(join(repository, 'after-retry.txt'), 'observed');
    await expect(
      page.getByRole('button', { name: 'Stage after-retry.txt', exact: true }),
    ).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
