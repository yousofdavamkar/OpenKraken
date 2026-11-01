import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
test('create branches and annotated tags, confirm deletion and restore with Undo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-refs-e2e-'));
  const repo = createFixture(join(root, 'repo'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'New branch', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Create branch' });
    await dialog.getByRole('textbox', { name: 'Branch name', exact: true }).fill('feature/ui');
    await dialog.getByRole('button', { name: 'Create branch', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.refs').getByText('feature/ui', { exact: true })).toBeVisible();
    expect(fixtureGit(repo, ['rev-parse', 'feature/ui'])).toBe(
      fixtureGit(repo, ['rev-parse', 'HEAD']),
    );
    await page.getByRole('button', { name: 'Switch to feature/ui', exact: true }).click();
    await expect(page.getByTestId('head')).toHaveText('feature/ui');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByTestId('head')).toHaveText('main');
    await page.getByRole('button', { name: 'Rename branch main', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Rename branch' });
    await dialog.getByRole('textbox', { name: 'Branch name', exact: true }).fill('main-renamed');
    await dialog.getByRole('button', { name: 'Rename branch', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('head')).toHaveText('main-renamed');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByTestId('head')).toHaveText('main');

    await page.getByRole('button', { name: 'Set upstream main', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Set upstream' });
    await dialog
      .getByRole('combobox', { name: 'Upstream', exact: true })
      .selectOption('refs/heads/feature/ui');
    await dialog.getByRole('button', { name: 'Set upstream', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(fixtureGit(repo, ['rev-parse', '--symbolic-full-name', 'main@{upstream}'])).toBe(
      'refs/heads/feature/ui',
    );
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(() => fixtureGit(repo, ['rev-parse', '--symbolic-full-name', 'main@{upstream}']))
      .toBe('refs/remotes/origin/main');
    await page.getByRole('button', { name: 'New tag', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Create tag' });
    await dialog.getByRole('textbox', { name: 'Tag name', exact: true }).fill('release/ui');
    await dialog
      .getByRole('textbox', { name: 'Tag annotation (optional)', exact: true })
      .fill('Reviewed release\n\nDetails\n');
    await dialog.getByRole('button', { name: 'Create tag', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const tag = fixtureGit(repo, ['rev-parse', 'refs/tags/release/ui']);
    expect(fixtureGit(repo, ['cat-file', '-t', tag])).toBe('tag');
    await page.getByRole('button', { name: 'Delete tag release/ui', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Delete tag' });
    await expect(dialog.getByText(tag, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete tag', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Delete tag release/ui', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Delete tag release/ui', exact: true }),
    ).toBeVisible();
    expect(fixtureGit(repo, ['rev-parse', 'refs/tags/release/ui'])).toBe(tag);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
