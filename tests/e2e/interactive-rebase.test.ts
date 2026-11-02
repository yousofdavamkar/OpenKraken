import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
test('interactive rebase reviews ordered actions and messages before rewriting native history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-rebase-ui-'));
  const path = createFixture(join(root, 'repository'));
  const base = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['branch', 'rebase-base']);
  for (const name of ['one', 'two', 'three']) {
    writeFileSync(join(path, name + '.txt'), name + '\n');
    fixtureGit(path, ['add', '.']);
    fixtureGit(path, ['commit', '-m', name]);
  }
  const original = fixtureGit(path, ['rev-parse', 'HEAD']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Interactive rebase', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Plan interactive rebase' });
    await dialog
      .getByRole('combobox', { name: 'Rebase base' })
      .selectOption({ label: 'rebase-base' });
    await dialog.getByRole('button', { name: 'Review commits' }).click();
    const rows = dialog.getByTestId('rebase-step');
    await expect(rows).toHaveCount(3);
    await rows.nth(1).getByRole('button', { name: 'Move up' }).click();
    await rows.nth(0).getByRole('combobox', { name: 'Action' }).selectOption('reword');
    await rows.nth(0).getByRole('textbox', { name: 'Commit message' }).fill('Two becomes first');
    await rows.nth(2).getByRole('combobox', { name: 'Action' }).selectOption('drop');
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
    await dialog.screenshot({ path: test.info().outputPath('reviewed-rebase.png') });
    await dialog.getByRole('button', { name: 'Start reviewed rebase' }).click();
    await expect(dialog).toHaveCount(0);
    expect(fixtureGit(path, ['log', '--reverse', '--format=%s', `${base}..HEAD`])).toBe(
      'Two becomes first\none',
    );
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('interactive edit stop uses the amend form and native Continue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-rebase-edit-ui-'));
  const path = createFixture(join(root, 'repository'));
  fixtureGit(path, ['branch', 'rebase-base']);
  writeFileSync(join(path, 'edited.txt'), 'before edit stop\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Original message']);
  const original = fixtureGit(path, ['rev-parse', 'HEAD']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Interactive rebase', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Plan interactive rebase' });
    await dialog
      .getByRole('combobox', { name: 'Rebase base' })
      .selectOption({ label: 'rebase-base' });
    await dialog.getByRole('button', { name: 'Review commits' }).click();
    await dialog
      .getByTestId('rebase-step')
      .getByRole('combobox', { name: 'Action' })
      .selectOption('edit');
    await dialog.getByRole('button', { name: 'Start reviewed rebase' }).click();
    await expect(dialog).toHaveCount(0);
    const operation = page.getByRole('region', { name: 'Git operation' });
    await expect(operation.getByText(/Paused to edit this commit/)).toBeVisible();
    await page.getByRole('checkbox', { name: 'Amend last commit' }).check();
    await page
      .getByRole('textbox', { name: 'Commit message', exact: true })
      .fill('Amended during rebase');
    await page.getByRole('button', { name: 'Amend commit', exact: true }).click();
    await expect
      .poll(() => fixtureGit(path, ['log', '-1', '--format=%s']))
      .toBe('Amended during rebase');
    await operation.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(operation).toHaveCount(0);
    await expect(page.getByTestId('head')).toHaveText('main');
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
for (const action of ['save', 'cancel'] as const)
  test(`additional native Git document supports ${action} in the desktop`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkraken-extra-editor-'));
    const path = createFixture(join(root, 'repository'));
    fixtureGit(path, ['branch', 'rebase-base']);
    fixtureGit(path, ['commit', '--allow-empty', '-m', 'Review this commit']);
    const original = fixtureGit(path, ['rev-parse', 'HEAD']);
    const document = join(path, '.git/review-message.txt');
    writeFileSync(document, 'Native draft\n');
    writeFileSync(
      join(path, '.git/hooks/pre-rebase'),
      '#!/bin/sh\ndocument="$(git rev-parse --absolute-git-dir)/review-message.txt"\neval "$GIT_EDITOR \\"\\$document\\""\n',
      { mode: 0o755 },
    );
    const app = await electron.launch({
      args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
    });
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, path);
      await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
      await page.getByRole('button', { name: 'Interactive rebase', exact: true }).click();
      const rebase = page.getByRole('dialog', { name: 'Plan interactive rebase' });
      await rebase
        .getByRole('combobox', { name: 'Rebase base' })
        .selectOption({ label: 'rebase-base' });
      await rebase.getByRole('button', { name: 'Review commits' }).click();
      await rebase.getByRole('button', { name: 'Start reviewed rebase' }).click();
      const editor = page.getByRole('dialog', { name: 'Git document editor' });
      await expect(editor.getByRole('textbox', { name: 'Document text' })).toHaveValue(
        'Native draft\n',
      );
      expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
      await editor
        .getByRole('textbox', { name: 'Document text' })
        .fill('Reviewed in the desktop\n');
      await editor
        .getByRole('button', {
          name: action === 'save' ? 'Save and continue' : 'Cancel edit',
          exact: true,
        })
        .click();
      await expect(editor).toHaveCount(0);
      if (action === 'save') {
        await expect(rebase).toHaveCount(0);
        expect(readFileSync(document, 'utf8')).toBe('Reviewed in the desktop\n');
      } else {
        await expect(rebase.getByRole('alert')).toContainText(/cancelled/i);
        expect(readFileSync(document, 'utf8')).toBe('Native draft\n');
        expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
      }
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
