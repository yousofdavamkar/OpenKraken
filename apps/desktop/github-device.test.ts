import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { GitHubDeviceFlow, GitHubOAuth } from './src/github-device.js';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
const challenge = {
  device_code: 'private-device-code',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};

test('device authorization waits for the polling interval and returns only the completed account result', async () => {
  let now = 100000,
    polls = 0;
  const received: unknown[] = [];
  // Completion is the public account-service boundary; no secret is returned to the caller.
  const flow = new GitHubDeviceFlow(
    async (credential) => {
      received.push(credential);
      return { keychainAvailable: true, accounts: [] };
    },
    undefined,
    () => now,
  );
  server.use(
    http.post('https://github.com/login/device/code', async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      expect(body.get('client_id')).toBe('fixture-client');
      expect(body.get('scope')).toBe('read:user public_repo');
      return HttpResponse.json(challenge);
    }),
    http.post('https://github.com/login/oauth/access_token', async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      expect(body.get('device_code')).toBe('private-device-code');
      expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
      polls++;
      return HttpResponse.json(
        polls === 1
          ? { error: 'authorization_pending' }
          : {
              access_token: 'secret-access-token',
              token_type: 'bearer',
              scope: 'read:user,public_repo',
            },
      );
    }),
  );
  const opened = await flow.start({ clientId: 'fixture-client', privateRepositories: false });
  expect(opened.userCode).toBe('ABCD-EFGH');
  expect(JSON.stringify(opened)).not.toContain('private-device-code');
  expect(opened.nextPollAt).toBe(105000);
  expect((await flow.poll(opened.id)).kind).toBe('providerDevice');
  expect(polls).toBe(0);
  now += 5000;
  expect((await flow.poll(opened.id)).kind).toBe('providerDevice');
  now += 5000;
  const completed = await flow.poll(opened.id);
  expect(completed).toEqual({
    kind: 'providerAccounts',
    state: { keychainAvailable: true, accounts: [] },
  });
  expect(JSON.stringify(completed)).not.toContain('secret-access-token');
  expect(received).toEqual([
    {
      accessToken: 'secret-access-token',
      clientId: 'fixture-client',
      scope: 'read:user,public_repo',
    },
  ]);
  await expect(flow.poll(opened.id)).rejects.toMatchObject({ code: 'DEVICE_EXPIRED' });
});

test('slow-down responses increase the minimum polling interval and expired codes cannot be reused', async () => {
  let now = 100000,
    polls = 0;
  const flow = new GitHubDeviceFlow(
    async () => {
      throw new Error('must not complete');
    },
    undefined,
    () => now,
  );
  server.use(
    http.post('https://github.com/login/device/code', () =>
      HttpResponse.json({ ...challenge, expires_in: 25 }),
    ),
    http.post('https://github.com/login/oauth/access_token', () => {
      polls++;
      return HttpResponse.json({ error: 'slow_down', interval: 12 });
    }),
  );
  const opened = await flow.start({ clientId: 'fixture-client', privateRepositories: true });
  now += 5000;
  const pending = await flow.poll(opened.id);
  expect(pending).toMatchObject({ kind: 'providerDevice', challenge: { nextPollAt: 117000 } });
  now = 116999;
  await flow.poll(opened.id);
  expect(polls).toBe(1);
  now = 125000;
  await expect(flow.poll(opened.id)).rejects.toMatchObject({ code: 'DEVICE_EXPIRED' });
  expect(polls).toBe(1);
});

