import { expect, type Page } from '@playwright/test';

export async function checkReleaseKeyboard(page: Page) {
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
      await expect(dialog).toBeVisible();
      if (buttonName === 'Crash reporting') {
        for (const control of [
          dialog.getByRole('checkbox'),
          dialog.getByRole('button', { name: 'Apply' }),
        ]) {
          if (await control.isEnabled()) {
            await expect(control).toBeFocused();
            await page.keyboard.press('Tab');
          }
        }
      }
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
      await page.keyboard.press(closeKey);
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
    }
    await page.keyboard.press('Tab');
  }
}
