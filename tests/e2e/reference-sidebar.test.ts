import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('large reference sidebar stays bounded and filtered actions survive scrolling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-many-refs-'));
  const repository = createFixture(join(root, 'repo'), 'linear', 2200);
  const commits = fixtureGit(repository, ['rev-list', '--max-count=1000', 'HEAD']).split('\n');
  fixtureGit(
    repository,
    ['update-ref', '--stdin'],
    commits
      .map((oid, index) => `create refs/heads/topic-${String(index).padStart(4, '0')} ${oid}`)
      .join('\n') + '\n',
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
    await expect(page.getByTestId('commit-count')).toContainText('2,000 commits');
    const sidebar = page.locator('.refs');
    expect(await sidebar.locator('.ref').count()).toBeLessThan(80);
    const filter = sidebar.getByRole('textbox', { name: 'Filter references', exact: true });
    await filter.fill('topic-0999');
    const rename = sidebar.getByRole('button', { name: 'Rename branch topic-0999', exact: true });
    await expect(rename).toBeVisible();
    await expect(sidebar.locator('.ref')).toHaveCount(1);
    await rename.focus();
    await rename.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Rename branch', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await filter.fill('');
    const scroll = sidebar.getByRole('list', { name: 'Reference list', exact: true });
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(
      sidebar.getByRole('button', { name: 'Delete tag v0.1.0', exact: true }),
    ).toBeVisible();
    expect(await sidebar.locator('.ref').count()).toBeLessThan(80);
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    await sidebar.getByRole('button', { name: 'Rename branch main', exact: true }).click();
    await expect(dialog).toBeVisible();
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Branch name', exact: true }).fill('main-renamed');
    await dialog.getByRole('button', { name: 'Rename branch', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('head')).toHaveText('main-renamed');
    expect(fixtureGit(repository, ['symbolic-ref', '--short', 'HEAD'])).toBe('main-renamed');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
