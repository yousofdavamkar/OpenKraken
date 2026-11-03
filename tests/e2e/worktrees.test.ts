import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('worktree rows arrive with their parent page without moving prior graph lanes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-worktree-page-ui-'));
  const path = createFixture(join(root, 'source'), 'linear', 2200);
  const linked = join(root, 'page-anchored-checkout');
  const head = fixtureGit(path, ['rev-parse', 'HEAD~2100']);
  fixtureGit(path, ['worktree', 'add', '--detach', linked, head]);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const grid = page.getByRole('grid');
    await expect(page.getByTestId('commit-count')).toHaveText('2,000 commits · more available');
    const before = await grid
      .getByRole('row')
      .evaluateAll((rows) =>
        rows
          .slice(0, 10)
          .map((row) => [
            row.getAttribute('data-oid'),
            row.getAttribute('data-column'),
            row.getAttribute('style'),
          ]),
      );
    const search = page.getByRole('textbox', { name: 'Search commits' });
    await search.fill('page-anchored-checkout');
    await expect(page.getByText('0 loaded matches', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Load more commits', exact: true }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('2,200 commits');
    expect(
      await grid
        .getByRole('row')
        .evaluateAll((rows) =>
          rows
            .slice(0, 10)
            .map((row) => [
              row.getAttribute('data-oid'),
              row.getAttribute('data-column'),
              row.getAttribute('style'),
            ]),
        ),
    ).toEqual(before);
    await expect(page.getByText('1 loaded matches', { exact: true })).toBeVisible();
    await search.press('Enter');
    const row = grid.getByRole('row', { selected: true });
    await expect(row).toContainText(linked);
    const parent = grid.locator(`[data-oid="${head}"]`);
    expect(Number(await row.getAttribute('aria-rowindex')) + 1).toBe(
      Number(await parent.getAttribute('aria-rowindex')),
    );
    await grid.focus();
    await grid.press('Shift+ArrowDown');
    await expect(parent).toHaveAttribute('aria-selected', 'true');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('graph shows each linked checkout above its HEAD and supports worktree row details and ancestry navigation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-worktree-graph-ui-'));
  const path = createFixture(join(root, 'source'), 'linear', 3);
  const detached = join(root, 'detached-checkout');
  const clean = join(root, 'clean-checkout');
  fixtureGit(path, ['worktree', 'add', '--detach', detached]);
  fixtureGit(detached, ['commit', '--allow-empty', '-m', 'Detached graph commit']);
  const head = fixtureGit(detached, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['worktree', 'add', '--detach', clean, head]);
  writeFileSync(join(detached, 'draft.txt'), 'unfinished');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const grid = page.getByRole('grid');
    const dirtyRow = grid.getByRole('row').filter({ hasText: detached });
    const cleanRow = grid.getByRole('row').filter({ hasText: clean });
    await expect(dirtyRow).toContainText('1 uncommitted change', { timeout: 1500 });
    await expect(cleanRow).toContainText('Clean');
    const parent = grid.locator(`[data-oid="${head}"]`);
    expect(Number(await dirtyRow.getAttribute('aria-rowindex'))).toBeLessThan(
      Number(await parent.getAttribute('aria-rowindex')),
    );
    expect(Number(await cleanRow.getAttribute('aria-rowindex'))).toBeLessThan(
      Number(await parent.getAttribute('aria-rowindex')),
    );
    await dirtyRow.click();
    await grid.press('Enter');
    await expect(page.getByRole('region', { name: 'Commit details' })).toContainText(detached);
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    await grid.focus();
    await grid.press('Shift+ArrowDown');
    await expect(parent).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({ path: 'test-results/worktree-graph.png' });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('worktree cleanup is reviewed, cancellable and revalidated while locked registrations survive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-worktrees-prune-ui-'));
  const path = createFixture(join(root, 'source'), 'linear', 3);
  const missing = join(root, 'missing-checkout');
  const locked = join(root, 'locked-checkout');
  fixtureGit(path, ['worktree', 'add', '-b', 'missing-topic', missing]);
  fixtureGit(path, ['worktree', 'add', '-b', 'locked-topic', locked]);
  fixtureGit(path, ['worktree', 'lock', '--reason', 'offline drive', locked]);
  rmSync(missing, { recursive: true });
  rmSync(locked, { recursive: true });
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
    const reviewButton = dialog.getByRole('button', { name: 'Review cleanup', exact: true });
    const entries = dialog.getByRole('list', { name: 'Registered worktrees', exact: true });
    await reviewButton.click({ timeout: 1500 });
    const review = dialog.getByRole('group', { name: 'Review worktree cleanup', exact: true });
    await expect(review.getByLabel('Git cleanup report', { exact: true })).toContainText(
      'missing-checkout',
    );
    await expect(review.getByRole('button', { name: 'Cancel cleanup', exact: true })).toBeFocused();
    await review.getByRole('button', { name: 'Cancel cleanup', exact: true }).click();
    await expect(reviewButton).toBeFocused();
    await expect(entries.getByRole('listitem')).toHaveCount(3);
    await reviewButton.click();
    await expect(review).toBeVisible();
    fixtureGit(path, ['worktree', 'lock', missing]);
    await review.getByRole('button', { name: 'Confirm cleanup', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('cleanup changed');
    await expect(entries.getByRole('listitem')).toHaveCount(3);
    fixtureGit(path, ['worktree', 'unlock', missing]);
    await reviewButton.click();
    await expect(review.getByLabel('Git cleanup report', { exact: true })).toContainText(
      'missing-checkout',
    );
    await page.screenshot({ path: 'test-results/worktree-prune-review.png' });
    await review.getByRole('button', { name: 'Confirm cleanup', exact: true }).click();
    await expect(entries.getByRole('listitem')).toHaveCount(2);
    await expect(entries.getByRole('listitem').filter({ hasText: locked })).toContainText('Locked');
    await expect(reviewButton).toBeFocused();
    expect(fixtureGit(path, ['branch', '--list', 'missing-topic'])).toContain('missing-topic');
    await reviewButton.click();
    await expect(review).toContainText('No stale worktree registrations need cleanup');
    await expect(
      review.getByRole('button', { name: 'Confirm cleanup', exact: true }),
    ).toBeDisabled();
    await review.getByRole('button', { name: 'Cancel cleanup', exact: true }).click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('worktree lock and removal reviews preserve files and retain the branch after clean removal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-worktrees-manage-ui-'));
  const path = createFixture(join(root, 'source'), 'linear', 3);
  const linked = join(root, 'managed-checkout');
  fixtureGit(path, ['worktree', 'add', '-b', 'retained-branch', linked]);
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
    const row = dialog.getByRole('listitem').filter({ hasText: linked });
    await row.getByRole('button', { name: 'Lock worktree', exact: true }).click({ timeout: 1500 });
    const review = dialog.getByRole('group', { name: 'Review worktree action', exact: true });
    await expect(review.getByRole('textbox', { name: 'Lock reason', exact: true })).toBeFocused();
    await review.getByRole('textbox', { name: 'Lock reason', exact: true }).fill('Portable drive');
    await review.getByRole('button', { name: 'Confirm lock', exact: true }).click();
    await expect(row).toContainText('Locked · Portable drive');
    await expect(row.getByRole('button', { name: 'Unlock worktree', exact: true })).toBeFocused();
    await expect(row.getByRole('button', { name: 'Remove worktree', exact: true })).toBeDisabled();
    await row.getByRole('button', { name: 'Unlock worktree', exact: true }).click();
    await review.getByRole('button', { name: 'Confirm unlock', exact: true }).click();
    await row.getByRole('button', { name: 'Remove worktree', exact: true }).click();
    await expect(review).toContainText(linked);
    await expect(review.getByRole('button', { name: 'Cancel action', exact: true })).toBeFocused();
    await review.getByRole('button', { name: 'Cancel action', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Remove worktree', exact: true })).toBeFocused();
    expect(existsSync(linked)).toBe(true);
    await row.getByRole('button', { name: 'Remove worktree', exact: true }).click();
    writeFileSync(join(linked, 'late-draft.txt'), 'created after review');
    await review.getByRole('button', { name: 'Confirm removal', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('changed, untracked or ignored files');
    expect(readFileSync(join(linked, 'late-draft.txt'), 'utf8')).toBe('created after review');
    rmSync(join(linked, 'late-draft.txt'));
    await review.getByRole('button', { name: 'Confirm removal', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'Refresh worktrees', exact: true }),
    ).toBeFocused();
    expect(existsSync(linked)).toBe(false);
    expect(fixtureGit(path, ['branch', '--list', 'retained-branch'])).toContain('retained-branch');
    await page.screenshot({ path: 'test-results/worktree-management.png' });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(
      page.getByRole('grid').getByRole('row').filter({ hasText: destination }),
    ).toContainText('Clean');
    await page.getByRole('button', { name: 'Worktrees', exact: true }).click();
    await row.getByRole('button', { name: 'Open worktree', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'feature-checkout', exact: true }),
    ).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
