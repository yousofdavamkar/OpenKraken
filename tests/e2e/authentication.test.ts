import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
import { authenticatedRemote } from '../../packages/test-fixtures/src/authenticated-remote.js';
test('HTTPS clone prompts through the isolated desktop and cancellation dismisses authentication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-auth-e2e-'));
  const source = createFixture(join(root, 'source'));
  const bare = join(root, 'remote.git');
  fixtureGit(source, ['clone', '--bare', '.', bare]);
  const remote = await authenticatedRemote(bare);
  const target = join(root, 'target');
  mkdirSync(target);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
    env: {
      ...process.env,
      GIT_SSL_CAINFO: remote.certificate,
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, target);
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    const clone = page.getByRole('dialog', { name: 'Clone repository', exact: true });
    await clone
      .getByRole('textbox', { name: 'Repository URL or absolute path', exact: true })
      .fill(remote.url);
    await clone.getByRole('button', { name: 'Choose folder and clone', exact: true }).click();
    const auth = page.getByRole('dialog', { name: 'Git authentication', exact: true });
    await auth.getByLabel('Username', { exact: true }).fill(remote.credentials.username);
    await auth.getByRole('button', { name: 'Continue', exact: true }).click();
    const secret = auth.getByLabel('Password or passphrase', { exact: true });
    await expect(secret).toHaveAttribute('type', 'password');
    await secret.fill(remote.credentials.password);
    await auth.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(auth).toHaveCount(0);
    await expect(clone).toHaveCount(0);
    await expect(page.getByTestId('head')).toHaveText('main');
    expect(fixtureGit(target, ['rev-parse', 'HEAD'])).toBe(
      fixtureGit(source, ['rev-parse', 'HEAD']),
    );
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
      remote.credentials.password,
    );
    const second = join(root, 'cancelled');
    mkdirSync(second);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, second);
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    await clone
      .getByRole('textbox', { name: 'Repository URL or absolute path', exact: true })
      .fill(remote.url);
    await clone.getByRole('button', { name: 'Choose folder and clone', exact: true }).click();
    await expect(auth).toBeVisible();
    await auth.getByRole('button', { name: 'Cancel operation', exact: true }).click();
    await expect(auth).toHaveCount(0);
    await expect(
      clone.getByRole('button', { name: 'Choose folder and clone', exact: true }),
    ).toBeEnabled();
  } finally {
    await app.close();
    await remote.close();
    rmSync(root, { recursive: true, force: true });
  }
});
