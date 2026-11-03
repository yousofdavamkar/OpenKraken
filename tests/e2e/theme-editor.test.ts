import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture } from '../../packages/test-fixtures/src/index.js';

test('system theme changes recolor an open editor without losing its draft or undo history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-theme-editor-'));
  const repository = createFixture(join(root, 'repo'));
  writeFileSync(join(repository, 'draft.py'), 'before = 1\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: 'Appearance', exact: true });
    await appearance.getByLabel('Color theme').selectOption('system');
    await appearance.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(appearance.getByRole('status')).toHaveText('Appearance saved.');
    await appearance.getByRole('button', { name: 'Close', exact: true }).click();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Edit draft.py', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Working file editor' });
    const text = editor.getByRole('textbox', { name: 'Working file text' });
    await text.fill('after = 2\n');
    await expect(editor.locator('.cm-editor')).toHaveCSS('background-color', 'rgb(18, 27, 39)');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(editor.locator('.cm-editor')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(text).toContainText('after = 2');
    await expect(text).toBeFocused();
    await text.press('ControlOrMeta+z');
    await expect(text).toContainText('before = 1');
    await text.press('ControlOrMeta+Shift+z');
    await expect(text).toContainText('after = 2');
    expect(readFileSync(join(repository, 'draft.py'), 'utf8')).toBe('before = 1\n');
    await page.screenshot({ path: 'test-results/appearance-light-editor.png' });
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click();
    await editor.getByRole('button', { name: 'Discard draft', exact: true }).click();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
