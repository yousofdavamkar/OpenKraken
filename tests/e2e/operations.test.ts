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
test('reviewed merge and mainline revert update native history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-merge-e2e-'));
  const path = createFixture(join(root, 'repository'));
  fixtureGit(path, ['switch', '-c', 'incoming']);
  writeFileSync(join(path, 'incoming.txt'), 'incoming\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Incoming file']);
  const target = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['switch', 'main']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Integrate commits', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Integrate commits', exact: true });
    await dialog
      .getByRole('combobox', { name: 'Target commit', exact: true })
      .selectOption({ label: 'incoming' });
    await dialog.getByRole('combobox', { name: 'Merge mode', exact: true }).selectOption('no-ff');
    await expect(dialog.getByText(target, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Check merge conflicts' }).click();
    await expect(
      dialog.getByText('No conflicts predicted between these committed trees.'),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Start merge', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const parents = fixtureGit(path, ['rev-list', '--parents', '-1', 'HEAD']).split(' ');
    expect(parents).toHaveLength(3);
    expect(parents[2]).toBe(target);
    await page.getByRole('button', { name: 'Integrate commits', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'Operation', exact: true }).selectOption('revert');
    await dialog
      .getByRole('combobox', { name: 'Target commit', exact: true })
      .selectOption({ label: 'main' });
    await dialog
      .getByRole('spinbutton', { name: 'Mainline parent (merge commits only)' })
      .fill('1');
    await dialog.getByRole('button', { name: 'Start revert', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(fixtureGit(path, ['rev-parse', 'HEAD^{tree}'])).toBe(
      fixtureGit(path, ['rev-parse', `${parents[1]}^{tree}`]),
    );

    await expect(page.getByTestId('head')).toHaveText('main');
    await expect(
      page
        .getByRole('grid', { name: 'Commit history' })
        .getByRole('gridcell', { name: /Incoming file/ }),
    ).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('hard reset requires a content review and Undo restores discarded edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-reset-e2e-'));
  const path = createFixture(join(root, 'repository'));
  fixtureGit(path, ['branch', 'before-reset']);
  writeFileSync(join(path, 'tracked.txt'), 'latest commit\n');
  fixtureGit(path, ['commit', '-am', 'Latest commit']);
  const original = fixtureGit(path, ['rev-parse', 'HEAD']);
  writeFileSync(join(path, 'tracked.txt'), 'uncommitted work\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Reset current branch' });
    await dialog
      .getByRole('combobox', { name: 'Target commit' })
      .selectOption({ label: 'before-reset' });
    await dialog.getByRole('combobox', { name: 'Reset mode' }).selectOption('hard');
    await expect(dialog.getByRole('button', { name: 'Reset reviewed state' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Review reset' }).click();
    await expect(dialog.getByText(original, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Reset reviewed state' }).click();
    await expect(dialog).toHaveCount(0);
    expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('base');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
    expect((await import('node:fs')).readFileSync(join(path, 'tracked.txt'), 'utf8')).toBe(
      'uncommitted work\n',
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
