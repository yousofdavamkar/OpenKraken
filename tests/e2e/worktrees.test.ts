import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('worktrees show checkout state and refresh stale selections before opening a linked repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-worktrees-ui-'));
  const path = createFixture(join(root, 'main-repository'), 'linear', 3);
  const linked = join(root, 'linked-checkout');
  fixtureGit(path, ['worktree', 'add', '-b', 'topic', linked]);
  writeFileSync(join(linked, 'draft.txt'), 'unfinished');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Worktrees', exact: true }).click({ timeout: 1500 });
    const dialog = page.getByRole('dialog', { name: 'Worktrees', exact: true });
    const row = dialog.getByRole('listitem').filter({ hasText: linked });
    await expect(row).toContainText('1 changed file');
    fixtureGit(path, ['worktree', 'lock', '--reason', 'portable drive', linked]);
    await row.getByRole('button', { name: 'Open worktree', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Worktrees changed');
    await dialog.getByRole('button', { name: 'Refresh worktrees', exact: true }).click();
    await expect(row).toContainText('portable drive');
    await row.getByRole('button', { name: 'Open worktree', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'linked-checkout', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Worktrees', exact: true }).click();
    await expect(dialog.getByRole('listitem').filter({ hasText: linked })).toContainText('Current');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('worktree creation preserves choices on picker cancellation and errors, and supports existing branches and detached HEAD', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-worktrees-modes-ui-'));
  const path = createFixture(join(root, 'source'), 'linear', 3);
  fixtureGit(path, ['branch', 'spare', 'HEAD~1']);
  const selected = fixtureGit(path, ['rev-parse', 'spare']);
  const existing = join(root, 'existing-checkout');
  const detached = join(root, 'detached-checkout');
  const occupied = join(root, 'occupied');
  for (const directory of [existing, detached, occupied]) mkdirSync(directory);
  writeFileSync(join(occupied, 'keep.txt'), 'keep me');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    const pick = (path: string | null) =>
      app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({
          canceled: path === null,
          filePaths: path ? [path] : [],
        });
      }, path);
    await pick(path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Worktrees', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Worktrees', exact: true });
    const create = dialog.getByRole('button', {
      name: 'Choose folder and create worktree',
      exact: true,
    });
    await expect(dialog.getByRole('combobox', { name: 'Checkout', exact: true })).toBeEnabled();
    await dialog.getByRole('combobox', { name: 'Checkout', exact: true }).selectOption('existing');
    await dialog
      .getByRole('combobox', { name: 'Existing branch', exact: true })
      .selectOption('spare');
    await expect(dialog.getByLabel('Starting commit', { exact: true })).toHaveValue(selected);
    await pick(null);
    await create.click();
    await expect(create).toBeEnabled();
    await expect(
      dialog.getByRole('combobox', { name: 'Existing branch', exact: true }),
    ).toHaveValue('spare');
    await expect(dialog.getByRole('listitem')).toHaveCount(1);
    await pick(occupied);
    await create.click();
    await expect(dialog.getByRole('alert')).toContainText('empty folder');
    await expect(
      dialog.getByRole('combobox', { name: 'Existing branch', exact: true }),
    ).toHaveValue('spare');
    await pick(existing);
    await create.click();
    await expect(dialog.getByRole('listitem').filter({ hasText: existing })).toContainText('spare');
    await dialog.getByRole('combobox', { name: 'Checkout', exact: true }).selectOption('detached');
    await dialog.getByLabel('Starting commit', { exact: true }).fill(selected);
    await pick(detached);
    await create.click();
    await expect(dialog.getByRole('listitem').filter({ hasText: detached })).toContainText(
      'Detached HEAD',
    );
    expect(fixtureGit(detached, ['rev-parse', 'HEAD'])).toBe(selected);
    await page.screenshot({ path: 'test-results/worktrees.png' });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a new worktree is created through the folder picker and can be opened without switching the original branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-worktrees-create-ui-'));
  const path = createFixture(join(root, 'source'), 'linear', 3);
  const destination = join(root, 'feature-checkout');
  mkdirSync(destination);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Worktrees', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Worktrees', exact: true });
    await dialog
      .getByRole('textbox', { name: 'New branch name', exact: true })
      .fill('feature/from-ui', { timeout: 1500 });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, destination);
    await dialog
      .getByRole('button', { name: 'Choose folder and create worktree', exact: true })
      .click();
    const row = dialog.getByRole('listitem').filter({ hasText: destination });
    await expect(row).toContainText('feature/from-ui');
    await expect(row).toContainText('Clean');
    expect(fixtureGit(path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    expect(fixtureGit(destination, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/feature/from-ui');
    await page.screenshot({ path: 'test-results/worktrees.png' });
    await row.getByRole('button', { name: 'Open worktree', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'feature-checkout', exact: true }),
    ).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
