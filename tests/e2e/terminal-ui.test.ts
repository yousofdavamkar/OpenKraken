import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture } from '../../packages/test-fixtures/src/index.js';
import { pressShortcut } from '../electron-shortcut.js';

test('the terminal panel preserves its session while hidden and keeps keyboard input out of app commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-terminal-ui-'));
  const repository = createFixture(join(root, 'repo'), 'linear', 3);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
    env: { ...process.env, ...(process.platform === 'win32' ? {} : { SHELL: '/bin/sh' }) },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showMessageBoxSync = () => 1;
    }, repository);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click({ timeout: 1500 });
    const panel = page.getByRole('region', { name: 'Terminal', exact: true });
    const input = panel.getByRole('textbox', { name: 'Terminal input', exact: true });
    await expect(panel.getByRole('status')).toContainText('Running');
    await input.pressSequentially('echo terminal-ui-ok');
    await input.press('Enter');
    await expect(panel.locator('.xterm-accessibility-tree')).toContainText('terminal-ui-ok');
    await panel.getByRole('button', { name: 'Hide terminal', exact: true }).click();
    await expect(panel).toBeHidden();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(panel.locator('.xterm-accessibility-tree')).toContainText('terminal-ui-ok');
    await expect(input).toBeFocused();
    await input.press('F6');
    await expect(panel.getByRole('button', { name: 'Hide terminal', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(input).toBeFocused();
    if (process.platform !== 'win32') {
      await input.pressSequentially(
        'stty -echo -icanon; dd bs=1 count=1 2>/dev/null | od -An -t u1; stty sane',
      );
      await input.press('Enter');
      await expect
        .poll(() =>
          app.evaluate(
            ({ Menu }) =>
              Menu.getApplicationMenu()?.getMenuItemById('command.app.commands')?.enabled,
          ),
        )
        .toBe(true);
      await pressShortcut(app, 'Control+P');
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
      await expect(panel.locator('.xterm-accessibility-tree')).toContainText('16');
    }
    await panel.getByRole('button', { name: 'Close terminal', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Close terminal?', exact: true });
    await confirmation.getByRole('button', { name: 'Keep open', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('Running');
    await page.screenshot({ path: 'test-results/terminal-panel.png' });
    await panel.getByRole('button', { name: 'Close terminal', exact: true }).click();
    await confirmation.getByRole('button', { name: 'End session', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect
      .poll(() =>
        app.evaluate(({ app }) =>
          app.getAppMetrics().some((metric) => metric.name === 'OpenKraken Terminal'),
        ),
      )
      .toBe(false);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing default shell reports a recoverable terminal error without blocking repository use', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-terminal-missing-shell-'));
  const repository = createFixture(join(root, 'repo'), 'linear', 3);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
    env: {
      ...process.env,
      ...(process.platform === 'win32'
        ? { ComSpec: join(root, 'missing-shell') }
        : { SHELL: join(root, 'missing-shell') }),
    },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showMessageBoxSync = () => 1;
    }, repository);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Terminal', exact: true });
    await expect(panel.getByRole('status')).toHaveText('Terminal unavailable');
    await expect(panel.getByRole('alert')).toContainText('default shell');
    await panel.getByRole('button', { name: 'Close terminal', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('3 commits');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
