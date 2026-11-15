import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
test('CodeMirror working editor preserves CRLF, guards closing a draft, and saves with Undo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-working-editor-ui-'));
  const path = createFixture(join(root, 'repository'));
  writeFileSync(join(path, 'draft.txt'), 'before\r\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Edit draft.txt', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Working file editor' });
    const text = editor.getByRole('textbox', { name: 'Working file text' });
    await expect(text).toContainText('before');
    await text.fill('after\n');
    await text.press('ControlOrMeta+z');
    await expect(text).toContainText('before');
    await text.press('ControlOrMeta+Shift+z');
    await expect(text).toContainText('after');
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click();
    await expect(editor.getByText('Discard unsaved changes?', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await editor.getByRole('button', { name: 'Save file', exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(readFileSync(join(path, 'draft.txt'), 'utf8')).toBe('after\r\n');
    expect(fixtureGit(path, ['diff', '--cached', '--name-only'])).toBe('');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => readFileSync(join(path, 'draft.txt'), 'utf8')).toBe('before\r\n');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stale editor save preserves both the newer disk file and the unsaved draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-stale-editor-ui-'));
  const path = createFixture(join(root, 'repository'));
  writeFileSync(join(path, 'draft.txt'), 'before\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Edit draft.txt', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Working file editor' });
    const text = editor.getByRole('textbox', { name: 'Working file text' });
    await text.fill('unsaved editor draft\n');
    writeFileSync(join(path, 'draft.txt'), 'newer external edit\n');
    await editor.getByRole('button', { name: 'Save file', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('newer edits were left untouched');
    await expect(text).toContainText('unsaved editor draft');
    expect(readFileSync(join(path, 'draft.txt'), 'utf8')).toBe('newer external edit\n');
    await page.screenshot({ path: 'test-results/working-editor-stale.png' });
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click();
    await editor.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(readFileSync(join(path, 'draft.txt'), 'utf8')).toBe('newer external edit\n');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('closing the application reviews an unsaved working-file draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-editor-close-ui-'));
  const path = createFixture(join(root, 'repository'));
  writeFileSync(join(path, 'draft.txt'), 'before\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showMessageBoxSync = () => 0;
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Edit draft.txt', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Working file editor' });
    await editor.getByRole('textbox', { name: 'Working file text' }).fill('unsaved draft\n');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect(editor.getByRole('textbox', { name: 'Working file text' })).toContainText(
      'unsaved draft',
    );
    expect(readFileSync(join(path, 'draft.txt'), 'utf8')).toBe('before\n');
    // Cancelling an application Quit must also keep the repository service alive.
    await app.evaluate(({ app }) => {
      app.quit();
    });
    await expect(editor.getByRole('textbox', { name: 'Working file text' })).toContainText(
      'unsaved draft',
    );
    await editor.getByRole('button', { name: 'Save file', exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(readFileSync(join(path, 'draft.txt'), 'utf8')).toBe('unsaved draft\n');
    await page.getByRole('button', { name: 'Edit draft.txt', exact: true }).click();
    await editor.getByRole('textbox', { name: 'Working file text' }).fill('discard this draft\n');
    await expect(editor.getByRole('status')).toHaveText('Draft saved locally');
    const closed = app.waitForEvent('close');
    await app.evaluate(({ app, dialog }) => {
      dialog.showMessageBoxSync = () => 1;
      setTimeout(() => app.quit(), 20);
    });
    await closed;
    expect(readdirSync(join(root, 'profile', 'working-file-drafts'))).toEqual([]);
    expect(readFileSync(join(path, 'draft.txt'), 'utf8')).toBe('unsaved draft\n');
  } finally {
    await app.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('filename-based syntax highlighting loads for Python in the isolated editor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-syntax-ui-'));
  const path = createFixture(join(root, 'repository'));
  writeFileSync(join(path, 'greeting.py'), 'def greeting():\n    return "hello"\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Edit greeting.py', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Working file editor' });
    await expect(editor.getByText('def', { exact: true })).toHaveCSS('color', 'rgb(199, 146, 234)');
    await expect(editor.getByText('"hello"', { exact: true })).toHaveCSS(
      'color',
      'rgb(195, 232, 141)',
    );
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click();
    expect(readFileSync(join(path, 'greeting.py'), 'utf8')).toBe(
      'def greeting():\n    return "hello"\n',
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
