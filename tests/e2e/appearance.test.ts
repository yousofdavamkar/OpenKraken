import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture } from '../../packages/test-fixtures/src/index.js';

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

test('Appearance switches the rendered theme and Canvas colors without moving graph rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-appearance-ui-'));
  const repository = createFixture(join(root, 'repo'), 'merge');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ colorScheme: null });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const graph = page.getByTestId('commit-graph');
    await expect(graph).toBeVisible();
    const rows = () =>
      page
        .getByRole('grid')
        .getByRole('row')
        .evaluateAll((elements) =>
          elements.map((el) => `${el.getAttribute('data-oid')}:${el.getAttribute('data-column')}`),
        );
    const before = await rows();
    const nodeColor = () =>
      graph.evaluate((canvas: HTMLCanvasElement) => [
        ...canvas.getContext('2d')!.getImageData(14 * devicePixelRatio, 14 * devicePixelRatio, 1, 1)
          .data,
      ]);
    expect(await nodeColor()).toEqual([31, 182, 214, 255]);
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Appearance', exact: true });
    await settings.getByLabel('Color theme').selectOption('light');
    await settings.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText('Appearance saved.');
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor))
      .toBe('rgb(245, 247, 251)');
    await expect.poll(nodeColor).toEqual([8, 127, 104, 255]);
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    expect(await rows()).toEqual(before);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: 'test-results/appearance-light.png' });
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(settings.getByLabel('Color theme')).toHaveValue('light');
    await settings.getByLabel('Color theme').selectOption('dark');
    await settings.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor))
      .toBe('rgb(27, 30, 36)');
    await expect.poll(nodeColor).toEqual([31, 182, 214, 255]);
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
