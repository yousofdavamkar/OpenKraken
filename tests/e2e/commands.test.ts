import { pressShortcut } from '../electron-shortcut.js';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('command palette searches by category, respects availability and dialogs, and preserves frecency after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-commands-'));
  const args = [resolve('apps/desktop'), `--user-data-dir=${root}`];
  let app = await electron.launch({ args });
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    await pressShortcut(app, 'Control+P');
    let palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await palette.getByLabel('Search commands').fill('Create branch');
    await expect(
      palette.getByRole('option', { name: 'Create branch', exact: true }),
    ).toHaveAttribute('aria-disabled', 'true');
    await palette.getByLabel('Search commands').press('Enter');
    await expect(palette).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Create branch', exact: true })).toHaveCount(0);
    await palette.getByLabel('Command category').selectOption('Repository');
    await palette.getByLabel('Search commands').fill('clnrp');
    await expect(
      palette.getByRole('option', { name: 'Clone repository', exact: true }),
    ).toBeVisible();
    await palette.getByLabel('Search commands').press('Enter');
    await expect(palette).toHaveCount(0);
    const clone = page.getByRole('dialog', { name: 'Clone repository', exact: true });
    await expect(clone).toBeVisible();
    await pressShortcut(app, 'Control+P');
    await expect(palette).toHaveCount(0);
    await clone.getByRole('button', { name: 'Close', exact: true }).click();
    await app.close();
    app = await electron.launch({ args });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Commands', exact: true }).click();
    palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(
      palette.getByRole('listbox', { name: 'Commands' }).getByRole('option').first(),
    ).toHaveAccessibleName('Clone repository');
    await palette.getByLabel('Search commands').press('Escape');
    await expect(palette).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeFocused();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('JSON keybindings reject conflicts atomically, dispatch existing actions, and persist overrides', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-keybindings-'));
  const args = [resolve('apps/desktop'), `--user-data-dir=${root}`];
  let app = await electron.launch({ args });
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Keybindings', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Keybindings', exact: true }).click();
    let editor = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    const draft = (bindings: Record<string, string | null>) =>
      JSON.stringify({ version: 1, bindings });
    await editor.getByLabel('Keymap JSON').fill(draft({ 'repository.clone': 'Mod+P' }));
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('conflict');
    await editor.getByLabel('Keymap JSON').fill(draft({ 'unknown.command': 'Mod+K' }));
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('Unknown command');
    await editor.getByLabel('Keymap JSON').fill(draft({ 'repository.clone': 'K' }));
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('modifier');
    await editor.getByLabel('Keymap JSON').fill(
      draft({
        'app.commands': 'Mod+Shift+Y',
        'repository.clone': 'Mod+P',
        'repository.open': null,
      }),
    );
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(editor.getByRole('status')).toHaveText('Keyboard shortcuts saved.');
    await pressShortcut(app, 'Control+P');
    await expect(page.getByRole('dialog', { name: 'Clone repository', exact: true })).toHaveCount(
      0,
    );
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await pressShortcut(app, 'Control+P');
    let clone = page.getByRole('dialog', { name: 'Clone repository', exact: true });
    await expect(clone).toBeVisible();
    await clone.getByRole('button', { name: 'Close', exact: true }).click();
    await pressShortcut(app, 'Control+Shift+Y');
    let palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await palette.getByLabel('Search commands').press('Escape');
    await app.close();
    app = await electron.launch({ args });
    page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    await pressShortcut(app, 'Control+P');
    clone = page.getByRole('dialog', { name: 'Clone repository', exact: true });
    await expect(clone).toBeVisible();
    await clone.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Keybindings', exact: true }).click();
    editor = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(editor.getByLabel('Keymap JSON')).toHaveValue(/"repository.open": null/);
    await editor.getByRole('button', { name: 'Restore defaults', exact: true }).click();
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await pressShortcut(app, 'Control+P');
    palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('palette follows repository availability and keeps writes behind their existing review dialogs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-command-repo-'));
  const repo = createFixture(join(root, 'repo'));
  const before = fixtureGit(repo, ['show-ref']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Commands', exact: true }).click();
    let palette = page.getByRole('dialog', { name: 'Command palette' });
    await palette.getByLabel('Search commands').fill('Open repository');
    await palette.getByRole('option', { name: 'Open repository', exact: true }).click();
    await expect(page.getByTestId('head')).toHaveText('main');
    await page.getByRole('button', { name: 'Commands', exact: true }).click();
    palette = page.getByRole('dialog', { name: 'Command palette' });
    await palette.getByLabel('Command category').selectOption('References');
    await palette.getByLabel('Search commands').press('End');
    await expect(palette.getByRole('option', { name: 'Create tag', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await palette.getByLabel('Search commands').press('Home');
    await expect(
      palette.getByRole('option', { name: 'Create branch', exact: true }),
    ).toHaveAttribute('aria-disabled', 'false');
    await palette.getByLabel('Search commands').press('Enter');
    const branch = page.getByRole('dialog', { name: 'Create branch', exact: true });
    await expect(branch).toBeVisible();
    await branch.getByRole('textbox', { name: 'Branch name', exact: true }).fill('feature/command');
    expect(fixtureGit(repo, ['show-ref'])).toBe(before);
    await branch.press('Escape');
    await expect(branch).toHaveCount(0);
    expect(fixtureGit(repo, ['show-ref'])).toBe(before);
    await page.getByRole('button', { name: 'Keybindings', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await editor
      .getByLabel('Keymap JSON')
      .fill(JSON.stringify({ version: 1, bindings: { 'repository.clone': 'Mod+K' } }));
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByLabel('Search commits', { exact: true }).focus();
    await pressShortcut(app, 'Control+K');
    await expect(page.getByRole('dialog', { name: 'Clone repository', exact: true })).toHaveCount(
      0,
    );
    await pressShortcut(app, 'Control+P');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a damaged saved keymap falls back to defaults and can be repaired', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-command-corrupt-'));
  const args = [resolve('apps/desktop'), `--user-data-dir=${root}`];
  let app = await electron.launch({ args });
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    await app.close();
    const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
    settings.commands.keymap = '{broken';
    writeFileSync(join(root, 'settings.json'), JSON.stringify(settings));
    app = await electron.launch({ args });
    page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    await pressShortcut(app, 'Control+P');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await palette.getByLabel('Search commands').fill('Keyboard shortcuts');
    await palette.getByLabel('Search commands').press('Enter');
    const editor = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(editor.getByRole('alert')).toContainText('Saved keymap is invalid');
    await expect(editor.getByLabel('Keymap JSON')).toHaveValue('{broken');
    await editor.getByRole('button', { name: 'Restore defaults', exact: true }).click();
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(editor.getByRole('status')).toHaveText('Keyboard shortcuts saved.');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('commit search participates in keymap conflicts and respects remapping and modal focus', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-command-search-'));
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
    await expect(page.getByTestId('head')).toHaveText('main');
    await page.getByRole('button', { name: 'Keybindings', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await editor
      .getByLabel('Keymap JSON')
      .fill(JSON.stringify({ version: 1, bindings: { 'repository.clone': 'Mod+F' } }));
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('conflict', { timeout: 1000 });
    await editor
      .getByLabel('Keymap JSON')
      .fill(JSON.stringify({ version: 1, bindings: { 'history.search': 'Mod+Shift+F' } }));
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(editor.getByRole('status')).toHaveText('Keyboard shortcuts saved.');
    await editor.getByLabel('Keymap JSON').focus();
    await pressShortcut(app, 'Control+Shift+F');
    await expect(editor.getByLabel('Keymap JSON')).toBeFocused();
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    const search = page.getByLabel('Search commits', { exact: true });
    await pressShortcut(app, 'Control+F');
    await expect(search).not.toBeFocused();
    await pressShortcut(app, 'Control+Shift+F');
    await expect(search).toBeFocused();
    await page.getByRole('button', { name: 'Commands', exact: true }).click();
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await palette.getByLabel('Search commands').fill('Search commits');
    await palette.getByLabel('Search commands').press('Enter');
    await expect(palette).toHaveCount(0);
    await expect(search).toBeFocused();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('composing or repeated Enter does not execute a palette command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-command-composition-'));
  const app = await electron.launch({ args: [resolve('apps/desktop'), `--user-data-dir=${root}`] });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Commands', exact: true }).click();
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    const search = palette.getByLabel('Search commands');
    await search.fill('Clone repository');
    await search.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    await expect(palette).toBeVisible({ timeout: 1000 });
    await search.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true });
    await expect(palette).toBeVisible();
    await search.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Clone repository', exact: true })).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
