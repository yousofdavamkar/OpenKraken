import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ProviderService } from './src/providers.js';
import { ProviderVault, type SecretProtection } from './src/provider-vault.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-providers-'));
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});
function protection(): SecretProtection {
  const key = randomBytes(32);
  return {
    available: async () => true,
    encrypt: async (text) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]);
    },
    decrypt: async (value) => {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return {
        result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(),
        shouldReEncrypt: false,
      };
    },
  };
}
test('GitHub account validation stores a protected credential and returns metadata across restarts', async () => {
  const directory = join(root, 'connect');
  const vault = new ProviderVault(directory, protection());
  const providers = new ProviderService(directory, vault);
  server.use(
    http.get('https://api.github.com/user', ({ request }) => {
      expect(request.headers.get('authorization')).toBe('token fixture-pat');
      expect(request.headers.get('user-agent')).toContain('OpenKraken');
      return HttpResponse.json({ id: 123, login: 'fixture-user', name: 'Fixture User' });
    }),
  );
  expect(await providers.accounts()).toEqual({ keychainAvailable: true, accounts: [] });
  const connected = await providers.connect({
    provider: 'github',
    origin: 'https://github.com/',
    token: 'fixture-pat',
  });
  expect(connected.accounts).toEqual([
    {
      id: expect.stringMatching(/^[0-9a-f]{64}$/),
      provider: 'github',
      origin: 'https://github.com',
      providerUserId: '123',
      login: 'fixture-user',
    },
  ]);
  expect(JSON.stringify(connected)).not.toContain('fixture-pat');
  const manifest = await readFile(join(directory, 'provider-accounts.json'), 'utf8');
  expect(manifest).not.toContain('fixture-pat');
  const reopened = new ProviderService(directory, vault);
  expect(await reopened.accounts()).toEqual(connected);
  await reopened.disconnect(connected.accounts[0]!.id);
  expect((await reopened.accounts()).accounts).toEqual([]);
  expect(await readdir(join(directory, 'provider-secrets'))).toEqual([]);
});

test('enterprise identity uses the selected HTTPS API origin and stable IDs survive login changes', async () => {
  const directory = join(root, 'enterprise');
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  let login = 'before-rename';
  server.use(
    http.get('https://git.example.test/api/v3/user', ({ request }) => {
      expect(request.headers.get('x-github-api-version')).toBe('2022-11-28');
      return HttpResponse.json({ id: 432, login });
    }),
  );
  const options = {
    provider: 'github' as const,
    origin: 'https://git.example.test',
    token: 'enterprise-pat',
  };
  const before = await providers.connect(options);
  login = 'after-rename';
  const after = await providers.connect(options);
  expect(after.accounts).toHaveLength(1);
  expect(after.accounts[0]!.id).toBe(before.accounts[0]!.id);
  expect(after.accounts[0]!.login).toBe('after-rename');
});

test('failed authentication and insecure origins never save tokens or expose provider error bodies', async () => {
  const directory = join(root, 'errors');
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  let calls = 0;
  server.use(
    http.all('*', () => {
      calls++;
      return HttpResponse.json({ message: 'echoed-fixture-secret' }, { status: 401 });
    }),
  );
  const options = {
    provider: 'github' as const,
    origin: 'https://github.com',
    token: 'echoed-fixture-secret',
  };
  await expect(providers.connect(options)).rejects.toMatchObject({
    code: 'PROVIDER_AUTH',
    message: 'The provider rejected this token. Check its validity and permissions.',
  });
  for (const origin of [
    'http://github.com',
    'https://user:password@github.com',
    'https://github.com/path',
    'https://github.com?token=secret',
  ])
    await expect(providers.connect({ ...options, origin })).rejects.toThrow();
  expect(calls).toBe(1);
  expect((await providers.accounts()).accounts).toEqual([]);
  await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('redirected, oversized and cancelled provider responses never create accounts', async () => {
  const directory = join(root, 'network');
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  const options = {
    provider: 'github' as const,
    origin: 'https://github.com',
    token: 'fixture-pat',
  };
  let escaped = false;
  server.use(
    http.get('https://api.github.com/user', () => HttpResponse.redirect('https://other.test/user')),
    http.get('https://other.test/user', () => {
      escaped = true;
      return HttpResponse.json({ id: 1, login: 'escaped' });
    }),
  );
  await expect(providers.connect(options)).rejects.toThrow();
  expect(escaped).toBe(false);
  server.use(
    http.get(
      'https://api.github.com/user',
      () => new HttpResponse('x'.repeat(4 * 1024 * 1024 + 1)),
    ),
  );
  await expect(providers.connect(options)).rejects.toThrow();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  server.use(
    http.get('https://api.github.com/user', async ({ request }) => {
      entered();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return HttpResponse.json({ id: 1, login: 'cancelled' });
    }),
  );
  const controller = new AbortController();
  const pending = expect(providers.connect(options, controller.signal)).rejects.toMatchObject({
    code: 'CANCELLED',
  });
  await started;
  controller.abort();
  await pending;
  expect((await providers.accounts()).accounts).toEqual([]);
  await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('imprecise provider user IDs cannot bind a credential to the wrong account', async () => {
  const directory = join(root, 'invalid-identity');
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  server.use(
    http.get('https://api.github.com/user', () =>
      HttpResponse.json({ id: Number.MAX_SAFE_INTEGER + 1, login: 'fixture-user' }),
    ),
  );
  await expect(
    providers.connect({ provider: 'github', origin: 'https://github.com', token: 'fixture-pat' }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  expect((await providers.accounts()).accounts).toEqual([]);
});
