import { _electron as electron, test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DesktopApi } from '../../packages/ipc-contract/src/index.js';
declare global {
  interface Window {
    openkraken: DesktopApi;
  }
}
import { createFixture } from '../../packages/test-fixtures/src/index.js';

test('sandbox, native folder open, real utility service and 2000-commit first paint', async ({
  browserName: _browserName,
}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-e2e-'));
  const repository = createFixture(join(root, 'repository'), 'linear', 2200);
  writeFileSync(join(repository, 'tracked.txt'), 'modified\n');
  writeFileSync(join(repository, 'new file.txt'), 'new');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'false' },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(
      page.getByRole('heading', { name: 'A clear view of your history.' }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => ({
        require: typeof Reflect.get(window, 'require'),
        process: typeof Reflect.get(window, 'process'),
        api: Object.keys(window.openkraken).sort(),
      })),
    ).toEqual({ require: 'undefined', process: 'undefined', api: ['cancel', 'request'] });
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents as Electron.WebContents & {
        getLastWebPreferences(): Record<string, unknown>;
      };
      return contents.getLastWebPreferences();
    });
    expect(prefs).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false });
    const probe = resolve('apps/desktop/dist/renderer/csp-probe.js');
    writeFileSync(
      probe,
      `try { eval('1+1'); window.cspProbe = false; } catch { window.cspProbe = true; }`,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.src = './csp-probe.js';
          script.onload = () => resolve();
          script.onerror = () => reject(new Error('CSP probe failed to load'));
          document.head.append(script);
        }),
    );
    expect(await page.evaluate(() => Reflect.get(window, 'cspProbe'))).toBe(true);
    rmSync(probe);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('2,000 commits · more available');
    await expect(page.getByTestId('head')).toHaveText('main');
    await expect(page.getByText('↑1 ↓0', { exact: true })).toBeVisible();
    await expect(page.getByText('tracked.txt', { exact: true })).toBeVisible();
    await expect(page.getByText('new file.txt', { exact: true })).toBeVisible();
    await expect(page.locator('.refs').getByText('annotated', { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => performance.getEntriesByName('repository-first-paint').length),
      )
      .toBeGreaterThan(0);
    const duration = await page.evaluate(
      () => performance.getEntriesByName('repository-first-paint').at(-1)!.duration,
    );
    console.log(
      await page.evaluate(() =>
        performance
          .getEntriesByType('mark')
          .map((entry) => ({ name: entry.name, time: entry.startTime })),
      ),
    );
    console.log(`2000-commit first paint: ${duration.toFixed(1)} ms`);
    await testInfo.attach('first-paint.json', {
      body: JSON.stringify({
        durationMs: duration,
        budgetMs: 500,
        commits: 2000,
        platform: process.platform,
      }),
      contentType: 'application/json',
    });
    expect(duration).toBeLessThan(500);
    expect(await page.getByRole('row').count()).toBeLessThan(100);
    await page.getByRole('grid').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.getByText('Commit 201 — linear', { exact: true })).toBeVisible();
    await expect(page.getByTestId('commit-count')).toHaveText('2,200 commits');
    await page.screenshot({ path: 'test-results/repository.png' });
    expect(errors).toEqual([]);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('status')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
