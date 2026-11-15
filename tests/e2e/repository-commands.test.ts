import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('branch palette finds offscreen refs and solos their native history while retaining the checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-palette-refs-'));
  const repo = createFixture(join(root, 'repo'));
  const tip = fixtureGit(repo, ['rev-parse', 'HEAD~3']);
  const refs = Array.from({ length: 120 }, (_, i) => `create refs/heads/topic-${i} ${tip}\n`).join(
    '',
  );
  fixtureGit(repo, ['update-ref', '--stdin'], refs);
  fixtureGit(repo, ['branch', 'Ångström/topic', tip]);
  fixtureGit(repo, ['branch', 'origin/main', tip]);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    const commands = page.getByRole('button', { name: 'Commands', exact: true });
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    const category = palette.getByLabel('Command category');
    await commands.click();
    await expect(category.locator('option', { hasText: 'Branches' })).toHaveCount(0);
    await palette.getByLabel('Search commands').press('Escape');
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByTestId('head')).toHaveText('main');
    await commands.click();
    await category.selectOption('Branches');
    const options = palette.getByRole('listbox').getByRole('option');
    await expect(options).toHaveCount(50);
    await expect(palette.getByRole('status')).toContainText('50 of 124');
    const search = palette.getByLabel('Search commands');
    await search.fill('Ångstr');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toHaveAccessibleName('Show only Ångström/topic in graph');
    await search.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect(page.getByLabel('Active graph view')).toContainText(
      'Solo: refs/heads/Ångström/topic',
    );
    await expect(page.getByTestId('commit-count')).toHaveText('5 commits');
    await expect(page.getByRole('grid', { name: 'Commit history' })).toBeFocused();
    await commands.click();
    await category.selectOption('Branches');
    await search.fill('origin/main');
    const twins = palette.getByRole('option', {
      name: 'Show only origin/main in graph',
      exact: true,
    });
    await expect(twins).toHaveCount(2);
    const names = await twins.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('aria-description')).sort(),
    );
    expect(names).toEqual(['refs/heads/origin/main', 'refs/remotes/origin/main']);
    await search.fill('refs/remotes/origin/main');
    await expect(options.first()).toHaveAccessibleDescription('refs/remotes/origin/main');
    await search.press('Enter');
    await expect(page.getByLabel('Active graph view')).toContainText(
      'Solo: refs/remotes/origin/main',
    );
    expect(fixtureGit(repo, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('changed-file palette opens each side of a partially staged file and tracks external status changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-palette-files-'));
  const repo = createFixture(join(root, 'repo'));
  writeFileSync(join(repo, 'tracked.txt'), 'index content\n');
  fixtureGit(repo, ['add', 'tracked.txt']);
  writeFileSync(join(repo, 'tracked.txt'), 'worktree content\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByTestId('head')).toHaveText('main');
    const commands = page.getByRole('button', { name: 'Commands', exact: true });
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    const input = palette.getByLabel('Search commands');
    for (const [side, content] of [
      ['staged', 'index content'],
      ['unstaged', 'worktree content'],
    ] as const) {
      await commands.click();
      await palette.getByLabel('Command category').selectOption('Changed files');
      await input.fill('trtxt');
      await expect(palette.getByRole('listbox').getByRole('option')).toHaveCount(2);
      await palette.getByRole('option', { name: `View ${side} tracked.txt`, exact: true }).click();
      const diff = page.getByRole('dialog', { name: 'Working file changes' });
      await expect(
        diff.getByText(side === 'staged' ? 'Staged changes' : 'Unstaged changes', { exact: true }),
      ).toBeVisible();
      await expect(diff).toContainText(content);
      await diff.getByRole('button', { name: 'Close diff' }).click();
    }
    await commands.click();
    await palette.getByLabel('Command category').selectOption('Changed files');
    await input.fill('new file');
    await expect(palette.getByText('No commands match.')).toBeVisible();
    writeFileSync(join(repo, 'new file.txt'), 'new\n');
    await expect(palette.getByRole('option', { name: 'View unstaged new file.txt' })).toBeVisible();
    rmSync(join(repo, 'new file.txt'));
    await expect(palette.getByText('No commands match.')).toBeVisible();
    expect(fixtureGit(repo, ['show', ':tracked.txt'])).toBe('index content');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
