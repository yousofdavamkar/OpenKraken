import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

async function fixtureProtection(app: ElectronApplication, offline = false) {
  await app.evaluate(async ({ safeStorage, session }, offline) => {
    // Only the external OS/network boundaries are replaced; IPC, validation and profile IO are real.
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(19),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );
    safeStorage.isAsyncEncryptionAvailable = async () => true;
    safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
    safeStorage.encryptStringAsync = async (text) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      return Buffer.concat([
        iv,
        Buffer.from(
          await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)),
        ),
      ]);
    };
    safeStorage.decryptStringAsync = async (bytes) => ({
      result: new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: new Uint8Array(bytes.subarray(0, 12)) },
          key,
          new Uint8Array(bytes.subarray(12)),
        ),
      ),
      shouldReEncrypt: false,
    });
    session.fromPartition('openkraken-providers').fetch = async (input, init) => {
      if (offline) throw new Error('offline');
      if (
        String(input) !== 'https://api.github.com/user' ||
        init?.redirect !== 'error' ||
        init?.credentials !== 'omit'
      )
        throw new Error('Unexpected provider request');
      const auth = new Headers(init.headers).get('authorization');
      return new Response(
        JSON.stringify(
          auth === 'token fixture-pat'
            ? { id: 321, login: 'fixture-user' }
            : { message: `Rejected ${auth}` },
        ),
        {
          status: auth === 'token fixture-pat' ? 200 : 401,
          headers: { 'content-type': 'application/json' },
        },
      );
    };
  }, offline);
}

