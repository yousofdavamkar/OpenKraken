import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
test('reopened native rebase shows progress and requires confirmation before abort', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-operation-e2e-'));
  const path = createFixture(join(root, 'repository'));
  fixtureGit(path, ['switch', '-c', 'incoming']);
  writeFileSync(join(path, 'tracked.txt'), 'incoming\n');
  fixtureGit(path, ['commit', '-am', 'Incoming version']);
  fixtureGit(path, ['switch', 'main']);
  writeFileSync(join(path, 'tracked.txt'), 'local\n');
  fixtureGit(path, ['commit', '-am', 'Local version']);
  const original = fixtureGit(path, ['rev-parse', 'HEAD']);
  expect(() => fixtureGit(path, ['rebase', 'incoming'])).toThrow();
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Git operation' });
    await expect(panel.getByRole('heading', { name: 'Rebase in progress' })).toBeVisible();
    await expect(panel.getByText('Step 1 of 1')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: 'Abort', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Abort rebase' });
    await confirmation.getByRole('button', { name: 'Keep working' }).click();
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Abort', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Abort rebase', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('head')).toHaveText('main');
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
