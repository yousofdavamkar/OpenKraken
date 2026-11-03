import { _electron as electron, expect, test } from '@playwright/test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('commit drafts survive a renderer crash and restart and clear only after a successful commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-commit-drafts-'));
  const repo = createFixture(join(root, 'repo'));
  const args = [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`];
  let app = await electron.launch({ args });
  const open = async () => {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'repo', exact: true })).toBeVisible();
    return page;
  };
  try {
    let page = await open();
    const text = 'Preserved draft ✓\n\nBody with literal $() and quotes "\n';
    await page.getByRole('textbox', { name: 'Commit message', exact: true }).fill(text);
    await expect(page.getByLabel('Commit draft status')).toHaveText('Draft saved locally');
    const crashed = page.waitForEvent('crash');
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer(),
    );
    await crashed;
    await app.close();
    app = await electron.launch({ args });
    page = await open();
    await expect(page.getByRole('textbox', { name: 'Commit message', exact: true })).toHaveValue(
      text,
    );
    await page
      .getByRole('textbox', { name: 'Commit message', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/commit-draft-restored.png' });
    writeFileSync(join(repo, 'tracked.txt'), 'draft commit\n');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: 'Stage tracked.txt', exact: true }).click();
    await page.getByRole('button', { name: 'Commit staged changes', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Commit message', exact: true })).toHaveValue(
      '',
    );
    await expect(page.getByLabel('Commit draft status')).toHaveText('Draft saved locally');
    expect(fixtureGit(repo, ['log', '-1', '--format=%s'])).toBe('Preserved draft ✓');
    await app.close();
    app = await electron.launch({ args });
    page = await open();
    await expect(page.getByRole('textbox', { name: 'Commit message', exact: true })).toHaveValue(
      '',
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed commits and edits made during a commit retain the latest saved draft', async () => {
  test.skip(process.platform === 'win32', 'POSIX hook fixture');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-busy-drafts-'));
  const repo = createFixture(join(root, 'repo'));
  const hook = join(repo, '.git/hooks/pre-commit');
  writeFileSync(join(repo, 'tracked.txt'), 'staged content\n');
  fixtureGit(repo, ['add', 'tracked.txt']);
  writeFileSync(hook, '#!/bin/sh\necho draft-hook-failed >&2\nexit 1\n', { mode: 0o755 });
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Commit message', exact: true });
    await input.fill('Submitted message');
    await page.getByRole('button', { name: 'Commit staged changes', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'draft-hook-failed' })).toBeVisible();
    await expect(input).toHaveValue('Submitted message');
    await expect(page.getByLabel('Commit draft status')).toHaveText('Draft saved locally');
    writeFileSync(
      hook,
      '#!/bin/sh\ntouch .git/draft-hook-started\nwhile test ! -f .git/draft-hook-release; do sleep 0.05; done\n',
    );
    await page.getByRole('button', { name: 'Commit staged changes', exact: true }).click();
    await expect.poll(() => existsSync(join(repo, '.git/draft-hook-started'))).toBe(true);
    await input.fill('Newer draft for the next commit');
    await expect(page.getByLabel('Commit draft status')).toHaveText('Draft saved locally');
    writeFileSync(join(repo, '.git/draft-hook-release'), '');
    await expect(page.getByText('Working tree clean', { exact: true })).toBeVisible();
    await expect(input).toHaveValue('Newer draft for the next commit');
    expect(fixtureGit(repo, ['log', '-1', '--format=%s'])).toBe('Submitted message');
    await page.reload();
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(input).toHaveValue('Newer draft for the next commit');
  } finally {
    writeFileSync(join(repo, '.git/draft-hook-release'), '');
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('draft IPC rejects unknown repositories and stale writes and preserves externally changed storage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-draft-storage-'));
  const repo = createFixture(join(root, 'repo'));
  const profile = join(root, 'profile');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    const repoId = await page.evaluate(async () => {
      const result = await window.openkraken.request({ id: crypto.randomUUID(), method: 'open' });
      if (result.kind !== 'snapshot') throw new Error('Repository did not open');
      return result.snapshot.repository.id;
    });
    const outcomes = await page.evaluate(async (repoId) => {
      const draft = {
        message: 'Saved draft',
        amendMessage: '',
        amend: false,
        amendHead: null,
        sign: 'default' as const,
      };
      const unknown = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'commitDraftRead',
        repoId: 'unknown',
      });
      const first = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'commitDraftSave',
        repoId,
        revision: null,
        draft,
      });
      const stale = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'commitDraftSave',
        repoId,
        revision: null,
        draft: { ...draft, message: 'Stale' },
      });
      const read = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'commitDraftRead',
        repoId,
      });
      return { unknown, first, stale, read };
    }, repoId);
    expect(outcomes.unknown).toMatchObject({ kind: 'error', code: 'UNKNOWN_REPOSITORY' });
    expect(outcomes.first).toMatchObject({
      kind: 'commitDraft',
      state: { draft: { message: 'Saved draft' } },
    });
    expect(outcomes.stale).toMatchObject({ kind: 'error', code: 'DRAFT_UNAVAILABLE' });
    expect(outcomes.read).toEqual(outcomes.first);
    const files = readdirSync(join(profile, 'commit-drafts'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    const file = join(profile, 'commit-drafts', files[0]!);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = readFileSync(file, 'utf8');
    expect(saved).not.toContain(repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Commit message', exact: true });
    await expect(input).toHaveValue('Saved draft');
    const external = saved.replace('Saved draft', 'External owner draft');
    writeFileSync(file, external);
    await input.fill('Keep this unsaved text');
    await expect(page.getByLabel('Commit draft status')).toHaveText('Draft not saved');
    await expect(input).toHaveValue('Keep this unsaved text');
    expect(readFileSync(file, 'utf8')).toBe(external);
    writeFileSync(file, '{corrupt');
    await page.reload();
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByLabel('Commit draft status')).toHaveText('Draft not saved');
    await input.fill('Usable editor with unavailable storage');
    expect(readFileSync(file, 'utf8')).toBe('{corrupt');
    if (process.platform !== 'win32') {
      const target = join(root, 'external.json');
      writeFileSync(target, saved);
      rmSync(file);
      symlinkSync(target, file);
      await page.reload();
      await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
      await expect(page.getByLabel('Commit draft status')).toHaveText('Draft not saved');
      await input.fill('Do not replace redirected storage');
      expect(readFileSync(target, 'utf8')).toBe(saved);
    }
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('normal and amend drafts stay separate across toggles, repositories and a changed HEAD', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-amend-drafts-'));
  const repo = createFixture(join(root, 'repo'));
  const other = join(root, 'other');
  fixtureGit(repo, ['worktree', 'add', '-b', 'draft-other', other]);
  const args = [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`];
  let app = await electron.launch({ args });
  const open = async (path: string, initial = false) => {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page
      .getByRole('button', { name: initial ? 'Open a repository' : 'Open repository', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: path === repo ? 'repo' : 'other', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Commit message', exact: true })).toBeEnabled();
    return page;
  };
  try {
    let page = await open(repo, true);
    const input = () => page.getByRole('textbox', { name: 'Commit message', exact: true });
    const amend = () => page.getByRole('checkbox', { name: 'Amend last commit', exact: true });
    await input().fill('Next commit draft');
    await amend().check();
    await input().fill('Amend draft');
    await amend().uncheck();
    await expect(input()).toHaveValue('Next commit draft');
    await amend().check();
    await expect(input()).toHaveValue('Amend draft');
    await expect(page.getByLabel('Commit draft status')).toHaveText('Draft saved locally');
    page = await open(other);
    await expect(input()).toHaveValue('');
    await input().fill('Other checkout draft');
    await expect(page.getByLabel('Commit draft status')).toHaveText('Draft saved locally');
    await app.close();
    writeFileSync(join(repo, 'tracked.txt'), 'Changed HEAD content\n');
    fixtureGit(repo, ['add', 'tracked.txt']);
    fixtureGit(repo, ['commit', '-m', 'Changed HEAD']);
    app = await electron.launch({ args });
    page = await open(repo, true);
    await expect(amend()).toBeChecked();
    await expect(input()).toHaveValue('Amend draft');
    await expect(
      page.getByText('HEAD changed. Turn Amend off and on to review the current commit.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Amend commit', exact: true })).toBeDisabled();
    await amend().uncheck();
    await expect(input()).toHaveValue('Next commit draft');
    await amend().check();
    await expect(input()).toHaveValue('Changed HEAD\n');
    await input().fill('Reviewed amended HEAD');
    await page.getByRole('button', { name: 'Amend commit', exact: true }).click();
    await expect
      .poll(async () => ({
        checked: await amend().isChecked(),
        alerts: await page.getByRole('alert').allTextContents(),
      }))
      .toEqual({ checked: false, alerts: [] });
    await expect(input()).toHaveValue('Next commit draft');
    await expect(page.getByLabel('Commit draft status')).toHaveText('Draft saved locally');
    page = await open(other);
    await expect(input()).toHaveValue('Other checkout draft');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
