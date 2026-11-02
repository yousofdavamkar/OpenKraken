import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
test('reopened native rebase shows progress and requires confirmation before abort', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-operation-e2e-'));
  const path = createFixture(join(root, 'repository'));
  fixtureGit(path, ['switch', '-c', 'incoming']);
  writeFileSync(join(path, 'tracked.txt'), 'incoming\n');
  fixtureGit(path, ['commit', '-am', 'Incoming version']);
  fixtureGit(path, ['switch', 'main']);
  writeFileSync(join(path, 'tracked.txt'), 'local\n');
  fixtureGit(path, ['commit', '-am', 'Local version']);
  const original = fixtureGit(path, ['rev-parse', 'HEAD']);
  expect(() => fixtureGit(path, ['rebase', 'incoming'])).toThrow();
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Git operation' });
    await expect(panel.getByRole('heading', { name: 'Rebase in progress' })).toBeVisible();
    await expect(panel.getByText('Step 1 of 1')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: 'Abort', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Abort rebase' });
    await confirmation.getByRole('button', { name: 'Keep working' }).click();
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Abort', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Abort rebase', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('head')).toHaveText('main');
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('reviewed merge and mainline revert update native history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-merge-e2e-'));
  const path = createFixture(join(root, 'repository'));
  fixtureGit(path, ['switch', '-c', 'incoming']);
  writeFileSync(join(path, 'incoming.txt'), 'incoming\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Incoming file']);
  const target = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['switch', 'main']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Integrate commits', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Integrate commits', exact: true });
    await dialog
      .getByRole('combobox', { name: 'Target commit', exact: true })
      .selectOption({ label: 'incoming' });
    await dialog.getByRole('combobox', { name: 'Merge mode', exact: true }).selectOption('no-ff');
    await expect(dialog.getByText(target, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Check merge conflicts' }).click();
    await expect(
      dialog.getByText('No conflicts predicted between these committed trees.'),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Start merge', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const parents = fixtureGit(path, ['rev-list', '--parents', '-1', 'HEAD']).split(' ');
    expect(parents).toHaveLength(3);
    expect(parents[2]).toBe(target);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(parents[1]);
    expect(fixtureGit(path, ['ls-files', 'incoming.txt'])).toBe('');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect.poll(() => fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(parents[0]);
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
    await page.getByRole('button', { name: 'Integrate commits', exact: true }).click();
    await expect(dialog.getByText(parents[0]!, { exact: true })).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Operation', exact: true }).selectOption('revert');
    await dialog
      .getByRole('combobox', { name: 'Target commit', exact: true })
      .selectOption({ label: 'main' });
    await dialog
      .getByRole('spinbutton', { name: 'Mainline parent (merge commits only)' })
      .fill('1');
    await dialog.getByRole('button', { name: 'Start revert', exact: true }).click();
    await expect
      .poll(async () => ((await dialog.count()) ? await dialog.innerText() : 'closed'))
      .toBe('closed');
    expect(fixtureGit(path, ['rev-parse', 'HEAD^{tree}'])).toBe(
      fixtureGit(path, ['rev-parse', `${parents[1]}^{tree}`]),
    );

    await expect(page.getByTestId('head')).toHaveText('main');
    await expect(
      page
        .getByRole('grid', { name: 'Commit history' })
        .getByRole('gridcell', { name: /Incoming file/ }),
    ).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('hard reset requires a content review and Undo restores discarded edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-reset-e2e-'));
  const path = createFixture(join(root, 'repository'));
  fixtureGit(path, ['branch', 'before-reset']);
  writeFileSync(join(path, 'tracked.txt'), 'latest commit\n');
  fixtureGit(path, ['commit', '-am', 'Latest commit']);
  const original = fixtureGit(path, ['rev-parse', 'HEAD']);
  writeFileSync(join(path, 'tracked.txt'), 'uncommitted work\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Reset current branch' });
    await dialog
      .getByRole('combobox', { name: 'Target commit' })
      .selectOption({ label: 'before-reset' });
    await dialog.getByRole('combobox', { name: 'Reset mode' }).selectOption('hard');
    await expect(dialog.getByRole('button', { name: 'Reset reviewed state' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Review reset' }).click();
    await expect(dialog.getByText(original, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Reset reviewed state' }).click();
    await expect(dialog).toHaveCount(0);
    expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('base');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
    expect((await import('node:fs')).readFileSync(join(path, 'tracked.txt'), 'utf8')).toBe(
      'uncommitted work\n',
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('three-way conflict editor takes a chunk, saves editable output and continues merge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-conflict-editor-e2e-'));
  const path = createFixture(join(root, 'repository'));
  fixtureGit(path, ['switch', '-c', 'incoming']);
  writeFileSync(join(path, 'tracked.txt'), 'theirs\n');
  fixtureGit(path, ['commit', '-am', 'Theirs']);
  fixtureGit(path, ['switch', 'main']);
  writeFileSync(join(path, 'tracked.txt'), 'ours\n');
  fixtureGit(path, ['commit', '-am', 'Ours']);
  expect(() => fixtureGit(path, ['merge', 'incoming'])).toThrow();
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Resolve tracked.txt', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Resolve tracked.txt' });
    await expect(dialog.getByRole('textbox', { name: 'Ours', exact: true })).toHaveValue('ours\n');
    await expect(dialog.getByRole('textbox', { name: 'Theirs', exact: true })).toHaveValue(
      'theirs\n',
    );
    await dialog.getByRole('button', { name: 'Use chunk editor' }).click();
    await dialog.getByRole('button', { name: 'Take both for chunk 1' }).click();
    const output = dialog.getByRole('textbox', { name: 'Output', exact: true });
    await expect(output).toHaveValue('ours\ntheirs\n');
    await dialog.getByText('Choose individual lines', { exact: true }).click();
    await dialog.getByRole('checkbox', { name: 'Chunk 1 ours line 1' }).uncheck();
    await expect(output).toHaveValue('theirs\n');
    await dialog.getByRole('checkbox', { name: 'Chunk 1 ours line 1' }).check();
    await expect(output).toHaveValue('ours\ntheirs\n');

    await output.fill('ours\ntheirs\nreviewed extra line\n');
    await dialog.getByRole('button', { name: 'Save and stage output' }).click();
    await expect(dialog).toHaveCount(0);
    expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('ours\ntheirs\nreviewed extra line');
    const operation = page.getByRole('region', { name: 'Git operation' });
    await operation.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(operation).toHaveCount(0);
    expect(fixtureGit(path, ['rev-list', '--parents', '-1', 'HEAD']).split(' ')).toHaveLength(3);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('automatic three-way merge stages non-overlapping text changes from a native conflict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-auto-merge-e2e-'));
  const path = createFixture(join(root, 'repository'));
  const base = 'one\ntwo\nthree\nfour\nfive\n';
  writeFileSync(join(path, 'tracked.txt'), base);
  writeFileSync(join(path, '.gitattributes'), 'tracked.txt -merge\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Text handled as binary by Git']);
  fixtureGit(path, ['switch', '-c', 'incoming']);
  writeFileSync(join(path, 'tracked.txt'), base.replace('five', 'theirs'));
  fixtureGit(path, ['commit', '-am', 'Theirs']);
  fixtureGit(path, ['switch', 'main']);
  writeFileSync(join(path, 'tracked.txt'), base.replace('one', 'ours'));
  fixtureGit(path, ['commit', '-am', 'Ours']);
  expect(() => fixtureGit(path, ['merge', 'incoming'])).toThrow();
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Resolve tracked.txt', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Resolve tracked.txt' });
    await dialog.getByRole('button', { name: 'Auto-merge and stage' }).click();
    await expect(dialog).toHaveCount(0);
    expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('ours\ntwo\nthree\nfour\ntheirs');
    expect(fixtureGit(path, ['ls-files', '--unmerged'])).toBe('');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('configured external merge tool is available from the conflict editor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-mergetool-e2e-'));
  const path = createFixture(join(root, 'repository'));
  fixtureGit(path, ['switch', '-c', 'incoming']);
  writeFileSync(join(path, 'tracked.txt'), 'theirs\n');
  fixtureGit(path, ['commit', '-am', 'Theirs']);
  fixtureGit(path, ['switch', 'main']);
  writeFileSync(join(path, 'tracked.txt'), 'ours\n');
  fixtureGit(path, ['commit', '-am', 'Ours']);
  expect(() => fixtureGit(path, ['merge', 'incoming'])).toThrow();
  fixtureGit(path, ['config', 'merge.tool', 'fixture']);
  fixtureGit(path, [
    'config',
    'mergetool.fixture.cmd',
    'printf "external UI resolution\\n" > "$MERGED"',
  ]);
  fixtureGit(path, ['config', 'mergetool.fixture.trustExitCode', 'true']);
  fixtureGit(path, ['config', 'mergetool.keepBackup', 'false']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Resolve tracked.txt', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Resolve tracked.txt' });
    await dialog.getByRole('button', { name: 'Open fixture merge tool' }).click();
    await expect(dialog).toHaveCount(0);
    expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('external UI resolution');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('dragging refs opens an action menu and reviews a merge after switching its destination', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-ref-drop-e2e-'));
  const path = createFixture(join(root, 'repository'));
  const original = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['branch', 'destination']);
  fixtureGit(path, ['switch', '-c', 'incoming']);
  writeFileSync(join(path, 'incoming.txt'), 'incoming file\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Incoming file']);
  const target = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['switch', 'main']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const source = page
      .locator('.ref')
      .filter({ has: page.getByText('incoming', { exact: true }) });
    const destination = page
      .locator('.ref')
      .filter({ has: page.getByText('destination', { exact: true }) });
    await source.dragTo(destination);
    const menu = page.getByRole('dialog', { name: 'Dropped reference actions' });
    await expect(menu).toBeVisible();
    expect(fixtureGit(path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    await menu.getByRole('button', { name: 'Merge incoming into destination' }).click();
    const review = page.getByRole('dialog', { name: 'Integrate commits' });
    await expect(review).toBeVisible();
    expect(fixtureGit(path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/destination');
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
    await expect(review.getByRole('combobox', { name: 'Target commit' })).toHaveValue(target);
    await review.getByRole('combobox', { name: 'Merge mode' }).selectOption('ff-only');
    await review.getByRole('button', { name: 'Start merge' }).click();
    await expect(review).toHaveCount(0);
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(target);
    expect(fixtureGit(path, ['rev-parse', 'main'])).toBe(original);
    const main = page.locator('.ref').filter({ has: page.getByText('main', { exact: true }) });
    await main.dragTo(source);
    await menu.getByRole('button', { name: 'Rebase main onto incoming' }).click();
    await expect(review.getByRole('combobox', { name: 'Operation', exact: true })).toHaveValue(
      'rebase',
    );
    expect(fixtureGit(path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    await expect(review.getByRole('combobox', { name: 'Target commit' })).toHaveValue(target);
    await review.getByRole('button', { name: 'Start rebase' }).click();
    await expect(review).toHaveCount(0);
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(target);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
