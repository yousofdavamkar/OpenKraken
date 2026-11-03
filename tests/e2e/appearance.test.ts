import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('native appearance persists independently of command preferences and rejects stale saves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-appearance-'));
  const args = [resolve('apps/desktop'), `--user-data-dir=${root}`];
  let app = await electron.launch({ args });
  try {
    let page = await app.firstWindow();
    // Exercise Electron's native preference instead of Playwright's default light emulation.
    await page.emulateMedia({ colorScheme: null });
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    const initial = await page.evaluate(() =>
      window.openkraken.request({ id: crypto.randomUUID(), method: 'appearancePreferences' }),
    );
    expect(initial).toMatchObject({
      kind: 'appearancePreferences',
      state: { mode: 'dark', revision: 0, warning: null },
    });
    const outcomes = await page.evaluate(async () => {
      const current = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'commandPreferences',
      });
      if (current.kind !== 'commandPreferences') throw new Error('Missing commands');
      return Promise.all([
        window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'appearanceSave',
          revision: 0,
          mode: 'light',
        }),
        window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'commandKeymapSave',
          revision: current.state.revision,
          keymap: JSON.stringify({ version: 1, bindings: { 'app.commands': 'Mod+Shift+Y' } }),
        }),
      ]);
    });
    expect(outcomes.map((result) => result.kind)).toEqual([
      'appearancePreferences',
      'commandPreferences',
    ]);
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');
    await expect
      .poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
      .toBe(false);
    const stale = await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'appearanceSave',
        revision: 0,
        mode: 'dark',
      }),
    );
    expect(stale).toMatchObject({ kind: 'error', code: 'APPEARANCE_SETTINGS' });
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');
    await page.evaluate(() => localStorage.clear());
    await app.close();
    app = await electron.launch({ args });
    page = await app.firstWindow();
    await page.emulateMedia({ colorScheme: null });
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');
    const persisted = await page.evaluate(async () => ({
      appearance: await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'appearancePreferences',
      }),
      commands: await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'commandPreferences',
      }),
    }));
    expect(persisted.appearance).toMatchObject({
      kind: 'appearancePreferences',
      state: { mode: 'light', revision: 1 },
    });
    if (persisted.commands.kind !== 'commandPreferences') throw new Error('Missing commands');
    expect(JSON.parse(persisted.commands.state.keymap).bindings).toEqual({
      'app.commands': 'Mod+Shift+Y',
    });
    await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'appearanceSave',
        revision: 1,
        mode: 'dark',
      }),
    );
    await expect
      .poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
      .toBe(true);
    await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'appearanceSave',
        revision: 2,
        mode: 'system',
      }),
    );
    const system = await app.evaluate(({ nativeTheme }) => ({
      source: nativeTheme.themeSource,
      dark: nativeTheme.shouldUseDarkColors,
    }));
    expect(system.source).toBe('system');
    await expect
      .poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
      .toBe(system.dark);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an appearance-only profile still imports legacy shortcuts without losing its theme', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-appearance-legacy-'));
  const args = [resolve('apps/desktop'), `--user-data-dir=${root}`];
  let app = await electron.launch({ args });
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    await page.evaluate(() =>
      localStorage.setItem(
        'openkraken.keymap.v1',
        JSON.stringify({ version: 1, bindings: { 'app.commands': 'Mod+Shift+Y' } }),
      ),
    );
    await app.close();
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({ version: 1, appearance: { revision: 4, mode: 'light' } }),
    );
    app = await electron.launch({ args });
    page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    const values = await page.evaluate(async () => ({
      appearance: await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'appearancePreferences',
      }),
      commands: await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'commandPreferences',
      }),
      legacy: localStorage.getItem('openkraken.keymap.v1'),
    }));
    expect(values.appearance).toMatchObject({
      kind: 'appearancePreferences',
      state: { revision: 4, mode: 'light', warning: null },
    });
    expect(values.legacy).toBeNull();
    if (values.commands.kind !== 'commandPreferences') throw new Error('Missing commands');
    expect(JSON.parse(values.commands.state.keymap).bindings).toEqual({
      'app.commands': 'Mod+Shift+Y',
    });
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
