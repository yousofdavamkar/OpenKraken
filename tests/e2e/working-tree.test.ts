import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
test('working-tree buttons stage, unstage, undo and redo through the real Git service', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-working-e2e-'));
  const repo = createFixture(join(root, 'repo'));
  writeFileSync(join(repo, 'tracked.txt'), 'working edit\n');
  writeFileSync(join(repo, 'new.txt'), 'new content\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Stage tracked.txt', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Unstage tracked.txt', exact: true }),
    ).toBeEnabled();
    expect(fixtureGit(repo, ['show', ':tracked.txt'])).toBe('working edit');
    await page.getByRole('button', { name: 'Unstage tracked.txt', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Stage tracked.txt', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Unstage tracked.txt', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Stage tracked.txt', exact: true }),
    ).toBeEnabled();
    expect(fixtureGit(repo, ['diff', '--cached', '--name-only'])).toBe('');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