test('declined authorization and untrusted verification URLs cannot complete or open a browser', async () => {
  let now = 100000;
  const flow = new GitHubDeviceFlow(
    async () => {
      throw new Error('must not complete');
    },
    undefined,
    () => now,
  );
  server.use(
    http.post('https://github.com/login/device/code', () =>
      HttpResponse.json({ ...challenge, verification_uri: 'https://other.test/login/device' }),
    ),
  );
  await expect(
    flow.start({ clientId: 'fixture-client', privateRepositories: false }),
  ).rejects.toMatchObject({ code: 'DEVICE_RESPONSE' });
  server.use(
    http.post('https://github.com/login/device/code', () => HttpResponse.json(challenge)),
    http.post('https://github.com/login/oauth/access_token', () =>
      HttpResponse.json({ error: 'access_denied', error_description: 'secret-device-code' }),
    ),
  );
  const opened = await flow.start({ clientId: 'fixture-client', privateRepositories: false });
  expect(flow.verificationUri(opened.id)).toBe('https://github.com/login/device');
  now += 5000;
  await expect(flow.poll(opened.id)).rejects.toMatchObject({
    code: 'DEVICE_DENIED',
    message: 'GitHub authorization was declined. Start again to sign in.',
  });
  expect(() => flow.verificationUri(opened.id)).toThrow('expired');
});

test('expiring tokens preserve refresh credentials and rotation uses the device client without a client secret', async () => {
  const oauth = new GitHubOAuth(undefined, () => 100000);
  const credential = oauth.credential(
    {
      access_token: 'first-token',
      token_type: 'bearer',
      scope: 'repo',
      expires_in: 120,
      refresh_token: 'first-refresh',
      refresh_token_expires_in: 600,
    },
    'fixture-client',
  );
  expect(credential).toMatchObject({ expiresAt: 220000, refreshExpiresAt: 700000 });
  server.use(
    http.post('https://github.com/login/oauth/access_token', async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      expect(Object.fromEntries(body)).toEqual({
        client_id: 'fixture-client',
        grant_type: 'refresh_token',
        refresh_token: 'first-refresh',
      });
      return HttpResponse.json({
        access_token: 'next-token',
        token_type: 'bearer',
        scope: 'repo',
        expires_in: 240,
        refresh_token: 'next-refresh',
        refresh_token_expires_in: 900,
      });
    }),
  );
  expect(await oauth.refresh(credential)).toEqual({
    clientId: 'fixture-client',
    accessToken: 'next-token',
    scope: 'repo',
    expiresAt: 340000,
    refreshToken: 'next-refresh',
    refreshExpiresAt: 1000000,
  });
});

test('OAuth redirects are refused before a second host receives the request', async () => {
  let escaped = false;
  server.use(
    http.post('https://github.com/login/device/code', () =>
      HttpResponse.redirect('https://other.test/oauth'),
    ),
    http.all('https://other.test/oauth', () => {
      escaped = true;
      return HttpResponse.json(challenge);
    }),
  );
  const flow = new GitHubDeviceFlow(async () => {
    throw new Error('must not complete');
  });
  await expect(
    flow.start({ clientId: 'fixture-client', privateRepositories: false }),
  ).rejects.toMatchObject({ code: 'DEVICE_REQUEST' });
  expect(escaped).toBe(false);
});

test('only one token poll can run and cancelling it prevents completion', async () => {
  let now = 100000,
    polls = 0,
    completed = false;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const flow = new GitHubDeviceFlow(
    async () => {
      completed = true;
      return { keychainAvailable: true, accounts: [] };
    },
    undefined,
    () => now,
  );
  server.use(
    http.post('https://github.com/login/device/code', () => HttpResponse.json(challenge)),
    http.post('https://github.com/login/oauth/access_token', async ({ request }) => {
      polls++;
      entered();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return HttpResponse.json({ access_token: 'late-token', token_type: 'bearer', scope: 'repo' });
    }),
  );
  const opened = await flow.start({ clientId: 'fixture-client', privateRepositories: false });
  now += 5000;
  const pending = expect(flow.poll(opened.id)).rejects.toMatchObject({ code: 'CANCELLED' });
  await started;
  now += 6000;
  expect((await flow.poll(opened.id)).kind).toBe('providerDevice');
  expect(polls).toBe(1);
  flow.cancel(opened.id);
  await pending;
  expect(completed).toBe(false);
  expect(() => flow.verificationUri(opened.id)).toThrow('expired');
});
