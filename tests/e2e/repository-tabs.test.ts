import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture } from '../../packages/test-fixtures/src/index.js';

test('repository tabs switch between opened repositories and refuse unknown ones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-tabs-'));
  const first = createFixture(join(root, 'alpha'), 'linear', 3);
  const second = createFixture(join(root, 'beta'), 'merge');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    const pick = (path: string) =>
      app.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
      }, path);
    const tabs = page.getByRole('navigation', { name: 'Repository tabs' });
    await pick(first);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'alpha', exact: true })).toBeVisible();
    // A single tab cannot be closed; there is no empty repository view to return to.
    await expect(tabs.getByRole('button', { name: 'Close tab alpha' })).toHaveCount(0);

    await pick(second);
    await tabs.getByRole('button', { name: 'New tab', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'beta', exact: true })).toBeVisible();
    const alpha = tabs.getByRole('button', { name: 'Repository tab alpha', exact: true });
    const beta = tabs.getByRole('button', { name: 'Repository tab beta', exact: true });
    await expect(beta).toHaveAttribute('aria-current', 'page');

    await alpha.click();
    await expect(page.getByRole('heading', { name: 'alpha', exact: true })).toBeVisible();
    await expect(page.getByTestId('commit-count')).toHaveText('3 commits');
    await expect(alpha).toHaveAttribute('aria-current', 'page');

    await tabs.getByRole('button', { name: 'Close tab alpha', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'beta', exact: true })).toBeVisible();
    await expect(alpha).toHaveCount(0);

    const refused = await page.evaluate(() =>
      window.openkraken
        .request({
          id: crypto.randomUUID(),
          method: 'reopenRepository',
          repoId: 'f'.repeat(64),
        })
        .then(
          (result) => JSON.stringify(result),
          (error: unknown) => String(error),
        ),
    );
    expect(refused).toContain('no longer available');
    await expect(page.getByRole('heading', { name: 'beta', exact: true })).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('repository tabs are restored after a restart and reopen on selection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-tabs-restart-'));
  const first = createFixture(join(root, 'alpha'), 'linear', 3);
  const second = createFixture(join(root, 'beta'), 'merge');
  const third = createFixture(join(root, 'gamma'), 'linear', 2);
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
    let tabs = page.getByRole('navigation', { name: 'Repository tabs' });
    await pick(first);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'alpha', exact: true })).toBeVisible();
    for (const [path, name] of [
      [second, 'beta'],
      [third, 'gamma'],
    ] as const) {
      await pick(path);
      await tabs.getByRole('button', { name: 'New tab', exact: true }).click();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    await tabs.getByRole('button', { name: 'Close tab gamma', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'beta', exact: true })).toBeVisible();
    await tabs.getByRole('button', { name: 'Repository tab alpha', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'alpha', exact: true })).toBeVisible();
    await app.close();
    expect(statSync(join(profile, 'repository-tabs.json')).mode & 0o777).toBe(0o600);

    app = await launch();
    page = await app.firstWindow();
    tabs = page.getByRole('navigation', { name: 'Repository tabs' });
    // Saved tabs return in order without opening a repository; closed tabs stay closed.
    await expect(tabs.getByRole('button', { name: /^Repository tab / })).toHaveText([
      'alpha',
      'beta',
    ]);
    await expect(
      page.getByRole('button', { name: 'Open a repository', exact: true }),
    ).toBeVisible();
    await expect(tabs.locator('[aria-current="page"]')).toHaveCount(0);
    await tabs.getByRole('button', { name: 'Repository tab alpha', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'alpha', exact: true })).toBeVisible();
    await expect(page.getByTestId('commit-count')).toHaveText('3 commits');
    await expect(
      tabs.getByRole('button', { name: 'Repository tab alpha', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await tabs.getByRole('button', { name: 'Repository tab beta', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'beta', exact: true })).toBeVisible();

    // A saved repository that disappeared reports an error and can still be closed.
    rmSync(first, { recursive: true, force: true });
    await tabs.getByRole('button', { name: 'Repository tab alpha', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'beta', exact: true })).toBeVisible();
    await tabs.getByRole('button', { name: 'Close tab alpha', exact: true }).click();
    await expect(tabs.getByRole('button', { name: /^Repository tab / })).toHaveText(['beta']);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('many repository tabs scroll without covering the title bar tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-tabs-overflow-'));
  const names = Array.from({ length: 6 }, (_, i) => `repository-with-a-long-name-${i}`);
  const paths = names.map((name) => createFixture(join(root, name), 'linear', 2));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    const tabs = page.getByRole('navigation', { name: 'Repository tabs' });
    for (const [index, path] of paths.entries()) {
      await app.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
      }, path);
      await (
        index === 0
          ? page.getByRole('button', { name: 'Open a repository', exact: true })
          : tabs.getByRole('button', { name: 'New tab', exact: true })
      ).click();
      await expect(page.getByRole('heading', { name: names[index], exact: true })).toBeVisible();
    }
    // Every title bar control must still receive pointer input.
    const tools = page.locator('.titlebar-tools button:visible');
    for (const button of await tools.all()) await button.click({ trial: true, timeout: 2000 });
    const strip = await tabs.boundingBox();
    const toolsBox = await page.locator('.titlebar-tools').boundingBox();
    expect(strip!.x + strip!.width).toBeLessThanOrEqual(toolsBox!.x + 1);
    // The active tab is scrolled into view.
    await expect(
      tabs.getByRole('button', { name: `Repository tab ${names[5]}`, exact: true }),
    ).toBeInViewport();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
