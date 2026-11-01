import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture } from '../../packages/test-fixtures/src/index.js';
test('graph view preferences survive a complete desktop restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-restart-'));
  const repository = createFixture(join(root, 'repo'), 'orphan');
  const args = [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`];
  let app = await electron.launch({ args });
  const open = async () => {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByTestId('commit-graph')).toBeVisible();
    return page;
  };
  try {
    let page = await open();
    await page.getByRole('button', { name: 'Solo refs/heads/other', exact: true }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('2 commits');
    await page.getByRole('button', { name: 'Pin refs/heads/other', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Pin refs/heads/other', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await app.close();
    app = await electron.launch({ args });
    page = await open();
    await expect(page.getByTestId('commit-count')).toHaveText('2 commits');
    for (const action of ['Pin', 'Solo'])
      await expect(
        page.getByRole('button', { name: `${action} refs/heads/other`, exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Reset graph view', exact: true }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('4 commits');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
