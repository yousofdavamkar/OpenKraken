import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('cancelling a repository picker or clone dialog returns keyboard focus to its launcher', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'openkraken-entry-focus-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), '--lang=en-US', `--user-data-dir=${profile}`],
  });
  try {
    const page = await app.firstWindow();
    const welcome = page.getByRole('main');
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = () =>
        new Promise((resolve) => {
          Reflect.set(globalThis, 'cancelFixturePicker', () =>
            resolve({ canceled: true, filePaths: [] }),
          );
        });
    });
    async function cancelPicker() {
      await expect
        .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'cancelFixturePicker')))
        .toBe('function');
      await app.evaluate(() => {
        Reflect.get(globalThis, 'cancelFixturePicker')();
        Reflect.deleteProperty(globalThis, 'cancelFixturePicker');
      });
    }
    const open = welcome.getByRole('button', { name: 'Open a repository' });
    await open.press('Enter');
    await expect(open).toBeDisabled();
    await cancelPicker();
    await expect(open).toBeFocused();

    await welcome.getByRole('radio', { name: 'Clone a remote' }).check();
    const clone = welcome.getByRole('button', { name: 'Clone a repository' });
    await clone.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Clone repository' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(clone).toBeFocused();

    await welcome.getByRole('radio', { name: 'Start a new repository' }).check();
    const init = welcome.getByRole('button', { name: 'Initialize a repository' });
    await init.press('Enter');
    await page.getByRole('button', { name: 'Choose folder and initialize' }).press('Enter');
    await cancelPicker();
    await expect(init).toBeFocused();

    await welcome.getByRole('radio', { name: 'Open a folder' }).check();
    await open.press('Enter');
    await expect(open).toBeDisabled();
    const activity = page.getByRole('button', { name: 'Activity', exact: true });
    await activity.focus();
    await cancelPicker();
    await expect(open).toBeEnabled();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await expect(activity).toBeFocused();
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
