import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture } from '../../packages/test-fixtures/src/index.js';

test('custom JSON themes validate before applying and survive restart independently of renderer storage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-custom-theme-'));
  const repository = createFixture(join(root, 'repo'), 'merge');
  const args = [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`];
  let app = await electron.launch({ args });
  const custom = {
    version: 1,
    name: 'Evening',
    base: 'dark',
    colors: {
      background: '#142135',
      text: '#e9efff',
      graph1: '#f0a030',
      editorBackground: '#182436',
    },
  };
  try {
    let page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    let settings = page.getByRole('dialog', { name: 'Appearance', exact: true });
    await settings.getByLabel('Color theme').selectOption('custom', { timeout: 1500 });
    await settings.getByLabel('Custom theme JSON').fill(JSON.stringify(custom));
    await settings.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText('Appearance saved.');
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor))
      .toBe('rgb(20, 33, 53)');
    await expect
      .poll(() =>
        page
          .getByTestId('commit-graph')
          .evaluate((canvas: HTMLCanvasElement) => [
            ...canvas
              .getContext('2d')!
              .getImageData(14 * devicePixelRatio, 14 * devicePixelRatio, 1, 1).data,
          ]),
      )
      .toEqual([240, 160, 48, 255]);
    await page.screenshot({ path: 'test-results/appearance-custom.png' });
    await settings
      .getByLabel('Custom theme JSON')
      .fill(
        JSON.stringify({ ...custom, colors: { background: 'url(https://example.test/track)' } }),
      );
    await settings.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(settings.getByRole('alert')).toContainText('hex');
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
    ).toBe('rgb(20, 33, 53)');
    await page.evaluate(() => localStorage.clear());
    await app.close();
    app = await electron.launch({ args });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    settings = page.getByRole('dialog', { name: 'Appearance', exact: true });
    await expect(settings.getByLabel('Color theme')).toHaveValue('custom');
    expect(JSON.parse(await settings.getByLabel('Custom theme JSON').inputValue())).toEqual(custom);
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
    ).toBe('rgb(20, 33, 53)');
    await settings
      .getByLabel('Custom theme JSON')
      .fill(JSON.stringify({ ...custom, base: 'light', colors: { background: '#fef9ed' } }));
    await settings.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText('Appearance saved.');
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).color))
      .toBe('rgb(28, 38, 53)');
    await settings
      .getByLabel('Custom theme JSON')
      .fill(JSON.stringify({ ...custom, colors: { background: '#12345680' } }));
    await settings.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText('Appearance saved.');
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getBackgroundColor(),
      ),
    ).toBe('#123456');
    await settings.getByLabel('Color theme').selectOption('dark');
    await settings.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor))
      .toBe('rgb(16, 21, 30)');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed appearance save retains the active theme and the editable draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-appearance-failed-'));
  const app = await electron.launch({ args: [resolve('apps/desktop'), `--user-data-dir=${root}`] });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Appearance', exact: true });
    await settings.getByLabel('Color theme').selectOption('light');
    await settings.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText('Appearance saved.');
    const file = join(root, 'settings.json');
    const original = readFileSync(file, 'utf8');
    rmSync(file);
    mkdirSync(file);
    const draft = JSON.stringify({
      version: 1,
      name: 'Draft',
      base: 'dark',
      colors: { background: '#123456' },
    });
    await settings.getByLabel('Color theme').selectOption('custom');
    await settings.getByLabel('Custom theme JSON').fill(draft);
    await settings.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(settings.getByRole('alert')).toContainText('could not be saved');
    await expect(settings.getByLabel('Custom theme JSON')).toHaveValue(draft);
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
    ).toBe('rgb(245, 247, 251)');
    rmSync(file, { recursive: true });
    writeFileSync(file, original);
    await settings.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText('Appearance saved.');
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor))
      .toBe('rgb(18, 52, 86)');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
