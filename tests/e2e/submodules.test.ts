import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('submodule view shows recursive state, refreshes stale selections and opens the reviewed checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-submodules-ui-'));
  const leaf = createFixture(join(root, 'leaf'), 'linear', 3);
  const child = createFixture(join(root, 'child'), 'linear', 2);
  fixtureGit(child, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--', leaf, 'nested']);
  fixtureGit(child, ['commit', '-am', 'Nested submodule']);
  const path = createFixture(join(root, 'parent'), 'linear', 3);
  fixtureGit(path, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--',
    child,
    'modules/child',
  ]);
  fixtureGit(path, ['commit', '-am', 'Child submodule']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Submodules', exact: true }).click({ timeout: 1500 });
    const dialog = page.getByRole('dialog', { name: 'Submodules', exact: true });
    const entries = dialog.getByRole('list', { name: 'Registered submodules' });
    const initialized = entries
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'modules/child', exact: true }) });
    const nested = entries
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'modules/child/nested', exact: true }) });
    await expect(initialized).toContainText('Clean');
    await expect(nested).toContainText('Uninitialized');
    await expect(
      nested.getByRole('button', { name: 'Open submodule', exact: true }),
    ).toBeDisabled();
    writeFileSync(join(path, 'modules/child/draft.txt'), 'new child draft');
    await initialized.getByRole('button', { name: 'Open submodule', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Submodules changed');
    await dialog.getByRole('button', { name: 'Refresh submodules', exact: true }).click();
    await expect(initialized).toContainText('1 changed file');
    await page.screenshot({ path: 'test-results/submodules.png' });
    await initialized.getByRole('button', { name: 'Open submodule', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'child', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stage draft.txt', exact: true })).toBeEnabled();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
