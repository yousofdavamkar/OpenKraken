import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
test('working-tree buttons stage, unstage, undo and redo through the real Git service', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-working-e2e-'));
  const repo = createFixture(join(root, 'repo'));
  fixtureGit(repo, ['config', 'user.name', 'Test Author']);
  fixtureGit(repo, ['config', 'user.email', 'test@example.test']);
  fixtureGit(repo, ['config', 'commit.gpgSign', 'false']);
  writeFileSync(join(repo, 'tracked.txt'), 'working edit\n');
  writeFileSync(join(repo, 'new.txt'), 'new content\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Stage tracked.txt', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Unstage tracked.txt', exact: true }),
    ).toBeEnabled();
    expect(fixtureGit(repo, ['show', ':tracked.txt'])).toBe('working edit');
    await page.getByRole('button', { name: 'Unstage tracked.txt', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Stage tracked.txt', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Unstage tracked.txt', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Stage tracked.txt', exact: true }),
    ).toBeEnabled();
    expect(fixtureGit(repo, ['diff', '--cached', '--name-only'])).toBe('');
    await page.getByRole('button', { name: 'Stage all', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Unstage new.txt', exact: true })).toBeEnabled();
    await page
      .getByRole('textbox', { name: 'Commit message', exact: true })
      .fill('Committed in the desktop\n\nBody\n');
    await page.getByRole('button', { name: 'Commit staged changes', exact: true }).click();
    await expect(page.getByText('Working tree clean', { exact: true })).toBeVisible();
    expect(fixtureGit(repo, ['log', '-1', '--format=%s'])).toBe('Committed in the desktop');
    await page.getByRole('checkbox', { name: 'Amend last commit', exact: true }).check();
    await expect(page.getByRole('textbox', { name: 'Commit message', exact: true })).toHaveValue(
      'Committed in the desktop\n\nBody\n',
    );
    await page
      .getByRole('textbox', { name: 'Commit message', exact: true })
      .fill('Amended in the desktop\n');
    await page.getByRole('button', { name: 'Amend commit', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
      'title',
      'Amend commit',
    );
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    expect(fixtureGit(repo, ['log', '-1', '--format=%s'])).toBe('Amended in the desktop');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('diff dialog stages a chosen hunk and leaves neighboring edits unstaged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-partial-e2e-'));
  const repo = createFixture(join(root, 'repo'));
  writeFileSync(join(repo, 'tracked.txt'), 'first\nanchor\nsecond\n');
  fixtureGit(repo, ['add', 'tracked.txt']);
  fixtureGit(repo, ['commit', '-m', 'Base']);
  writeFileSync(join(repo, 'tracked.txt'), 'FIRST\nanchor\nSECOND\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'View unstaged tracked.txt', exact: true }).click();
    const diff = page.getByRole('dialog', { name: 'Working file changes' });
    await expect(diff).toBeVisible();
    await diff.getByRole('checkbox', { name: 'Remove line 1', exact: true }).check();
    await diff.getByRole('checkbox', { name: 'Add line 1', exact: true }).check();
    await diff.getByRole('button', { name: 'Stage selected lines', exact: true }).click();
    await expect.poll(async () => ((await diff.count()) ? await diff.innerText() : '')).toBe('');
    expect(fixtureGit(repo, ['show', ':tracked.txt'])).toBe('FIRST\nanchor\nsecond');
    await page.getByRole('button', { name: 'View staged tracked.txt', exact: true }).click();
    await diff.getByRole('button', { name: 'Select hunk 1', exact: true }).click();
    await diff.getByRole('button', { name: 'Unstage selected lines', exact: true }).click();
    await expect(diff).toHaveCount(0);
    expect(fixtureGit(repo, ['diff', '--cached'])).toBe('');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('discard requires a reviewed confirmation and Undo restores the file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-discard-e2e-'));
  const repo = createFixture(join(root, 'repo'));
  writeFileSync(join(repo, 'tracked.txt'), 'valuable changes\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Discard tracked.txt', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Discard working changes' });
    await expect(review.getByText('tracked.txt', { exact: true })).toBeVisible();
    await review.getByRole('button', { name: 'Keep changes', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Discard tracked.txt', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Discard tracked.txt', exact: true }).click();
    await review.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(review).toHaveCount(0);
    await expect(page.getByText('Working tree clean', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Discard tracked.txt', exact: true }),
    ).toBeEnabled();
    expect(fixtureGit(repo, ['diff', '--', 'tracked.txt'])).toContain('+valuable changes');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('external edits, git add and git commit update the desktop within 1.5 seconds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-watch-e2e-'));
  const repo = createFixture(join(root, 'repo'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByText('Watching for changes', { exact: true })).toBeVisible();
    const editStart = performance.now();
    writeFileSync(join(repo, 'tracked.txt'), 'external edit\n');
    await expect(page.getByRole('button', { name: 'Stage tracked.txt', exact: true })).toBeEnabled({
      timeout: 1400,
    });
    const editMs = performance.now() - editStart;
    expect(editMs).toBeLessThan(1500);
    const stageStart = performance.now();
    fixtureGit(repo, ['add', 'tracked.txt']);
    await expect(
      page.getByRole('button', { name: 'Unstage tracked.txt', exact: true }),
    ).toBeEnabled({ timeout: 1400 });
    const stageMs = performance.now() - stageStart;
    expect(stageMs).toBeLessThan(1500);
    const commitStart = performance.now();
    fixtureGit(repo, ['commit', '-m', 'Commit made externally']);
    await expect(page.getByText('Working tree clean', { exact: true })).toBeVisible({
      timeout: 1400,
    });
    await expect(page.getByRole('row', { name: /Commit made externally/ })).toBeVisible({
      timeout: 1400,
    });
    const commitMs = performance.now() - commitStart;
    expect(commitMs).toBeLessThan(1500);
    await test.info().attach('watcher-latency.json', {
      body: JSON.stringify({ editMs, stageMs, commitMs }),
      contentType: 'application/json',
    });
    await page.getByRole('checkbox', { name: 'Refresh on focus' }).uncheck();
    await page.reload();
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Refresh on focus' })).not.toBeChecked();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
