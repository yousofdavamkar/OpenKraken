import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture } from '../../packages/test-fixtures/src/index.js';

test('history columns resize by pointer and keyboard and persist per repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-columns-'));
  const first = createFixture(join(root, 'alpha'), 'linear', 4);
  const second = createFixture(join(root, 'beta'), 'linear', 2);
  const profile = join(root, 'profile');
  const launch = () =>
    electron.launch({ args: [resolve('apps/desktop'), `--user-data-dir=${profile}`] });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const pick = (path: string) =>
      app.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
      }, path);
    const template = () =>
      page
        .locator('.commit-row')
        .first()
        .evaluate((row) => getComputedStyle(row).gridTemplateColumns);
    const author = () => page.getByRole('separator', { name: 'Resize Author column', exact: true });
    await pick(first);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'alpha', exact: true })).toBeVisible();
    await expect(author()).toHaveAttribute('aria-valuenow', '130');
    const box = (await author().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(author()).toHaveAttribute('aria-valuenow', '190');
    expect((await template()).split(' ').at(-2)).toBe('190px');
    await author().focus();
    await page.keyboard.press('ArrowLeft');
    await expect(author()).toHaveAttribute('aria-valuenow', '180');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(author()).toHaveAttribute('aria-valuenow', '230');
    const date = page.getByRole('separator', { name: 'Resize Date column', exact: true });
    await date.focus();
    for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowLeft');
    await expect(date).toHaveAttribute('aria-valuenow', '60');

    // Another repository keeps the default widths.
    await pick(second);
    await page
      .getByRole('navigation', { name: 'Repository tabs' })
      .getByRole('button', { name: 'New tab', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'beta', exact: true })).toBeVisible();
    await expect(author()).toHaveAttribute('aria-valuenow', '130');
    await app.close();

    app = await launch();
    page = await app.firstWindow();
    await page
      .getByRole('navigation', { name: 'Repository tabs' })
      .getByRole('button', { name: 'Repository tab alpha', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'alpha', exact: true })).toBeVisible();
    await expect(author()).toHaveAttribute('aria-valuenow', '230');
    await expect(page.getByRole('separator', { name: 'Resize Date column' })).toHaveAttribute(
      'aria-valuenow',
      '60',
    );
    expect(await template()).toMatch(/ 230px 60px$/);
    await author().focus();
    await page.keyboard.press('Home');
    await expect(author()).toHaveAttribute('aria-valuenow', '130');
    await author().dblclick();
    await expect(author()).toHaveAttribute('aria-valuenow', '130');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
