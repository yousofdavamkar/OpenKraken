import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
import { startGitea } from '../../packages/test-fixtures/src/gitea.js';
async function credentials(page: Page, user: { username: string; password: string }) {
  const auth = page.getByRole('dialog', { name: 'Git authentication', exact: true });
  await auth.getByLabel('Username', { exact: true }).fill(user.username);
  await auth.getByRole('button', { name: 'Continue', exact: true }).click();
  await auth.getByLabel('Password or passphrase', { exact: true }).fill(user.password);
  await auth.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(auth).toHaveCount(0);
}
test('Gitea container: verified HTTPS auth, rejected push, SSH host-key consent and encrypted-key prompts', async () => {
  test.skip(
    process.env.OPENKRAKEN_GITEA_TEST !== '1',
    'Enable the isolated Gitea container acceptance fixture',
  );
  test.setTimeout(180000);
  const root = mkdtempSync(join(tmpdir(), 'openkraken-gitea-'));
  const source = createFixture(join(root, 'source'));
  let remote: Awaited<ReturnType<typeof startGitea>> | undefined;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    remote = await startGitea(root);
    await remote.push(source);
    app = await electron.launch({
      args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
      env: remote.environment,
    });
    const page = await app.firstWindow();
    const clone = page.getByRole('dialog', { name: 'Clone repository', exact: true });
    const auth = page.getByRole('dialog', { name: 'Git authentication', exact: true });
    const target = join(root, 'https-clone');
    mkdirSync(target);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, target);
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    await clone
      .getByRole('textbox', { name: 'Repository URL or absolute path', exact: true })
      .fill(remote.httpsUrl);
    await clone.getByRole('button', { name: 'Choose folder and clone', exact: true }).click();
    await credentials(page, remote.credentials);
    await expect(clone).toHaveCount(0);
    await expect(page.getByTestId('head')).toHaveText('main');
    const original = fixtureGit(source, ['rev-parse', 'HEAD']);
    expect(fixtureGit(target, ['rev-parse', 'HEAD'])).toBe(original);
    fixtureGit(source, ['commit', '--allow-empty', '-m', 'Remote-only commit']);
    await remote.push(source);
    await page.getByRole('button', { name: 'Push', exact: true }).click();
    const push = page.getByRole('dialog', { name: 'Push to remote', exact: true });
    await push.getByRole('button', { name: 'Review push', exact: true }).click();
    await credentials(page, remote.credentials);
    await expect(push.getByText('Update refs/heads/main', { exact: true })).toBeVisible();
    await push.getByRole('button', { name: 'Push reviewed tip', exact: true }).click();
    await credentials(page, remote.credentials);
    await expect(push.getByRole('alert')).toContainText(/rejected|fetch first|non-fast-forward/i);
    expect(fixtureGit(target, ['rev-parse', 'HEAD'])).toBe(original);
    await push.getByRole('button', { name: 'Close', exact: true }).click();
    const sshTarget = join(root, 'ssh-clone');
    mkdirSync(sshTarget);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, sshTarget);
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    await clone
      .getByRole('textbox', { name: 'Repository URL or absolute path', exact: true })
      .fill(remote.sshUrl);
    await clone.getByRole('button', { name: 'Choose folder and clone', exact: true }).click();
    await expect(auth).toContainText('fingerprint');
    await auth.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(auth).toHaveCount(0);
    await expect(clone.getByRole('alert')).toContainText(/Host key verification failed/i);
    await clone.getByRole('button', { name: 'Choose folder and clone', exact: true }).click();
    await expect(auth).toContainText('fingerprint');
    await auth.getByRole('button', { name: 'Confirm', exact: true }).click();
    await auth.getByLabel('Password or passphrase', { exact: true }).fill(remote.passphrase);
    await auth.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(clone).toHaveCount(0);
    await expect(auth).toHaveCount(0);
    await expect(page.getByTestId('head')).toHaveText('main');
    expect(fixtureGit(sshTarget, ['rev-parse', 'HEAD'])).toBe(
      fixtureGit(source, ['rev-parse', 'HEAD']),
    );
  } finally {
    await app?.close();
    await remote?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
