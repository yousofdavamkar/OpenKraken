import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
test('manage remote URLs and confirm local removal through the desktop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-remotes-e2e-'));
  const repo = createFixture(join(root, 'repo'));
  const remotePath = join(root, 'remote.git');
  fixtureGit(repo, ['clone', '--bare', '.', remotePath]);
  fixtureGit(remotePath, ['branch', 'remote-only']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Manage remotes', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Manage remotes' });
    await dialog.getByRole('textbox', { name: 'Remote name', exact: true }).fill('backup');
    await dialog
      .getByRole('textbox', { name: 'Repository URL or path', exact: true })
      .fill(remotePath);
    await dialog.getByRole('button', { name: 'Add remote', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'backup', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Fetch backup', exact: true }).click();
    await expect(dialog.getByText('Fetched backup', { exact: true })).toBeVisible();
    expect(fixtureGit(repo, ['rev-parse', 'backup/remote-only'])).toBe(
      fixtureGit(remotePath, ['rev-parse', 'remote-only']),
    );
    await dialog.getByRole('button', { name: 'Edit backup', exact: true }).click();
    await dialog
      .getByRole('textbox', { name: 'Repository URL or path', exact: true })
      .fill('git@example.test:project.git');
    await dialog.getByRole('button', { name: 'Set fetch URL', exact: true }).click();
    await expect(
      dialog.getByText('git@example.test:project.git', { exact: true }).first(),
    ).toBeVisible();
    expect(fixtureGit(repo, ['remote', 'get-url', 'backup'])).toBe('git@example.test:project.git');
    await dialog.getByRole('button', { name: 'Remove backup', exact: true }).click();
    await expect(dialog.getByText('Remove backup and its local tracking refs?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm removal', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'backup', exact: true })).toHaveCount(0);
    expect(fixtureGit(repo, ['remote'])).toBe('origin');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
