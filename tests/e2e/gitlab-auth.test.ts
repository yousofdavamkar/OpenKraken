import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixtureProtection } from './provider-fixtures.js';

test('GitLab browser sign-in protects credentials, survives restart and closes cancelled callbacks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-gitlab-ui-'));
  const profile = join(root, 'profile');
  const args = [resolve('apps/desktop'), `--user-data-dir=${profile}`];
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No callback port');
  const callbackPort = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  let app = await electron.launch({ args });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session, shell }) => {
      shell.openExternal = async (url) => {
        Reflect.set(globalThis, 'gitlabAuthorization', url);
      };
      session.fromPartition('openkraken-providers').fetch = async (input, init) => {
        if (init?.credentials !== 'omit' || init.redirect !== 'error')
          throw new Error('Unsafe request');
        if (String(input) === 'https://gitlab.com/oauth/token') {
          const parameters = new URLSearchParams(String(init.body));
          if (
            parameters.get('code') !== 'ui-code' ||
            !parameters.get('code_verifier') ||
            parameters.has('client_secret')
          )
            throw new Error('Bad exchange');
          return Response.json({
            access_token: 'gitlab-ui-secret',
            refresh_token: 'gitlab-refresh-secret',
            token_type: 'bearer',
            expires_in: 7200,
          });
        }
        if (String(input) === 'https://gitlab.com/api/v4/user') {
          if (new Headers(init.headers).get('Authorization') !== 'Bearer gitlab-ui-secret')
            throw new Error('Wrong token');
          return Response.json({ id: 42, username: 'gitlab-ui-user' });
        }
        throw new Error('Unexpected provider URL');
      };
    });
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Provider accounts' });
    await dialog.getByLabel('Provider type', { exact: true }).selectOption('gitlab');
    await expect(dialog.getByLabel('Provider host', { exact: true })).toHaveValue(
      'https://gitlab.com',
    );
    await dialog.getByLabel('GitLab application client ID', { exact: true }).fill('ui-client');
    await dialog.getByLabel('Local callback port', { exact: true }).fill(String(callbackPort));
    await dialog.getByRole('button', { name: 'Sign in with GitLab', exact: true }).click();
    await dialog.getByRole('button', { name: 'Open GitLab authorization', exact: true }).click();
    const authorization = new URL(
      await app.evaluate(() => String(Reflect.get(globalThis, 'gitlabAuthorization'))),
    );
    expect(authorization.origin).toBe('https://gitlab.com');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'ui-code');
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    expect((await fetch(callback)).status).toBe(200);
    await expect(dialog.getByText('gitlab-ui-user', { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText('gitlab-ui-secret');
    await page.screenshot({ path: 'test-results/gitlab-account.png' });
    const metadata = await page.evaluate(() =>
      window.openkraken.request({ id: crypto.randomUUID(), method: 'providerAccounts' }),
    );
    expect(JSON.stringify(metadata)).not.toContain('secret');
    expect(readFileSync(join(profile, 'provider-accounts.json'), 'utf8')).not.toContain('secret');
    await app.close();
    app = await electron.launch({ args });
    await fixtureProtection(app, true);
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Provider accounts' });
    await expect(dialog.getByText('gitlab-ui-user', { exact: true })).toBeVisible();
    await dialog.getByLabel('Provider type', { exact: true }).selectOption('gitlab');
    await dialog.getByLabel('GitLab application client ID', { exact: true }).fill('ui-client');
    await dialog.getByLabel('Local callback port', { exact: true }).fill(String(callbackPort));
    await dialog.getByRole('button', { name: 'Sign in with GitLab', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Cancel GitLab sign-in' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close accounts', exact: true }).click();
    await expect
      .poll(async () => {
        try {
          await fetch(callback);
          return 'open';
        } catch {
          return 'closed';
        }
      })
      .toBe('closed');
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    await dialog.getByLabel('Provider type', { exact: true }).selectOption('gitlab');
    await dialog.getByLabel('GitLab application client ID', { exact: true }).fill('ui-client');
    await dialog.getByLabel('Local callback port', { exact: true }).fill(String(callbackPort));
    await dialog.getByRole('button', { name: 'Sign in with GitLab', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Cancel GitLab sign-in' })).toBeVisible();
    await page.reload();
    await expect
      .poll(async () => {
        try {
          await fetch(callback);
          return 'open';
        } catch {
          return 'closed';
        }
      })
      .toBe('closed');
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    await dialog.getByRole('button', { name: 'Forget gitlab-ui-user', exact: true }).click();
    await expect(dialog.getByText('No provider accounts connected.')).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('self-managed GitLab PAT setup validates the selected host and requires OS protection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-gitlab-pat-ui-'));
  const app = await electron.launch({ args: [resolve('apps/desktop'), `--user-data-dir=${root}`] });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }) => {
      session.fromPartition('openkraken-providers').fetch = async (input, init) => {
        if (String(input) !== 'https://gitlab.example.test/api/v4/user')
          throw new Error('Wrong host');
        const allowed =
          new Headers(init?.headers).get('authorization') === 'Bearer gitlab-pat-secret';
        return Response.json(
          allowed ? { id: 73, username: 'self-managed-user' } : { message: 'echoed-secret' },
          { status: allowed ? 200 : 401 },
        );
      };
    });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Provider accounts' });
    await dialog.getByLabel('Provider type', { exact: true }).selectOption('gitlab');
    await dialog.getByLabel('Provider host', { exact: true }).fill('https://gitlab.example.test');
    await dialog.getByLabel('Personal access token', { exact: true }).fill('invalid-secret');
    await dialog.getByRole('button', { name: 'Connect account', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('The provider rejected this token');
    await expect(dialog).not.toContainText('echoed-secret');
    await expect(dialog.getByLabel('Personal access token', { exact: true })).toHaveValue('');
    await dialog.getByLabel('Personal access token', { exact: true }).fill('gitlab-pat-secret');
    await dialog.getByRole('button', { name: 'Connect account', exact: true }).click();
    await expect(dialog.getByText('self-managed-user', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close accounts', exact: true }).click();
    await app.evaluate(({ safeStorage }) => {
      safeStorage.isAsyncEncryptionAvailable = async () => false;
    });
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    await dialog.getByLabel('Provider type', { exact: true }).selectOption('gitlab');
    await expect(
      dialog.getByRole('button', { name: 'Sign in with GitLab', exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole('button', { name: 'Connect account', exact: true }),
    ).toBeDisabled();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
