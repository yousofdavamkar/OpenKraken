import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
test('clone into a chosen empty folder opens shallow history in the desktop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-clone-e2e-'));
  const source = createFixture(join(root, 'source'));
  const target = join(root, 'target');
  mkdirSync(target);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, target);
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Clone repository', exact: true });
    await dialog
      .getByRole('textbox', { name: 'Repository URL or absolute path', exact: true })
      .fill(source);
    await dialog
      .getByRole('spinbutton', { name: 'History depth (optional)', exact: true })
      .fill('1');
    await dialog.getByRole('button', { name: 'Choose folder and clone', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('head')).toHaveText('main');
    await expect(page.getByTestId('commit-count')).toHaveText('1 commits');
    expect(fixtureGit(target, ['rev-parse', '--is-shallow-repository'])).toBe('true');
    expect(fixtureGit(target, ['rev-parse', 'HEAD'])).toBe(
      fixtureGit(source, ['rev-parse', 'HEAD']),
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('clone errors remain visible when the previously open repository refreshes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-clone-error-'));
  const path = createFixture(join(root, 'repository'));
  const target = join(root, 'target');
  mkdirSync(target);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByTestId('head')).toHaveText('main');
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, target);
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Clone repository' });
    await dialog
      .getByRole('textbox', { name: 'Repository URL or absolute path' })
      .fill(join(root, 'missing-repository'));
    await dialog.getByRole('button', { name: 'Choose folder and clone' }).click();
    const error = dialog.getByRole('alert');
    await expect(error).toBeVisible();
    const message = await error.innerText();
    fixtureGit(path, ['branch', '-m', 'refreshed-after-failure']);
    await expect(page.getByTestId('head')).toHaveText('refreshed-after-failure');
    await expect(error).toHaveText(message);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
