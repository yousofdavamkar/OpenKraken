import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the welcome screen uses the preferred regional language and updates when it changes', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'openkraken-welcome-lang-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), '--lang=es-MX', `--user-data-dir=${profile}`],
  });
  try {
    const page = await app.firstWindow();
    const welcome = page.getByRole('main');
    await expect(welcome).toHaveAttribute('lang', 'es');
    await expect(welcome.getByRole('button', { name: 'Abrir un repositorio' })).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['ja-JP'] });
      window.dispatchEvent(new Event('languagechange'));
    });
    await expect(welcome).toHaveAttribute('lang', 'en');
    await expect(welcome.getByRole('button', { name: 'Open a repository' })).toBeVisible();
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
