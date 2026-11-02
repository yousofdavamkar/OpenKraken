import { pressShortcut } from '../electron-shortcut.js';
import { _electron as electron, expect, test } from '@playwright/test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('command preferences persist atomically in main settings and survive renderer storage removal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-command-settings-'));
  const args = [resolve('apps/desktop'), `--user-data-dir=${root}`];
  let app = await electron.launch({ args });
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Keybindings', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await editor
      .getByLabel('Keymap JSON')
      .fill(JSON.stringify({ version: 1, bindings: { 'app.commands': 'Mod+Shift+Y' } }));
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(editor.getByRole('status')).toHaveText('Keyboard shortcuts saved.');
    await expect.poll(() => existsSync(join(root, 'settings.json')), { timeout: 1000 }).toBe(true);
    const saved = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
    expect(JSON.parse(saved.commands.keymap)).toEqual({
      version: 1,
      bindings: { 'app.commands': 'Mod+Shift+Y' },
    });
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Commands', exact: true }).click();
    let palette = page.getByRole('dialog', { name: 'Command palette' });
    await palette.getByLabel('Search commands').fill('Clone repository');
    await palette.getByLabel('Search commands').press('Enter');
    await expect(page.getByRole('dialog', { name: 'Clone repository', exact: true })).toBeVisible();
    await page.evaluate(() => localStorage.clear());
    await app.close();
    const persisted = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
    expect(persisted.commands.usage['repository.clone'].weight).toBeGreaterThan(0);
    app = await electron.launch({ args });
    page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    await pressShortcut(app, 'Control+Shift+Y');
    palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole('listbox').getByRole('option').first()).toHaveAccessibleName(
      'Clone repository',
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('main rejects invalid and stale keymap writes and reopening the editor reads the current revision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-command-settings-stale-'));
  const app = await electron.launch({ args: [resolve('apps/desktop'), `--user-data-dir=${root}`] });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Keybindings', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    const outcome = await page.evaluate(async () => {
      const current = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'commandPreferences',
      });
      if (current.kind !== 'commandPreferences') throw new Error('Missing settings');
      const rejected = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'commandKeymapSave',
        revision: current.state.revision,
        keymap: JSON.stringify({ version: 1, bindings: { 'repository.clone': 'Mod+P' } }),
      });
      const accepted = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'commandKeymapSave',
        revision: current.state.revision,
        keymap: JSON.stringify({ version: 1, bindings: { 'repository.clone': 'Mod+K' } }),
      });
      return { rejected, accepted };
    });
    expect(outcome.rejected.kind).toBe('error');
    expect(outcome.accepted.kind).toBe('commandPreferences');
    await editor
      .getByLabel('Keymap JSON')
      .fill(JSON.stringify({ version: 1, bindings: { 'app.commands': 'Mod+Shift+Y' } }));
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('could not be saved');
    expect(
      JSON.parse(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')).commands.keymap)
        .bindings,
    ).toEqual({ 'repository.clone': 'Mod+K' });
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Keybindings', exact: true }).click();
    await expect(editor.getByLabel('Keymap JSON')).toHaveValue(/"repository.clone": "Mod\+K"/, {
      timeout: 1000,
    });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy keymaps and frecency migrate once into native settings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-command-settings-legacy-'));
  const args = [resolve('apps/desktop'), `--user-data-dir=${root}`];
  let app = await electron.launch({ args });
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    await page.evaluate(() => {
      localStorage.setItem(
        'openkraken.keymap.v1',
        JSON.stringify({ version: 1, bindings: { 'app.commands': 'Mod+Shift+Y' } }),
      );
      localStorage.setItem(
        'openkraken.commandUsage.v1',
        JSON.stringify({ 'repository.clone': { weight: 20, time: Date.now() } }),
      );
    });
    await app.close();
    // Recreate the previous release's profile, which had no main settings file.
    rmSync(join(root, 'settings.json'));
    app = await electron.launch({ args });
    page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    await pressShortcut(app, 'Control+Shift+Y');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette.getByRole('listbox').getByRole('option').first()).toHaveAccessibleName(
      'Clone repository',
    );
    expect(await page.evaluate(() => localStorage.getItem('openkraken.keymap.v1'))).toBeNull();
    expect(
      await page.evaluate(() => localStorage.getItem('openkraken.commandUsage.v1')),
    ).toBeNull();
    await page.evaluate(() => localStorage.setItem('openkraken.keymap.v1', '{broken'));
    await app.close();
    app = await electron.launch({ args });
    page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    await pressShortcut(app, 'Control+Shift+Y');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('damaged settings remain intact until explicit repair preserves a backup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-command-settings-damaged-'));
  const damaged = '{damaged settings';
  writeFileSync(join(root, 'settings.json'), damaged);
  const app = await electron.launch({ args: [resolve('apps/desktop'), `--user-data-dir=${root}`] });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Keybindings', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(editor.getByRole('alert')).toContainText('Saved settings could not be read');
    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe(damaged);
    await editor.getByRole('button', { name: 'Restore defaults', exact: true }).click();
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(editor.getByRole('status')).toHaveText('Keyboard shortcuts saved.');
    const backups = readdirSync(root).filter((name) => name.startsWith('settings.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(root, backups[0]!), 'utf8')).toBe(damaged);
    expect(readdirSync(root).filter((name) => /^settings\.json\..*\.tmp$/.test(name))).toHaveLength(
      0,
    );
    expect(
      JSON.parse(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')).commands.keymap),
    ).toEqual({ version: 1, bindings: {} });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed native settings write keeps the old shortcuts active', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-command-settings-failed-'));
  const app = await electron.launch({ args: [resolve('apps/desktop'), `--user-data-dir=${root}`] });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Keybindings', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    rmSync(join(root, 'settings.json'));
    mkdirSync(join(root, 'settings.json'));
    await editor
      .getByLabel('Keymap JSON')
      .fill(JSON.stringify({ version: 1, bindings: { 'app.commands': 'Mod+Shift+Y' } }));
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('could not be saved');
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await pressShortcut(app, 'Control+P');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    expect(readdirSync(join(root, 'settings.json'))).toEqual([]);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
