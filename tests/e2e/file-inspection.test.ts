import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
test('commit details list changed files against the selected merge parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-files-ui-'));
  const path = createFixture(join(root, 'repository'));
  fixtureGit(path, ['switch', '-c', 'incoming']);
  writeFileSync(join(path, 'incoming.txt'), 'incoming\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Incoming file']);
  const incoming = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['switch', 'main']);
  writeFileSync(join(path, 'local.txt'), 'local\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Local file']);
  fixtureGit(path, ['merge', '--no-ff', '--no-edit', 'incoming']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const grid = page.getByRole('grid', { name: 'Commit history' });
    await grid.press('Home');
    await grid.press('Enter');
    const details = page.getByRole('region', { name: 'Commit details' });
    const files = details.getByRole('list', { name: 'Changed files' });
    await expect(files.getByText('incoming.txt', { exact: true })).toBeVisible();
    await details.getByRole('combobox', { name: 'Compare parent' }).selectOption(incoming);
    await expect(files.getByText('local.txt', { exact: true })).toBeVisible();
    await expect(files.getByText('incoming.txt', { exact: true })).toHaveCount(0);
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('commit file comparisons switch views and whitespace without changing the repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-comparison-ui-'));
  const path = createFixture(join(root, 'repository'));
  writeFileSync(join(path, 'sample.ts'), 'const value = 1;\nconst spacing = 2;\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Before text']);
  writeFileSync(join(path, 'sample.ts'), 'const value = 3;\nconst spacing  =  2;\n');
  fixtureGit(path, ['commit', '-am', 'Change text']);
  const head = fixtureGit(path, ['rev-parse', 'HEAD']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const grid = page.getByRole('grid', { name: 'Commit history' });
    await grid.press('Home');
    await grid.press('Enter');
    await page.getByRole('button', { name: 'Compare sample.ts', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: 'File comparison' });
    await expect(viewer.getByText('const value = 1;', { exact: true })).toBeVisible();
    await expect(viewer.getByText('const value = 3;', { exact: true })).toBeVisible();
    await viewer.getByRole('combobox', { name: 'Diff view' }).selectOption('split');
    await expect(viewer.locator('.cm-mergeView .cm-editor')).toHaveCount(2);
    await viewer.getByRole('combobox', { name: 'Diff view' }).selectOption('inline');
    await expect(viewer.locator('.cm-editor')).toHaveCount(1);
    await viewer.getByRole('combobox', { name: 'Diff view' }).selectOption('hunks');
    await viewer.getByRole('combobox', { name: 'Whitespace' }).selectOption('all');
    await expect(viewer.getByText('const spacing = 2;', { exact: true })).toHaveCount(0);
    await expect(viewer.getByText('const spacing  =  2;', { exact: true })).toBeVisible();
    await viewer.getByRole('button', { name: 'Close comparison' }).click();
    await expect(viewer).toHaveCount(0);
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(head);
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('50k-line comparison loads within budget and keeps all views virtualized', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-large-comparison-ui-'));
  const path = createFixture(join(root, 'repository'));
  writeFileSync(
    join(path, 'large.txt'),
    Array.from({ length: 50000 }, (_, index) => `line ${index + 1}\n`).join(''),
  );
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Large text']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const grid = page.getByRole('grid', { name: 'Commit history' });
    await grid.press('Home');
    await grid.press('Enter');
    await page.getByRole('button', { name: 'Compare large.txt', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: 'File comparison' });
    await expect(viewer.getByRole('button', { name: 'Load large comparison' })).toBeVisible();
    const start = performance.now();
    await viewer.getByRole('button', { name: 'Load large comparison' }).click();
    await expect(viewer.getByText('line 1', { exact: true })).toBeVisible();
    const elapsed = performance.now() - start;
    console.log(`50k-line comparison open: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(1000);
    expect(await viewer.locator('.comparison-line').count()).toBeLessThan(100);
    await viewer.locator('.comparison-hunks').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(viewer.getByText('line 50000', { exact: true })).toBeVisible();
    await viewer.getByRole('combobox', { name: 'Diff view' }).selectOption('split');
    await expect(viewer.locator('.cm-mergeView .cm-editor')).toHaveCount(2);
    expect(await viewer.locator('.cm-line').count()).toBeLessThan(200);
    await viewer.getByRole('combobox', { name: 'Diff view' }).selectOption('inline');
    await expect(viewer.locator('.cm-editor')).toHaveCount(1);
    expect(await viewer.locator('.cm-line').count()).toBeLessThan(200);
    await page.screenshot({ path: 'test-results/large-comparison.png' });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
