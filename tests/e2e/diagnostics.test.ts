import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('native failure diagnostics exclude private output and can be reviewed and cleared locally', async () => {
  test.skip(process.platform === 'win32', 'Fixture hook uses a POSIX shell');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-diagnostic-e2e-'));
  const repo = createFixture(join(root, 'PRIVATE-repository'));
  const profile = join(root, 'profile');
  writeFileSync(join(repo, 'tracked.txt'), 'PRIVATE-source-content');
  fixtureGit(repo, ['add', 'tracked.txt']);
  writeFileSync(
    join(repo, '.git/hooks/pre-commit'),
    '#!/bin/sh\necho "PRIVATE-native-token https://PRIVATE-user:PRIVATE-password@example.test/repo?token=PRIVATE-query" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  const args = [resolve('apps/desktop'), `--user-data-dir=${profile}`];
  let app = await electron.launch({ args });
  try {
    let page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Commit message', exact: true })
      .fill('PRIVATE-commit-subject');
    await page.getByRole('button', { name: 'Commit staged changes', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('PRIVATE-native-token');
    await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Local diagnostics', exact: true });
    const records = dialog.getByRole('textbox', { name: 'Diagnostic records', exact: true });
    await expect
      .poll(async () => JSON.parse((await records.inputValue()) || '[]'))
      .toContainEqual(
        expect.objectContaining({
          type: 'request',
          action: 'commit',
          outcome: 'failed',
          code: 'GIT_FAILED',
        }),
      );
    expect(await records.inputValue()).not.toMatch(/PRIVATE-|example.test|token=/);
    expect(await records.inputValue()).not.toContain(root);
    const directory = join(profile, 'diagnostics');
    for (const file of readdirSync(directory)) {
      const raw = readFileSync(join(directory, file), 'utf8');
      expect(raw).not.toMatch(/PRIVATE-|example.test|token=/);
      expect(raw).not.toContain(root);
    }
    await page.screenshot({ path: 'test-results/local-diagnostics.png' });
    await dialog.getByRole('button', { name: 'Select records to copy', exact: true }).click();
    expect(
      await records.evaluate(
        (element: HTMLTextAreaElement) => element.selectionEnd - element.selectionStart,
      ),
    ).toBe((await records.inputValue()).length);
    await dialog.getByRole('button', { name: 'Clear logs', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText(
      '0 retained records · 0 omitted this session',
    );
    await expect(records).toHaveValue('[]');
    await app.close();
    app = await electron.launch({ args });
    page = await app.firstWindow();
    const state = await page.evaluate(() =>
      window.openkraken.request({ id: crypto.randomUUID(), method: 'diagnosticsRead' }),
    );
    if (state.kind !== 'diagnostics') throw new Error('Missing diagnostics');
    expect(state.state.warning).toBeNull();
    expect(state.state.entries.map((entry) => entry.type)).toEqual(['stopped', 'started']);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('renderer failure categories survive restart without exception content or crash-report consent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-diagnostic-crash-'));
  const args = [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`];
  let app = await electron.launch({ args });
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Diagnostics', exact: true })).toBeVisible();
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('PRIVATE-renderer-source-and-token');
      }, 0);
    });
    await expect
      .poll(async () => {
        const result = await page.evaluate(() =>
          window.openkraken.request({ id: crypto.randomUUID(), method: 'diagnosticsRead' }),
        );
        return result.kind === 'diagnostics' ? result.state.entries : [];
      })
      .toContainEqual(
        expect.objectContaining({ component: 'renderer', reason: 'unhandled-exception' }),
      );
    const crashed = page.waitForEvent('crash');
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer(),
    );
    await crashed;
    await app.close();
    app = await electron.launch({ args });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
    const records = page.getByRole('textbox', { name: 'Diagnostic records', exact: true });
    await expect
      .poll(async () => JSON.parse((await records.inputValue()) || '[]'))
      .toContainEqual(
        expect.objectContaining({ type: 'process', component: 'renderer', reason: 'crashed' }),
      );
    expect(await records.inputValue()).not.toContain('PRIVATE-');
    expect(
      await page.evaluate(() =>
        window.openkraken.request({ id: crypto.randomUUID(), method: 'crashReporting' }),
      ),
    ).toMatchObject({ kind: 'crashReporting', state: { enabled: false } });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('unavailable diagnostic storage preserves its files and leaves repository operations usable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-diagnostic-storage-'));
  const repo = createFixture(join(root, 'repository'));
  const profile = join(root, 'profile');
  mkdirSync(join(profile, 'diagnostics'), { recursive: true, mode: 0o700 });
  const file = join(profile, 'diagnostics', 'diagnostics-0.json');
  writeFileSync(file, 'PRIVATE-corrupt-file', { mode: 0o600 });
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByTestId('head')).toHaveText('main');
    await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Local diagnostics', exact: true });
    await expect(dialog.getByRole('alert')).toContainText('unavailable');
    await expect(dialog.getByRole('button', { name: 'Clear logs', exact: true })).toBeDisabled();
    await expect(
      dialog.getByRole('textbox', { name: 'Diagnostic records', exact: true }),
    ).toHaveValue('[]');
    expect(readFileSync(file, 'utf8')).toBe('PRIVATE-corrupt-file');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