test('provider accounts validate tokens, keep them out of responses, survive restart and can be forgotten', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-provider-ui-'));
  const profile = join(root, 'profile');
  const args = [resolve('apps/desktop'), `--user-data-dir=${profile}`];
  let app = await electron.launch({ args });
  try {
    await fixtureProtection(app);
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Provider accounts' });
    await dialog
      .getByLabel('Personal access token', { exact: true })
      .fill('rejected-fixture-token');
    await dialog.getByRole('button', { name: 'Connect account', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('The provider rejected this token');
    await expect(dialog.getByLabel('Personal access token', { exact: true })).toHaveValue('');
    await expect(dialog).not.toContainText('rejected-fixture-token');
    await dialog.getByLabel('Personal access token', { exact: true }).fill('fixture-pat');
    await dialog.getByRole('button', { name: 'Connect account', exact: true }).click();
    await expect(dialog.getByText('fixture-user', { exact: true })).toBeVisible();
    const state = await page.evaluate(() =>
      window.openkraken.request({ id: crypto.randomUUID(), method: 'providerAccounts' }),
    );
    expect(JSON.stringify(state)).not.toContain('fixture-pat');
    await page.screenshot({ path: 'test-results/provider-accounts.png' });
    expect(readFileSync(join(profile, 'provider-accounts.json'), 'utf8')).not.toContain(
      'fixture-pat',
    );
    const secrets = readdirSync(join(profile, 'provider-secrets'));
    expect(secrets).toHaveLength(1);
    expect(
      readFileSync(join(profile, 'provider-secrets', secrets[0]!)).includes(
        Buffer.from('fixture-pat'),
      ),
    ).toBe(false);
    await app.close();
    app = await electron.launch({ args });
    await fixtureProtection(app, true);
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Provider accounts' });
    await expect(dialog.getByText('fixture-user', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Forget fixture-user', exact: true }).click();
    await expect(dialog.getByText('fixture-user', { exact: true })).toHaveCount(0);
    expect(readdirSync(join(profile, 'provider-secrets'))).toEqual([]);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider account UI refuses connections when OS protection is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-provider-locked-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await app.evaluate(({ safeStorage }) => {
      safeStorage.isAsyncEncryptionAvailable = async () => false;
    });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Provider accounts' });
    await expect(
      dialog.getByText('Unlock or enable your operating-system keychain to connect a provider.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Connect account', exact: true }),
    ).toBeDisabled();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('closing account setup cancels validation without saving a late credential', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-provider-cancel-ui-'));
  const profile = join(root, 'profile');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }) => {
      session.fromPartition('openkraken-providers').fetch = async (_input, init) => {
        Reflect.set(globalThis, 'providerFixtureRequested', true);
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              Reflect.set(globalThis, 'providerFixtureAborted', true);
              reject(new Error('cancelled'));
            },
            { once: true },
          );
        });
      };
    });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Provider accounts' });
    await dialog.getByLabel('Personal access token', { exact: true }).fill('fixture-pat');
    await dialog.getByRole('button', { name: 'Connect account', exact: true }).click();
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, 'providerFixtureRequested')))
      .toBe(true);
    await dialog.getByRole('button', { name: 'Close accounts', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, 'providerFixtureAborted')))
      .toBe(true);
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    await expect(
      dialog.getByText('No provider accounts connected.', { exact: true }),
    ).toBeVisible();
    expect(readdirSync(profile)).not.toContain('provider-secrets');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('GitHub device sign-in shows a user code, opens only GitHub and saves the verified account', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-device-ui-'));
  const profile = join(root, 'profile');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session, shell }) => {
      const provider = session.fromPartition('openkraken-providers');
      const original = provider.fetch;
      shell.openExternal = async (url) => {
        Reflect.set(globalThis, 'openedProviderUrl', url);
      };
      provider.fetch = async (input, init) => {
        if (String(input) === 'https://api.github.com/user') return original(input, init);
        if (init?.method !== 'POST' || init.redirect !== 'error' || init.credentials !== 'omit')
          throw new Error('Unsafe device request');
        const params = new URLSearchParams(String(init.body));
        if (params.get('client_id') !== 'fixture-client') throw new Error('Unexpected client');
        if (String(input) === 'https://github.com/login/device/code') {
          if (params.get('scope') !== 'read:user public_repo') throw new Error('Unexpected scope');
          return Response.json({
            device_code: 'private-device-code',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 2,
          });
        }
        if (
          String(input) === 'https://github.com/login/oauth/access_token' &&
          params.get('device_code') === 'private-device-code'
        )
          return Response.json({
            access_token: 'fixture-pat',
            refresh_token: 'private-refresh-token',
            expires_in: 3600,
            refresh_token_expires_in: 86400,
            token_type: 'bearer',
            scope: 'read:user,public_repo',
          });
        throw new Error('Unexpected device request');
      };
    });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Provider accounts' });
    await dialog.getByLabel('GitHub application client ID', { exact: true }).fill('fixture-client');
    await dialog.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
    await expect(dialog.getByText('ABCD-EFGH', { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText('private-device-code');
    await dialog.getByRole('button', { name: 'Open GitHub authorization', exact: true }).click();
    expect(await app.evaluate(() => Reflect.get(globalThis, 'openedProviderUrl'))).toBe(
      'https://github.com/login/device',
    );
    await expect(dialog.getByText('fixture-user', { exact: true })).toBeVisible();
    await expect(dialog.getByText('ABCD-EFGH', { exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Verify fixture-user', exact: true }).click();
    await expect(
      dialog.getByRole('button', { name: 'Verify fixture-user', exact: true }),
    ).toBeEnabled();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    const metadata = readFileSync(join(profile, 'provider-accounts.json'), 'utf8');
    expect(metadata).toContain('"authentication":"device"');
    for (const secret of ['fixture-pat', 'private-refresh-token', 'private-device-code'])
      expect(metadata).not.toContain(secret);
    await page.screenshot({ path: 'test-results/github-device-connected.png' });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cancelled and closed device sign-ins cannot poll or replace a later authorization', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-device-cancel-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }) => {
      const provider = session.fromPartition('openkraken-providers');
      const original = provider.fetch;
      let starts = 0;
      const polled: string[] = [];
      Reflect.set(globalThis, 'deviceCodesPolled', polled);
      provider.fetch = async (input, init) => {
        if (String(input) === 'https://api.github.com/user') return original(input, init);
        if (String(input) === 'https://github.com/login/device/code')
          return Response.json({
            device_code: `private-${++starts}`,
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 2,
          });
        if (String(input) === 'https://github.com/login/oauth/access_token') {
          polled.push(new URLSearchParams(String(init?.body)).get('device_code') ?? 'missing');
          return Response.json({
            access_token: 'fixture-pat',
            token_type: 'bearer',
            scope: 'read:user,public_repo',
          });
        }
        throw new Error('Unexpected device request');
      };
    });
    const page = await app.firstWindow();
    const dialog = page.getByRole('dialog', { name: 'Provider accounts' });
    const start = async () => {
      await dialog
        .getByLabel('GitHub application client ID', { exact: true })
        .fill('fixture-client');
      await dialog.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
      await expect(dialog.getByText('ABCD-EFGH', { exact: true })).toBeVisible();
    };
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    await start();
    await dialog.getByRole('button', { name: 'Cancel GitHub sign-in', exact: true }).click();
    await expect(dialog.getByText('ABCD-EFGH', { exact: true })).toHaveCount(0);
    await start();
    await dialog.getByRole('button', { name: 'Close accounts', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    await start();
    await expect(dialog.getByText('fixture-user', { exact: true })).toBeVisible();
    expect(await app.evaluate(() => Reflect.get(globalThis, 'deviceCodesPolled'))).toEqual([
      'private-3',
    ]);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
