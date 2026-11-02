import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('command palette searches by category, respects availability and dialogs, and preserves frecency after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-commands-'));
  const args = [resolve('apps/desktop'), `--user-data-dir=${root}`];
  let app = await electron.launch({ args });
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeVisible({
      timeout: 1000,
    });
    await page.keyboard.press('Control+P');
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
    await page.keyboard.press('Control+P');
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
