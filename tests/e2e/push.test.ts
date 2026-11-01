import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
test('review and push a branch to a local remote with upstream tracking', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-push-e2e-'));
  const repo = createFixture(join(root, 'repo'));
  const remote = join(root, 'remote.git');
  fixtureGit(repo, ['clone', '--bare', '.', remote]);
  fixtureGit(repo, ['remote', 'set-url', 'origin', remote]);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Push', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Push to remote', exact: true });
    await dialog.getByRole('textbox', { name: 'Destination name', exact: true }).fill('published');
    await dialog.getByRole('checkbox', { name: 'Set upstream after push', exact: true }).check();
    await dialog.getByRole('button', { name: 'Review push', exact: true }).click();
    await expect(dialog.getByText('Create refs/heads/published', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Push reviewed tip', exact: true }).click();
    await expect(dialog.getByText('Push completed', { exact: true })).toBeVisible();
    expect(fixtureGit(remote, ['rev-parse', 'published'])).toBe(
      fixtureGit(repo, ['rev-parse', 'HEAD']),
    );
    expect(fixtureGit(repo, ['rev-parse', '--symbolic-full-name', 'main@{upstream}'])).toBe(
      'refs/remotes/origin/published',
    );
    const reviewed = fixtureGit(repo, ['rev-parse', 'HEAD']);
    fixtureGit(repo, ['commit', '--allow-empty', '-m', 'Remote-only change']);
    fixtureGit(repo, ['push', remote, 'HEAD:refs/heads/published']);
    fixtureGit(repo, ['reset', '--soft', reviewed]);
    await dialog.getByRole('button', { name: 'Review again', exact: true }).click();
    await dialog.getByRole('button', { name: 'Review push', exact: true }).click();
    await expect(dialog.getByText('Update refs/heads/published', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Push reviewed tip', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('non-fast-forward');
    await dialog
      .getByRole('checkbox', { name: 'Replace remote history with force-with-lease', exact: true })
      .check();
    await dialog.getByRole('button', { name: 'Push reviewed tip', exact: true }).click();
    await expect(dialog.getByText('Push completed', { exact: true })).toBeVisible();
    expect(fixtureGit(remote, ['rev-parse', 'published'])).toBe(reviewed);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(
      page.locator('.refs').getByText('origin/published', { exact: true }),
    ).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
