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
    for (const name of ['Worktrees', 'Submodules', 'Git LFS'])
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Stage draft.txt', exact: true })).toBeEnabled();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('submodule update requires review, refreshes stale plans and initializes recursive checkouts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-submodule-update-ui-'));
  const leaf = createFixture(join(root, 'leaf'), 'linear', 2);
  const child = createFixture(join(root, 'child'), 'linear', 2);
  fixtureGit(child, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--', leaf, 'nested']);
  fixtureGit(child, ['commit', '-am', 'Nested submodule']);
  const original = createFixture(join(root, 'original'), 'linear', 3);
  fixtureGit(original, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--',
    child,
    'child',
  ]);
  fixtureGit(original, ['commit', '-am', 'Child submodule']);
  const path = join(root, 'parent');
  fixtureGit(root, ['clone', original, path]);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Submodules', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Submodules', exact: true });
    const review = dialog.getByRole('group', { name: 'Review recursive submodule update' });
    await dialog.getByRole('button', { name: 'Review update', exact: true }).click();
    await expect(review).toBeVisible();
    await expect(review.getByRole('button', { name: 'Cancel review', exact: true })).toBeFocused();
    await expect(
      review.getByRole('checkbox', { name: 'Allow local-file sources' }),
    ).not.toBeChecked();
    await expect(review).toContainText(child);
    await page.screenshot({ path: 'test-results/submodule-update-review.png' });
    await review.getByRole('button', { name: 'Cancel review', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Review update', exact: true })).toBeFocused();
    await expect(dialog.getByRole('list', { name: 'Registered submodules' })).toContainText(
      'Uninitialized',
    );
    const refresh = dialog.getByRole('button', { name: 'Refresh submodules', exact: true });
    await refresh.click();
    await expect(refresh).toBeEnabled();
    await expect(refresh).toBeFocused();
    await dialog.getByRole('button', { name: 'Review update', exact: true }).click();
    await expect(review).toBeVisible();
    fixtureGit(path, ['config', 'submodule.child.url', child]);
    await review.getByRole('checkbox', { name: 'Allow local-file sources' }).check();
    await review.getByRole('button', { name: 'Initialize and update', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('changed');
    await expect(review).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Review update', exact: true }).click();
    await review.getByRole('checkbox', { name: 'Allow local-file sources' }).check();
    await review.getByRole('button', { name: 'Initialize and update', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Submodules updated');
    const entries = dialog.getByRole('list', { name: 'Registered submodules' });
    await expect(entries.getByRole('listitem')).toHaveCount(2);
    await expect(
      entries.getByRole('button', { name: 'Open submodule', exact: true }).nth(1),
    ).toBeEnabled();
    expect(fixtureGit(join(path, 'child/nested'), ['rev-parse', 'HEAD'])).toBe(
      fixtureGit(leaf, ['rev-parse', 'HEAD']),
    );
    await page.screenshot({ path: 'test-results/submodule-update.png' });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cancelling a submodule fetch releases the dialog and requires a fresh review', async () => {
  const { createServer } = await import('node:http');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-submodule-cancel-ui-'));
  let requests = 0;
  const server = createServer(() => {
    requests++;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const path = createFixture(join(root, 'parent'), 'linear', 2);
  fixtureGit(path, ['config', '--file', '.gitmodules', 'submodule.child.path', 'child']);
  fixtureGit(path, [
    'config',
    '--file',
    '.gitmodules',
    'submodule.child.url',
    `http://127.0.0.1:${address.port}/repo.git`,
  ]);
  fixtureGit(path, ['add', '.gitmodules']);
  fixtureGit(path, [
    'update-index',
    '--add',
    '--cacheinfo',
    `160000,${fixtureGit(path, ['rev-parse', 'HEAD'])},child`,
  ]);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Submodules', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Submodules', exact: true });
    await dialog.getByRole('button', { name: 'Review update', exact: true }).click();
    await dialog.getByRole('button', { name: 'Initialize and update', exact: true }).click();
    await expect.poll(() => requests).toBeGreaterThan(0);
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel update', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Update cancelled');
    await expect(dialog.getByRole('alert')).toContainText(
      'Some submodules may already have changed',
    );
    await expect(
      dialog.getByRole('group', { name: 'Review recursive submodule update' }),
    ).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Review update', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Refresh submodules', exact: true }).click();
    await expect(dialog.getByRole('list', { name: 'Registered submodules' })).toContainText(
      'Uninitialized',
    );
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
});
