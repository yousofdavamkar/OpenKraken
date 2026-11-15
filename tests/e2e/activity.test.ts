import { _electron as electron, expect, test } from '@playwright/test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('activity records outcomes without content and survives renderer reload and app restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-activity-'));
  const repo = createFixture(join(root, 'private-repository-name'));
  writeFileSync(join(repo, 'tracked.txt'), 'private file content\n');
  const profile = join(root, 'profile');
  const args = [resolve('apps/desktop'), `--user-data-dir=${profile}`];
  let app = await electron.launch({ args });
  try {
    let page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Stage tracked.txt', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Unstage tracked.txt', exact: true }),
    ).toBeEnabled();
    const notifications = page.getByRole('log', { name: 'Operation notifications' });
    await expect(notifications).toBeEmpty();
    await page.clock.install();
    await page
      .getByRole('textbox', { name: 'Commit message', exact: true })
      .fill('private commit subject');
    await page.getByRole('button', { name: 'Commit staged changes', exact: true }).click();
    await expect(page.getByText('Working tree clean', { exact: true })).toBeVisible();
    await expect(notifications).toContainText('Commit · Succeeded');
    await expect(notifications).not.toContainText('private commit subject');
    await notifications.getByRole('button', { name: 'Dismiss notification' }).focus();
    await page.clock.fastForward(7000);
    await expect(notifications).toContainText('Commit · Succeeded');
    await page.getByRole('button', { name: 'Activity', exact: true }).focus();
    await page.clock.fastForward(7000);
    await expect(notifications).toBeEmpty();
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
    await expect(dialog.getByRole('list', { name: 'Recent activity' })).toContainText('Commit');
    await expect(dialog.getByRole('list', { name: 'Recent activity' })).toContainText('Succeeded');
    await expect(dialog).not.toContainText('private commit subject');
    await expect(dialog).not.toContainText('private-repository-name');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Activity', exact: true })).toBeFocused();
    await page.reload();
    await expect(notifications).toBeEmpty();
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await expect(dialog).toContainText('Commit');
    await app.close();
    const raw = readFileSync(join(profile, 'activity.json'), 'utf8');
    for (const secret of [
      repo,
      'private-repository-name',
      'private commit subject',
      'private file content',
      'tracked.txt',
    ])
      expect(raw).not.toContain(secret);
    app = await electron.launch({ args });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Commands', exact: true }).click();
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
    await palette.getByLabel('Search commands').fill('Activity');
    await palette.getByLabel('Search commands').press('Enter');
    dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
    await expect(dialog).toContainText('Commit');
    await page.screenshot({ path: 'test-results/activity.png' });
    await dialog.getByRole('button', { name: 'Clear completed activity', exact: true }).click();
    await expect(dialog).toContainText('No recorded activity');
    await app.close();
    app = await electron.launch({ args });
    page = await app.firstWindow();
    await expect
      .poll(() =>
        app.evaluate(
          ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('command.app.activity')?.enabled,
        ),
      )
      .toBe(true);
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const entry = Menu.getApplicationMenu()!.getMenuItemById('command.app.activity')!;
      entry.click(entry, BrowserWindow.getAllWindows()[0], {});
    });
    await expect(page.getByRole('dialog', { name: 'Activity', exact: true })).toContainText(
      'No recorded activity',
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('activity distinguishes failed and cancelled attempts without retaining native error text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-activity-errors-'));
  const repo = createFixture(join(root, 'repo'));
  const profile = join(root, 'profile');
  writeFileSync(join(repo, 'tracked.txt'), 'private edit\n');
  const hook = join(repo, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "private hook secret" >&2\nexit 1\n', { mode: 0o755 });
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
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
    await page
      .getByRole('textbox', { name: 'Commit message', exact: true })
      .fill('private rejected subject');
    await page.getByRole('button', { name: 'Commit staged changes', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('private hook secret');
    const notifications = page.getByRole('log', { name: 'Operation notifications' });
    await expect(notifications).toContainText('Commit · Failed');
    await expect(notifications).not.toContainText('private hook secret');
    const message = page.getByRole('textbox', { name: 'Commit message', exact: true });
    await message.focus();
    await notifications.getByRole('button', { name: 'Dismiss notification' }).focus();
    await page.keyboard.press('Enter');
    await expect(message).toBeFocused();
    await expect(notifications).toBeEmpty();
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await page.getByRole('button', { name: 'Open repository', exact: true }).click();
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
    await dialog.getByRole('combobox', { name: 'Outcome', exact: true }).selectOption('failed');
    const entries = dialog.getByRole('list', { name: 'Recent activity' }).getByRole('listitem');
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText('Commit · Failed');
    await dialog.getByRole('combobox', { name: 'Outcome', exact: true }).selectOption('cancelled');
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText('Open repository · Cancelled');
    await dialog.getByRole('textbox', { name: 'Find activity', exact: true }).fill('Commit');
    await expect(dialog).toContainText('No matching activity');
    const raw = readFileSync(join(profile, 'activity.json'), 'utf8');
    expect(raw).not.toContain('private hook secret');
    expect(raw).not.toContain('private rejected subject');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('activity observes service interruption and keeps running entries when completed history is cleared', async () => {
  const { createServer } = await import('node:http');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-activity-interruption-'));
  const repo = createFixture(join(root, 'repo'));
  const profile = join(root, 'profile');
  let requests = 0;
  const server = createServer(() => {
    requests++;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  fixtureGit(repo, [
    'remote',
    'set-url',
    'origin',
    `http://127.0.0.1:${address.port}/private-source.git`,
  ]);
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
      if (result.kind !== 'snapshot') throw new Error('Missing repository');
      return result.snapshot.repository.id;
    });
    await page.evaluate(async (repoId) => {
      await window.openkraken.request({ id: crypto.randomUUID(), method: 'workingState', repoId });
      await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'fetch',
        repoId,
        name: 'missing',
        background: true,
      });
    }, repoId);
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
    const entries = dialog.getByRole('list', { name: 'Recent activity' }).getByRole('listitem');
    await expect(entries).toHaveCount(1);
    await page.evaluate((repoId) => {
      void window.openkraken
        .request({ id: crypto.randomUUID(), method: 'fetch', repoId, name: 'origin' })
        .then((result) => sessionStorage.setItem('interrupted-fetch', JSON.stringify(result)));
    }, repoId);
    await expect.poll(() => requests).toBeGreaterThan(0);
    await expect(entries.filter({ hasText: 'Fetch · Running' })).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Clear completed activity', exact: true }).click();
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText('Fetch · Running');
    await app.evaluate(({ app }) => {
      const service = app.getAppMetrics().find((metric) => metric.name === 'OpenKraken Git');
      if (!service) throw new Error('Missing Git service');
      process.kill(service.pid, 'SIGKILL');
    });
    await expect(entries.first()).toContainText('Fetch · Outcome unknown');
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem('interrupted-fetch')))
      .toContain('SERVICE_EXIT');
    expect(readFileSync(join(profile, 'activity.json'), 'utf8')).not.toContain('private-source');
  } finally {
    // A killed utility cannot reap its native Git process. Release the fixture transport first.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('activity restores interrupted outcomes and bounds saved history and visible rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-activity-bound-'));
  const profile = join(root, 'profile');
  mkdirSync(profile);
  const seed = Array.from({ length: 500 }, (_, index) => ({
    id: randomUUID(),
    action: index === 0 ? 'push' : 'open',
    startedAt: Date.now() - index * 1000,
    finishedAt: index === 0 ? null : Date.now() - index * 1000,
    outcome: index === 0 ? 'running' : 'succeeded',
  }));
  const file = join(profile, 'activity.json');
  writeFileSync(file, JSON.stringify({ version: 1, entries: seed }));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
    await expect(dialog).toContainText('Push · Outcome unknown');
    await expect(dialog.getByRole('listitem')).toHaveCount(100);
    await dialog.getByRole('button', { name: 'Show more activity', exact: true }).click();
    await expect(dialog.getByRole('listitem')).toHaveCount(200);
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await page.evaluate(() =>
      window.openkraken.request({ id: crypto.randomUUID(), method: 'open' }),
    );
    const result = await page.evaluate(() =>
      window.openkraken.request({ id: crypto.randomUUID(), method: 'activityRead' }),
    );
    if (result.kind !== 'activity') throw new Error('Missing activity');
    expect(result.state.entries).toHaveLength(500);
    expect(result.state.entries[0]).toMatchObject({ action: 'open', outcome: 'cancelled' });
    expect(result.state.entries[1]).toMatchObject({ id: seed[0]!.id, outcome: 'unknown' });
    expect(result.state.entries.map((entry) => entry.id)).not.toContain(seed.at(-1)!.id);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.entries).toHaveLength(500);
    expect(saved.entries[1].outcome).toBe('unknown');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('activity storage failures leave operations usable and refuse to overwrite external history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-activity-storage-'));
  const profile = join(root, 'profile');
  const file = join(profile, 'activity.json');
  const args = [resolve('apps/desktop'), `--user-data-dir=${profile}`];
  let app = await electron.launch({ args });
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Activity', exact: true })).toContainText(
      'No recorded activity',
    );
    const foreign = '{"private external file":"do not replace"}';
    writeFileSync(file, foreign);
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    expect(
      await page.evaluate(() =>
        window.openkraken.request({ id: crypto.randomUUID(), method: 'open' }),
      ),
    ).toEqual({ kind: 'cancelled' });
    let dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
    await expect(dialog).toContainText('Open repository · Cancelled');
    await expect(dialog.getByRole('alert')).toContainText('Activity could not be saved');
    await dialog.getByRole('button', { name: 'Clear completed activity', exact: true }).click();
    await expect(dialog).toContainText('Activity could not be cleared');
    expect(readFileSync(file, 'utf8')).toBe(foreign);
    await app.close();
    app = await electron.launch({ args });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
    await expect(dialog.getByRole('alert')).toContainText('Saved history could not be loaded');
    await expect(dialog).not.toContainText('private external file');
    expect(readFileSync(file, 'utf8')).toBe(foreign);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('activity refuses a redirected history file without changing its target', async () => {
  test.skip(process.platform === 'win32', 'POSIX symlink fixture');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-activity-symlink-'));
  const profile = join(root, 'profile');
  mkdirSync(profile);
  const target = join(root, 'private-target');
  const raw = JSON.stringify({ version: 1, entries: [] });
  writeFileSync(target, raw);
  symlinkSync(target, join(profile, 'activity.json'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
    await expect(dialog.getByRole('alert')).toContainText('Saved history could not be loaded');
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    expect(
      await page.evaluate(() =>
        window.openkraken.request({ id: crypto.randomUUID(), method: 'open' }),
      ),
    ).toEqual({ kind: 'cancelled' });
    await expect(dialog).toContainText('Open repository · Cancelled');
    expect(readFileSync(target, 'utf8')).toBe(raw);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('activity distinguishes a failed merge from successful staging in a pending merge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-activity-conflict-'));
  const repo = createFixture(join(root, 'repo'));
  fixtureGit(repo, ['switch', '-c', 'incoming']);
  writeFileSync(join(repo, 'tracked.txt'), 'incoming\n');
  fixtureGit(repo, ['commit', '-am', 'Incoming']);
  const target = fixtureGit(repo, ['rev-parse', 'HEAD']);
  fixtureGit(repo, ['switch', 'main']);
  writeFileSync(join(repo, 'tracked.txt'), 'local\n');
  fixtureGit(repo, ['commit', '-am', 'Local']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    const result = await page.evaluate(async (target) => {
      const opened = await window.openkraken.request({ id: crypto.randomUUID(), method: 'open' });
      if (opened.kind !== 'snapshot') throw new Error('Missing repository');
      const repoId = opened.snapshot.repository.id;
      const state = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'workingState',
        repoId,
      });
      if (state.kind !== 'workingState') throw new Error('Missing working state');
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'startOperation',
        repoId,
        options: { kind: 'merge', mode: 'no-ff', target, revision: state.state.revision },
      });
      return { result, repoId };
    }, target);
    expect(result.result).toMatchObject({ kind: 'error', code: 'GIT_FAILED' });
    writeFileSync(join(repo, 'tracked.txt'), 'resolved version\n');
    const staged = await page.evaluate(
      (repoId) =>
        window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'files',
          repoId,
          action: 'stage',
          paths: [btoa('tracked.txt')],
        }),
      result.repoId,
    );
    expect(staged).toMatchObject({
      kind: 'workingState',
      state: { operation: { kind: 'merge', conflicts: 0 } },
    });
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
    await dialog.getByRole('combobox', { name: 'Outcome', exact: true }).selectOption('failed');
    await expect(dialog.getByRole('listitem')).toContainText('Start Git operation · Failed');
    await dialog.getByRole('combobox', { name: 'Outcome', exact: true }).selectOption('attention');
    await expect(dialog.getByRole('listitem')).toHaveCount(1);
    await expect(dialog.getByRole('listitem')).toContainText(
      'Stage or unstage files · Needs attention',
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rejected duplicate request does not create a second activity operation', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'openkraken-activity-duplicate-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
  });
  const id = randomUUID();
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = () =>
        new Promise((resolve) => {
          (globalThis as unknown as { finishActivityPicker: () => void }).finishActivityPicker =
            () => resolve({ canceled: true, filePaths: [] });
        });
    });
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
    await page.evaluate((id) => {
      void window.openkraken
        .request({ id, method: 'open' })
        .then((result) => sessionStorage.setItem('picker-outcome', JSON.stringify(result)));
    }, id);
    await expect(dialog.getByRole('listitem')).toContainText('Open repository · Running');
    expect(
      await page.evaluate((id) => window.openkraken.request({ id, method: 'open' }), id),
    ).toMatchObject({ kind: 'error', code: 'DUPLICATE_REQUEST' });
    await expect(dialog.getByRole('listitem')).toHaveCount(1);
    await app.evaluate(() =>
      (globalThis as unknown as { finishActivityPicker: () => void }).finishActivityPicker(),
    );
    await expect(dialog.getByRole('listitem')).toContainText('Open repository · Cancelled');
  } finally {
    await app.evaluate(() =>
      (globalThis as unknown as { finishActivityPicker?: () => void }).finishActivityPicker?.(),
    );
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
