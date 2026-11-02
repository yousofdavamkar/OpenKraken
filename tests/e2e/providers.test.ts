import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
import { authenticatedRemote } from '../../packages/test-fixtures/src/authenticated-remote.js';

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

test('provider repository picker appends pages, filters loaded repositories and clones the chosen URL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-provider-picker-'));
  const source = createFixture(join(root, 'source'));
  const target = join(root, 'target');
  const config = join(root, 'gitconfig');
  mkdirSync(target);
  // Native Git performs the clone; only the remote transport is redirected to a deterministic fixture.
  fixtureGit(source, [
    'config',
    '--file',
    config,
    `url.${source}.insteadOf`,
    'https://github.com/fixture-org/chosen.git',
  ]);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
    env: { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' },
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session, dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      const partition = session.fromPartition('openkraken-providers');
      const original = partition.fetch;
      partition.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname !== '/user/repos') return original(input, init);
        if (
          url.origin !== 'https://api.github.com' ||
          new Headers(init?.headers).get('authorization') !== 'token fixture-pat'
        )
          throw new Error('Unexpected request');
        const first = url.searchParams.get('page') === '1';
        return new Response(
          JSON.stringify(
            Array.from({ length: first ? 100 : 2 }, (_, index) => ({
              id: first ? index + 1 : index === 0 ? 100 : 101,
              owner: { login: 'fixture-org' },
              name: first
                ? `project-${String(index).padStart(3, '0')}`
                : index === 0
                  ? 'project-099'
                  : 'chosen',
              description: 'A repository fixture',
              private: false,
              archived: false,
              clone_url: 'https://attacker.test/ignored.git',
            })),
          ),
          { headers: { 'content-type': 'application/json' } },
        );
      };
    }, target);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    const accounts = page.getByRole('dialog', { name: 'Provider accounts' });
    await accounts.getByLabel('Personal access token', { exact: true }).fill('fixture-pat');
    await accounts.getByRole('button', { name: 'Connect account', exact: true }).click();
    await expect(accounts.getByRole('button', { name: 'Forget fixture-user' })).toBeVisible();
    await accounts.getByRole('button', { name: 'Close accounts' }).click();
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Clone repository' });
    await picker.getByRole('button', { name: 'Browse provider repositories' }).click();
    await expect(picker.getByRole('status')).toContainText('100 repositories loaded');
    expect(
      await picker.getByRole('option', { name: /^Select fixture-org\// }).count(),
    ).toBeLessThan(20);
    const list = picker.getByRole('listbox', { name: 'Repositories', exact: true });
    await list.focus();
    await list.press('End');
    await expect(
      picker.getByRole('option', { name: 'Select fixture-org/project-099' }),
    ).toHaveAttribute('aria-selected', 'true');
    await list.press('Home');
    await list.press('ArrowDown');
    await expect(
      picker.getByRole('option', { name: 'Select fixture-org/project-001' }),
    ).toHaveAttribute('aria-selected', 'true');
    await picker.getByLabel('Search loaded repositories').fill('chosen');
    await expect(picker.getByText('No loaded repositories match.')).toBeVisible();
    await picker.getByRole('button', { name: 'Load more repositories' }).click();
    await expect(picker.getByRole('status')).toContainText('101 repositories loaded');
    await expect(
      picker.getByRole('option', { name: 'Select fixture-org/chosen', exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: 'test-results/provider-repository-picker.png' });
    await list.focus();
    await list.press('Enter');
    await picker.getByLabel('Use saved provider account for HTTPS authentication').uncheck();
    await expect(picker.getByLabel('Repository URL or absolute path')).toHaveValue(
      'https://github.com/fixture-org/chosen.git',
    );
    await picker.getByRole('button', { name: 'Choose folder and clone' }).click();
    await expect(picker).toHaveCount(0);
    await expect(page.getByTestId('head')).toHaveText('main');
    expect(fixtureGit(target, ['rev-parse', 'HEAD'])).toBe(
      fixtureGit(source, ['rev-parse', 'HEAD']),
    );
    expect(fixtureGit(target, ['remote', 'get-url', '--all', 'origin'])).toBe(
      'https://github.com/fixture-org/chosen.git',
    );
    expect(readFileSync(join(target, '.git/config'), 'utf8')).toContain(
      'https://github.com/fixture-org/chosen.git',
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('repository browsing cancels on account switches and close, and retries sanitized failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-picker-cancel-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }) => {
      const partition = session.fromPartition('openkraken-providers');
      const original = partition.fetch;
      let attempts = 0;
      Object.assign(globalThis, { pickerStarted: 0, pickerCancelled: 0 });
      partition.fetch = async (input, init) => {
        const url = new URL(String(input));
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        if (url.href === 'https://git.example.test/api/v3/user')
          return json({ id: 456, login: 'enterprise-user' });
        if (url.href.startsWith('https://git.example.test/api/v3/user/repos?')) {
          attempts++;
          if (attempts === 1) return json({ message: 'echoed-private-secret' }, 403);
          return json([
            {
              id: 1,
              owner: { login: 'enterprise-org' },
              name: 'private-project',
              description: null,
              private: true,
              archived: false,
            },
          ]);
        }
        if (url.href.startsWith('https://api.github.com/user/repos?')) {
          const counters = globalThis as typeof globalThis & {
            pickerStarted: number;
            pickerCancelled: number;
          };
          counters.pickerStarted++;
          await new Promise<void>((resolve) => {
            if (init?.signal?.aborted) resolve();
            else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          counters.pickerCancelled++;
          return json([
            {
              id: 1,
              owner: { login: 'stale' },
              name: 'wrong-account',
              description: null,
              private: false,
              archived: false,
            },
          ]);
        }
        return original(input, init);
      };
    });
    const page = await app.firstWindow();
    for (const origin of ['https://github.com', 'https://git.example.test']) {
      const result = await page.evaluate(
        (origin) =>
          window.openkraken.request({
            id: crypto.randomUUID(),
            method: 'providerConnect',
            options: { provider: 'github', origin, token: 'fixture-pat' },
          }),
        origin,
      );
      expect(result.kind).toBe('providerAccounts');
    }
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Clone repository' });
    await picker.getByRole('button', { name: 'Browse provider repositories' }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as typeof globalThis & { pickerStarted: number }).pickerStarted,
        ),
      )
      .toBe(1);
    await picker
      .getByLabel('Provider account', { exact: true })
      .selectOption({ label: 'enterprise-user · https://git.example.test' });
    await expect(picker.getByRole('alert')).toContainText('The provider denied access');
    await expect(picker).not.toContainText('echoed-private-secret');
    await expect(picker).not.toContainText('wrong-account');
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as typeof globalThis & { pickerCancelled: number }).pickerCancelled,
        ),
      )
      .toBe(1);
    await picker.getByRole('button', { name: 'Retry repositories' }).click();
    await expect(
      picker.getByRole('option', { name: 'Select enterprise-org/private-project' }),
    ).toBeVisible();
    await picker.getByRole('option', { name: 'Select enterprise-org/private-project' }).click();
    await expect(picker.getByLabel('Repository URL or absolute path')).toHaveValue(
      'https://git.example.test/enterprise-org/private-project.git',
    );
    await picker.getByRole('button', { name: 'Browse provider repositories' }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as typeof globalThis & { pickerStarted: number }).pickerStarted,
        ),
      )
      .toBe(2);
    await picker.getByRole('button', { name: 'Close', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as typeof globalThis & { pickerCancelled: number }).pickerCancelled,
        ),
      )
      .toBe(2);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a saved provider account authenticates native HTTPS clone without exposing its token to renderer results or Git config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-saved-clone-'));
  const source = createFixture(join(root, 'source'));
  const bare = join(root, 'remote.git');
  fixtureGit(source, ['clone', '--bare', '.', bare]);
  const remote = await authenticatedRemote(bare, {
    basePath: '/team/project.git',
    password: 'fixture-provider-secret',
  });
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
    await fixtureProtection(app);
    const origin = new URL(remote.url).origin;
    await app.evaluate(
      ({ session, dialog }, { origin, target }) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
        session.fromPartition('openkraken-providers').fetch = async (input, init) => {
          const url = new URL(String(input));
          if (
            url.origin !== origin ||
            new Headers(init?.headers).get('authorization') !== 'token fixture-provider-secret'
          )
            throw new Error('Unexpected provider request');
          const body =
            url.pathname === '/api/v3/user'
              ? { id: 321, login: 'fixture-user' }
              : url.pathname === '/api/v3/user/repos'
                ? [
                    {
                      id: 1,
                      owner: { login: 'team' },
                      name: 'project',
                      description: null,
                      private: true,
                      archived: false,
                    },
                  ]
                : null;
          if (!body) throw new Error('Unexpected provider endpoint');
          return new Response(JSON.stringify(body), {
            headers: { 'content-type': 'application/json' },
          });
        };
      },
      { origin, target },
    );
    const page = await app.firstWindow();
    await page.evaluate(() => {
      const events: unknown[] = [];
      Object.assign(window, { providerCloneEvents: events });
      window.openkraken.subscribe((event) => events.push(event));
    });
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    const accounts = page.getByRole('dialog', { name: 'Provider accounts' });
    await accounts.getByLabel('Provider host').fill(origin);
    await accounts
      .getByLabel('Personal access token', { exact: true })
      .fill(remote.credentials.password);
    await accounts.getByRole('button', { name: 'Connect account', exact: true }).click();
    await expect(accounts.getByRole('button', { name: 'Forget fixture-user' })).toBeVisible();
    await accounts.getByRole('button', { name: 'Close accounts' }).click();
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    const clone = page.getByRole('dialog', { name: 'Clone repository' });
    await clone.getByRole('button', { name: 'Browse provider repositories' }).click();
    await clone.getByRole('option', { name: 'Select team/project' }).click();
    await expect(
      clone.getByLabel('Use saved provider account for HTTPS authentication'),
    ).toBeChecked();
    await clone.getByRole('button', { name: 'Choose folder and clone' }).click();
    await expect(clone).toHaveCount(0);
    await expect(page.getByTestId('head')).toHaveText('main');
    expect(fixtureGit(target, ['rev-parse', 'HEAD'])).toBe(
      fixtureGit(source, ['rev-parse', 'HEAD']),
    );
    expect(remote.authenticated()).toBeGreaterThan(1);
    const rendered = await page.evaluate(() =>
      JSON.stringify({
        events: (window as typeof window & { providerCloneEvents: unknown[] }).providerCloneEvents,
        storage: localStorage,
        text: document.body.innerText,
      }),
    );
    expect(rendered).not.toContain(remote.credentials.password);
    expect(rendered).not.toContain('authenticationPrompt');
    expect(readFileSync(join(target, '.git/config'), 'utf8')).toContain(remote.url);
    expect(readFileSync(join(target, '.git/config'), 'utf8')).not.toContain(
      remote.credentials.password,
    );
    expect(readFileSync(join(root, 'profile/provider-accounts.json'), 'utf8')).not.toContain(
      remote.credentials.password,
    );
    const cancelledTarget = join(root, 'cancelled');
    mkdirSync(cancelledTarget);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, cancelledTarget);
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    await clone.getByRole('button', { name: 'Browse provider repositories' }).click();
    await clone.getByRole('option', { name: 'Select team/project' }).click();
    await app.evaluate(({ session }) => {
      const partition = session.fromPartition('openkraken-providers');
      const original = partition.fetch;
      Object.assign(globalThis, { cloneValidationStarted: false, cloneValidationCancelled: false });
      partition.fetch = async (input, init) => {
        Object.assign(globalThis, { cloneValidationStarted: true });
        await new Promise<void>((resolve) => {
          if (init?.signal?.aborted) resolve();
          else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        Object.assign(globalThis, { cloneValidationCancelled: true });
        return original(input, init);
      };
    });
    const requestsBeforeCancel = remote.requests();
    await clone.getByRole('button', { name: 'Choose folder and clone' }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { cloneValidationStarted: boolean })
              .cloneValidationStarted,
        ),
      )
      .toBe(true);
    await clone.getByRole('button', { name: 'Cancel clone', exact: true }).click();
    await expect(clone.getByRole('button', { name: 'Choose folder and clone' })).toBeEnabled();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { cloneValidationCancelled: boolean })
              .cloneValidationCancelled,
        ),
      )
      .toBe(true);
    expect(remote.requests()).toBe(requestsBeforeCancel);
    expect(readdirSync(cancelledTarget)).toEqual([]);
    await clone.getByLabel('Repository URL or absolute path').fill(source);
    await expect(
      clone.getByLabel('Use saved provider account for HTTPS authentication'),
    ).toHaveCount(0);
  } finally {
    await app.close();
    await remote.close();
    rmSync(root, { recursive: true, force: true });
  }
});
