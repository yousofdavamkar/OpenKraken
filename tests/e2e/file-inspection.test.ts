import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
test('commit details list changed files against the selected merge parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-files-ui-'));
  const path = createFixture(join(root, 'repository'));
  fixtureGit(path, ['switch', '-c', 'incoming']);
  writeFileSync(join(path, 'incoming.txt'), 'incoming\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Incoming file']);
  const incoming = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['switch', 'main']);
  writeFileSync(join(path, 'local.txt'), 'local\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Local file']);
  fixtureGit(path, ['merge', '--no-ff', '--no-edit', 'incoming']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const grid = page.getByRole('grid', { name: 'Commit history' });
    await grid.press('Home');
    await grid.press('Enter');
    const details = page.getByRole('region', { name: 'Commit details' });
    const files = details.getByRole('list', { name: 'Changed files' });
    await expect(files.getByText('incoming.txt', { exact: true })).toBeVisible();
    await details.getByRole('combobox', { name: 'Compare parent' }).selectOption(incoming);
    await expect(files.getByText('local.txt', { exact: true })).toBeVisible();
    await expect(files.getByText('incoming.txt', { exact: true })).toHaveCount(0);
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
