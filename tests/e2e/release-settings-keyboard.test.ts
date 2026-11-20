import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('release and diagnostics dialogs return keyboard users to the toolbar', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'openkraken-release-keyboard-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Crash reporting', exact: true }).focus();
    for (const [buttonName, dialogName] of [
      ['Crash reporting', 'Crash reporting'],
      ['Activity', 'Activity'],
      ['Diagnostics', 'Local diagnostics'],
      ['Updates', 'App updates'],
    ] as const) {
      const opener = page.getByRole('button', { name: buttonName, exact: true });
      const dialog = page.getByRole('dialog', { name: dialogName, exact: true });
      await expect(opener).toBeFocused();
      for (const [openKey, closeKey] of [
        ['Enter', 'Enter'],
        ['Space', 'Escape'],
      ] as const) {
        await page.keyboard.press(openKey);
        await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
        await page.keyboard.press(closeKey);
        await expect(dialog).toHaveCount(0);
        await expect(opener).toBeFocused();
      }
      await page.keyboard.press('Tab');
    }
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
