import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
test('rich WIP comparisons return to reviewed line staging with the correct index base', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-working-compare-ui-'));
  const path = createFixture(join(root, 'repository'));
  writeFileSync(join(path, 'file.txt'), 'base\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Base']);
  writeFileSync(join(path, 'file.txt'), 'staged\n');
  fixtureGit(path, ['add', '.']);
  writeFileSync(join(path, 'file.txt'), 'working\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'View staged file.txt', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Working file changes' })
      .getByRole('button', { name: 'Full comparison' })
      .click();
    const viewer = page.getByRole('dialog', { name: 'File comparison' });
    await expect(viewer.getByText('base', { exact: true })).toBeVisible();
    await expect(viewer.getByText('staged', { exact: true })).toBeVisible();
    await viewer.getByRole('button', { name: 'Close comparison' }).click();
    await page.getByRole('button', { name: 'View unstaged file.txt', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Working file changes' })
      .getByRole('button', { name: 'Full comparison' })
      .click();
    await expect(viewer.getByText('staged', { exact: true })).toBeVisible();
    await expect(viewer.getByText('working', { exact: true })).toBeVisible();
    await viewer.getByRole('combobox', { name: 'Diff view' }).selectOption('split');
    await expect(viewer.locator('.cm-editor')).toHaveCount(2);
    await viewer.getByRole('button', { name: 'Select lines to stage', exact: true }).click();
    const selection = page.getByRole('dialog', { name: 'Working file changes' });
    await selection.getByRole('button', { name: 'Select all changes' }).click();
    await selection.getByRole('button', { name: 'Stage selected lines' }).click();
    await expect(selection).toHaveCount(0);
    expect(fixtureGit(path, ['show', ':file.txt'])).toBe('working');
    expect(fixtureGit(path, ['diff', '--name-only'])).toBe('');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
