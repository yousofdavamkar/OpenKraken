import { pressShortcut } from '../electron-shortcut.js';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('native command menus follow keymaps and availability and use the existing renderer dialogs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-command-menu-'));
  const app = await electron.launch({ args: [resolve('apps/desktop'), `--user-data-dir=${root}`] });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    const item = (id: string) =>
      app.evaluate(({ Menu }, value) => {
        const entry = Menu.getApplicationMenu()?.getMenuItemById(value);
        return entry
          ? { enabled: entry.enabled, accelerator: entry.accelerator, label: entry.label }
          : null;
      }, id);
    await expect
      .poll(() => item('command.app.commands'), { timeout: 1000 })
      .toMatchObject({ enabled: true, accelerator: 'Control+P' });
    expect(await item('command.references.branch')).toMatchObject({ enabled: false });
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const entry = Menu.getApplicationMenu()!.getMenuItemById('command.repository.clone')!;
      entry.click(entry, BrowserWindow.getAllWindows()[0], {});
    });
    const clone = page.getByRole('dialog', { name: 'Clone repository', exact: true });
    await expect(clone).toBeVisible();
    await expect.poll(() => item('command.app.commands')).toMatchObject({ enabled: false });
    await clone.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Keybindings', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await editor.getByLabel('Keymap JSON').fill(
      JSON.stringify({
        version: 1,
        bindings: {
          'app.commands': 'Mod+Shift+Y',
          'repository.clone': 'Mod+P',
          'repository.open': null,
        },
      }),
    );
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(editor.getByRole('status')).toHaveText('Keyboard shortcuts saved.');
    await expect
      .poll(() => item('command.app.commands'))
      .toMatchObject({ accelerator: 'Control+Shift+Y' });
    expect((await item('command.repository.open'))?.accelerator).toBeNull();
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await expect
      .poll(() => item('command.repository.clone'))
      .toMatchObject({ enabled: true, accelerator: 'Control+P' });
    await pressShortcut(app, 'Control+P');
    await expect(clone).toBeVisible();
    await clone.getByRole('button', { name: 'Close', exact: true }).click();
    await pressShortcut(app, 'Control+Shift+Y');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('native accelerators ignore repeat, invoke once, and recover after renderer reload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-command-menu-reload-'));
  const app = await electron.launch({ args: [resolve('apps/desktop'), `--user-data-dir=${root}`] });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    await pressShortcut(app, 'Control+P', true);
    await page.getByRole('button', { name: 'Commands', exact: true }).focus();
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
    await pressShortcut(app, 'Control+P');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    const result = await page.evaluate(() =>
      window.openkraken.request({ id: crypto.randomUUID(), method: 'commandPreferences' }),
    );
    expect(result.kind).toBe('commandPreferences');
    if (result.kind === 'commandPreferences') {
      expect(result.state.usage['app.commands']?.weight).toBeGreaterThan(0.9);
      expect(result.state.usage['app.commands']?.weight).toBeLessThan(1.1);
    }
    await palette.getByRole('button', { name: 'Close', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    await pressShortcut(app, 'Control+P');
    await expect(palette).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
