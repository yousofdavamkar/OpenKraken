import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('collocated refs stay bounded and every name is available in the keyboard-accessible list', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-commit-refs-'));
  const repository = createFixture(join(root, 'repo'), 'linear', 2200);
  const head = fixtureGit(repository, ['rev-parse', 'HEAD']);
  fixtureGit(
    repository,
    ['update-ref', '--stdin'],
    Array.from(
      { length: 2500 },
      (_, index) => `create refs/heads/topic-${String(index).padStart(4, '0')} ${head}\n`,
    ).join(''),
  );
  fixtureGit(repository, ['branch', 'Ångström']);
  fixtureGit(repository, ['update-ref', 'refs/remotes/origin/topic-0000', head]);
  fixtureGit(repository, ['tag', '-a', 'z-shared', '-m', 'A peeled tag on the same commit']);
  const count = fixtureGit(repository, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(*objectname)',
  ])
    .split('\n')
    .filter((line) => line.split('\0').slice(1).includes(head)).length;
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const grid = page.getByRole('grid', { name: 'Commit history', exact: true });
    const headRow = grid.locator(`[data-oid="${head}"]`);
    await expect(headRow).toBeVisible();
    expect(await headRow.locator('b.badge').count()).toBeLessThanOrEqual(3);
    await grid.focus();
    await grid.press('ArrowDown');
    const selected = await grid.getByRole('row', { selected: true }).getAttribute('data-oid');
    const opener = headRow.getByRole('button', {
      name: `Show all ${count.toLocaleString()} references for commit ${head.slice(0, 8)}`,
      exact: true,
    });
    await opener.focus();
    await opener.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Commit references', exact: true });
    await expect(dialog).toBeVisible();
    expect(await grid.getByRole('row', { selected: true }).getAttribute('data-oid')).toBe(selected);
    const filter = dialog.getByRole('textbox', { name: 'Filter commit references', exact: true });
    await expect(filter).toBeFocused();
    await expect(dialog.getByRole('status')).toHaveText(
      `${count.toLocaleString()} matching references`,
    );
    const list = dialog.getByRole('list', { name: 'References at this commit', exact: true });
    await expect(list.getByRole('listitem').first()).toBeVisible();
    expect(await list.getByRole('listitem').count()).toBeLessThan(40);
    await filter.fill('  ÅNGSTRÖM  ');
    await expect(list.getByRole('listitem')).toHaveText('refs/heads/Ångström');
    await expect(list.getByRole('listitem')).toHaveAttribute('aria-posinset', '1');
    await expect(list.getByRole('listitem')).toHaveAttribute('aria-setsize', '1');
    await filter.fill('refs/remotes/origin/topic-0000');
    await expect(list.getByRole('listitem')).toHaveText('refs/remotes/origin/topic-0000');
    await filter.fill('no-matching-reference');
    await expect(
      dialog.getByText('No references match this filter.', { exact: true }),
    ).toBeVisible();
    await filter.fill('   ');
    await list.focus();
    await list.press('End');
    await expect(list.getByText('refs/tags/z-shared', { exact: true })).toBeVisible();
    expect(await list.getByRole('listitem').count()).toBeLessThan(40);
    await list.press('Home');
    await expect(list.getByText('refs/heads/main', { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('commit-references.png') });
    await filter.fill('topic-2499');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    fixtureGit(repository, ['update-ref', '-d', 'refs/heads/topic-2499']);
    await expect(list.getByRole('listitem')).toHaveCount(0);
    await filter.fill('');
    await expect(dialog.getByRole('status')).toHaveText(
      `${(count - 1).toLocaleString()} matching references`,
    );
    await grid.evaluate((element) => {
      element.scrollTop = 6000;
    });
    await expect(headRow).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await filter.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(grid).toBeFocused();
    await grid.evaluate((element) => {
      element.scrollTop = 0;
    });
    const updatedOpener = headRow.getByRole('button', {
      name: `Show all ${(count - 1).toLocaleString()} references for commit ${head.slice(0, 8)}`,
      exact: true,
    });
    await updatedOpener.click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(updatedOpener).toBeFocused();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('one grouped badge bounds its tooltip and exposes every remote name', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-grouped-refs-'));
  const repository = createFixture(join(root, 'repo'), 'linear', 5);
  const head = fixtureGit(repository, ['rev-parse', 'HEAD']);
  fixtureGit(
    repository,
    ['update-ref', '--stdin'],
    Array.from(
      { length: 50 },
      (_, index) => `create refs/remotes/upstream-${String(index).padStart(2, '0')}/main ${head}\n`,
    ).join(''),
  );
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const row = page.getByRole('grid').locator(`[data-oid="${head}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('b.badge')).toHaveCount(3);
    const branch = row.locator('b.badge.branch');
    await expect(branch).toHaveText('main (51)');
    await expect(branch).toHaveAttribute(
      'title',
      'refs/heads/main\nrefs/remotes/upstream-00/main\nrefs/remotes/upstream-01/main\n… 48 more references',
    );
    await row.getByRole('button', { name: /^Show all 53 references/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Commit references', exact: true });
    await dialog.getByRole('textbox', { name: 'Filter commit references' }).fill('UPSTREAM-49');
    await expect(dialog.getByRole('listitem')).toHaveText('refs/remotes/upstream-49/main');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
