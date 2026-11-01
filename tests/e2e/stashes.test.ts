import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
test('stash selected files with untracked content and restore the workspace through Undo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-stashes-e2e-'));
  const repo = createFixture(join(root, 'repo'));
  writeFileSync(join(repo, 'tracked.txt'), 'stash me\n');
  writeFileSync(join(repo, 'new.txt'), 'new stash content\n');
  writeFileSync(join(repo, 'keep.txt'), 'keep here\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Stashes', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Stashes', exact: true });
    await dialog.getByRole('checkbox', { name: 'Include untracked files', exact: true }).check();
    await dialog.getByRole('checkbox', { name: 'Stash keep.txt', exact: true }).uncheck();
    await dialog.getByRole('textbox', { name: 'Stash message', exact: true }).fill('Desktop stash');
    await dialog.getByRole('button', { name: 'Stash selected files', exact: true }).click();
    await expect(dialog.getByText('On main: Desktop stash', { exact: true })).toBeVisible();
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('base\n');
    expect(existsSync(join(repo, 'new.txt'))).toBe(false);
    expect(readFileSync(join(repo, 'keep.txt'), 'utf8')).toBe('keep here\n');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('stash me\n');
    expect(readFileSync(join(repo, 'new.txt'), 'utf8')).toBe('new stash content\n');
    expect(fixtureGit(repo, ['stash', 'list'])).toContain('Desktop stash');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
