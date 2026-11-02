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
    const before = viewer.getByRole('textbox', { name: 'Before revision', exact: true });
    const after = viewer.getByRole('textbox', { name: 'After revision', exact: true });
    await before.focus();
    await expect(before).toBeFocused();
    await before.press('Tab');
    await expect(after).toBeFocused();
    await after.press('ControlOrMeta+a');
    await after.press('Backspace');
    await expect(after).toContainText('const value = 3;');
    await expect(before).toContainText('const value = 1;');
    await viewer.getByRole('combobox', { name: 'Diff view' }).selectOption('inline');
    await expect(viewer.locator('.cm-editor')).toHaveCount(1);
    const inline = viewer.getByRole('textbox', { name: 'Inline revision comparison' });
    await inline.focus();
    await expect(inline).toBeFocused();
    await inline.press('ControlOrMeta+a');
    await inline.press('Backspace');
    await expect(inline).toContainText('const value = 3;');
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

test('raster comparison renders both versions and adjusts their overlay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-image-ui-'));
  const path = createFixture(join(root, 'repository'));
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
    'base64',
  );
  writeFileSync(join(path, 'pixel.png'), pixel);
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Before image']);
  // A harmless trailing byte changes the blob while retaining the image contents.
  writeFileSync(join(path, 'pixel.png'), Buffer.concat([pixel, Buffer.from([0])]));
  fixtureGit(path, ['commit', '-am', 'After image']);
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
    await page.getByRole('button', { name: 'Compare pixel.png', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: 'File comparison' });
    for (const label of ['Before image', 'After image']) {
      await expect(viewer.getByRole('img', { name: label })).toBeVisible();
      await expect
        .poll(() =>
          viewer
            .getByRole('img', { name: label })
            .evaluate((element: HTMLImageElement) => element.naturalWidth),
        )
        .toBe(1);
    }
    await viewer.getByRole('checkbox', { name: 'Overlay images' }).check();
    await viewer.getByRole('slider', { name: 'After opacity' }).fill('0.75');
    await expect(viewer.locator('.image-overlay figure').nth(1)).toHaveCSS('opacity', '0.75');
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('file history appends older revisions and opens the original name before a rename', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-file-history-ui-'));
  const path = createFixture(join(root, 'repository'));
  writeFileSync(join(path, 'old.txt'), 'original line\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Create historical file']);
  for (let index = 1; index <= 51; index++) {
    writeFileSync(join(path, 'old.txt'), `revision ${index}\n`);
    fixtureGit(path, ['commit', '-am', `Revision ${index}`]);
  }
  fixtureGit(path, ['mv', 'old.txt', 'new.txt']);
  fixtureGit(path, ['commit', '-m', 'Rename historical file']);
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
    await page.getByRole('button', { name: 'Compare new.txt', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: 'File comparison' });
    await viewer.getByRole('button', { name: 'File history', exact: true }).click();
    const history = viewer.getByRole('region', { name: 'File history' });
    await expect(
      history.getByRole('heading', { name: 'File history · 50', exact: true }),
    ).toBeVisible();
    await history.getByRole('button', { name: 'Load older file revisions' }).click();
    await expect(
      history.getByRole('heading', { name: 'File history · 53', exact: true }),
    ).toBeVisible();
    await history.locator('.file-history-scroll').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await history.getByRole('button', { name: /^Create historical file/ }).click();
    await expect(viewer.getByRole('heading', { name: 'old.txt', exact: true })).toBeVisible();
    await expect(viewer.getByText('original line', { exact: true })).toBeVisible();
    await expect(history.getByText('End of file history.', { exact: true })).toBeVisible();
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('10k-line blame streams its first screen within budget and virtualizes attribution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-blame-ui-'));
  const path = createFixture(join(root, 'repository'));
  const lines = Array.from({ length: 10000 }, (_, index) => `line ${index + 1}\n`);
  writeFileSync(join(path, 'lines.txt'), lines.join(''));
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Original attribution']);
  const original = fixtureGit(path, ['rev-parse', 'HEAD']);
  lines[0] = 'changed first\n';
  lines[9999] = 'changed last\n';
  writeFileSync(join(path, 'lines.txt'), lines.join(''));
  fixtureGit(path, ['commit', '-am', 'Changed attribution']);
  const changed = fixtureGit(path, ['rev-parse', 'HEAD']);
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
    await page.getByRole('button', { name: 'Compare lines.txt', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: 'File comparison' });
    await expect(viewer.getByRole('button', { name: 'Blame', exact: true })).toBeEnabled();
    const start = performance.now();
    await viewer.getByRole('button', { name: 'Blame', exact: true }).click();
    const blame = viewer.getByRole('region', { name: 'File blame' });
    await expect(blame.getByText('changed first', { exact: true })).toBeVisible();
    const elapsed = performance.now() - start;
    console.log(`10k-line blame first screen: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(300);
    await expect(blame.getByRole('status')).toHaveText('10,000 lines attributed');
    expect(await blame.locator('.blame-line').count()).toBeLessThan(100);
    await expect(blame.locator('.blame-line').nth(0)).toContainText(changed.slice(0, 8));
    await expect(blame.locator('.blame-line').nth(1)).toContainText(original.slice(0, 8));
    await blame.locator('.blame-scroll').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(blame.getByText('changed last', { exact: true })).toBeVisible();
    await viewer.getByRole('button', { name: 'Show comparison', exact: true }).click();
    await expect(blame).toHaveCount(0);
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
