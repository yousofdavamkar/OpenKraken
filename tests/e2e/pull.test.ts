import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
test('pull defaults to ff-only, saves its selected policy and refreshes the current branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-pull-e2e-'));
  const source = createFixture(join(root, 'source'));
  const remote = join(root, 'remote.git');
  fixtureGit(source, ['clone', '--bare', '.', remote]);
  const local = join(root, 'local');
  fixtureGit(source, ['clone', remote, local]);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, local);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    fixtureGit(source, ['commit', '--allow-empty', '-m', 'Fetched through pull']);
    fixtureGit(source, ['push', remote, 'main']);
    await page.getByRole('button', { name: 'Pull', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Pull upstream', exact: true });
    await expect(dialog.getByRole('combobox', { name: 'Pull policy', exact: true })).toHaveValue(
      'ff-only',
    );
    await dialog.getByRole('button', { name: 'Fetch and integrate', exact: true }).click();
    await expect(dialog.getByText('Pull completed', { exact: true })).toBeVisible();
    expect(fixtureGit(local, ['rev-parse', 'HEAD'])).toBe(
      fixtureGit(source, ['rev-parse', 'HEAD']),
    );
    await dialog.getByRole('combobox', { name: 'Pull policy', exact: true }).selectOption('rebase');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(
      page
        .getByRole('grid', { name: 'Commit history' })
        .getByRole('gridcell', { name: /Fetched through pull/ }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Pull', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'Pull policy', exact: true })).toHaveValue(
      'rebase',
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
