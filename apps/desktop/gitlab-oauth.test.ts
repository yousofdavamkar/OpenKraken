import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse, passthrough } from 'msw';
import { setupServer } from 'msw/node';
import { protection } from '../../tests/provider-protection.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';
import { GitLabOAuth } from './src/gitlab-oauth.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-gitlab-oauth-'));
const server = setupServer(http.all(/^http:\/\/127\.0\.0\.1:/, () => passthrough()));
const services: ProviderService[] = [];
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  for (const service of services) service.gitlabCancel();
  server.resetHandlers();
});
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});
async function port() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
function serviceFor(name: string, now = Date.now) {
  const directory = join(root, name);
  const vault = new ProviderVault(directory, protection());
  const service = new ProviderService(
    directory,
    vault,
    undefined,
    undefined,
    now,
    undefined,
    new GitLabOAuth(undefined, now),
  );
  services.push(service);
  return { service, directory, vault };
}

test('GitLab PKCE exchanges a single loopback code, validates identity and protects rotating credentials', async () => {
  const { service, directory } = serviceFor('success');
  const options = {
    origin: 'https://gitlab.example.test',
    clientId: 'fixture-client',
    callbackPort: await port(),
  };
  const challenge = await service.gitlabStart(options);
  const authorization = new URL(service.gitlabAuthorizationUri(challenge.id));
  expect(authorization.origin + authorization.pathname).toBe(`${options.origin}/oauth/authorize`);
  expect(authorization.searchParams.get('response_type')).toBe('code');
  expect(authorization.searchParams.get('scope')).toBe('api');
  expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorization.searchParams.get('redirect_uri')).toBe(
    `http://127.0.0.1:${options.callbackPort}/callback`,
  );
  expect(JSON.stringify(challenge)).not.toContain(authorization.searchParams.get('state'));
  let exchanges = 0;
  server.use(
    http.post(`${options.origin}/oauth/token`, async ({ request }) => {
      exchanges++;
      const body = new URLSearchParams(await request.text());
      expect(body.get('client_id')).toBe(options.clientId);
      expect(body.get('client_secret')).toBeNull();
      expect(body.get('code')).toBe('single-use-code');
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('redirect_uri')).toBe(challenge.redirectUri);
      const verifier = body.get('code_verifier')!;
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
      expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
        authorization.searchParams.get('code_challenge'),
      );
      return HttpResponse.json({
        access_token: 'oauth-secret',
        refresh_token: 'refresh-secret',
        token_type: 'bearer',
        expires_in: 7200,
        created_at: Math.floor(Date.now() / 1000),
      });
    }),
    http.get(`${options.origin}/api/v4/user`, ({ request }) => {
      expect(request.headers.get('authorization')).toBe('Bearer oauth-secret');
      return HttpResponse.json({ id: 42, username: 'pkce-user' });
    }),
  );
  expect(await service.gitlabPoll(challenge.id)).toEqual({ kind: 'providerGitLab', challenge });
  const callback = new URL(challenge.redirectUri);
  callback.searchParams.set('code', 'single-use-code');
  callback.searchParams.set('state', authorization.searchParams.get('state')!);
  const response = await fetch(callback);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain('single-use-code');
  const result = await service.gitlabPoll(challenge.id);
  expect(result).toMatchObject({
    kind: 'providerAccounts',
    state: {
      accounts: [
        {
          provider: 'gitlab',
          authentication: 'pkce',
          login: 'pkce-user',
          expiresAt: expect.any(Number),
        },
      ],
    },
  });
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(await readFile(join(directory, 'provider-accounts.json'), 'utf8')).not.toContain('secret');
  const account = (await service.accounts()).accounts[0]!;
  expect(
    await service.gitCredential(account.id, `${options.origin}/team/project.git`),
  ).toMatchObject({ username: 'oauth2', password: 'oauth-secret' });
  await expect(service.gitlabPoll(challenge.id)).rejects.toMatchObject({
    code: 'GITLAB_AUTH_EXPIRED',
  });
  await expect(fetch(callback)).rejects.toThrow();
  expect(exchanges).toBe(1);
});

test('GitLab rejects forged callbacks, releases cancelled listeners and never exchanges denied or expired grants', async () => {
  let now = Date.now();
  const { service } = serviceFor('callbacks', () => now);
  const options = {
    origin: 'https://gitlab.com',
    clientId: 'fixture-client',
    callbackPort: await port(),
  };
  const challenge = await service.gitlabStart(options);
  const state = new URL(service.gitlabAuthorizationUri(challenge.id)).searchParams.get('state')!;
  for (const suffix of [
    `?state=forged&code=secret`,
    `?state=${state}&state=${state}&code=secret`,
    `?state=${state}&code=one&code=two`,
    `?state=${state}&code=secret&error=denied`,
  ]) {
    expect((await fetch(challenge.redirectUri + suffix)).status).toBe(400);
    expect(await service.gitlabPoll(challenge.id)).toMatchObject({ kind: 'providerGitLab' });
  }
  expect(
    (await fetch(challenge.redirectUri + `?state=${state}&code=secret`, { method: 'POST' })).status,
  ).toBe(400);
  expect((await fetch(challenge.redirectUri + `?state=${state}&error=access_denied`)).status).toBe(
    200,
  );
  await expect(service.gitlabPoll(challenge.id)).rejects.toMatchObject({
    code: 'GITLAB_AUTH_DENIED',
  });
  const cancelled = await service.gitlabStart(options);
  service.gitlabCancel(cancelled.id);
  await expect(fetch(cancelled.redirectUri)).rejects.toThrow();
  await expect(service.gitlabPoll(cancelled.id)).rejects.toMatchObject({
    code: 'GITLAB_AUTH_EXPIRED',
  });
  const expired = await service.gitlabStart(options);
  now += 600001;
  await expect(service.gitlabPoll(expired.id)).rejects.toMatchObject({
    code: 'GITLAB_AUTH_EXPIRED',
  });
  await expect(fetch(expired.redirectUri)).rejects.toThrow();
  expect((await service.accounts()).accounts).toEqual([]);
});

test('GitLab reports an occupied callback port without replacing or contacting the other listener', async () => {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  try {
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const { service } = serviceFor('occupied');
    await expect(
      service.gitlabStart({
        origin: 'https://gitlab.com',
        clientId: 'client',
        callbackPort: address.port,
      }),
    ).rejects.toMatchObject({ code: 'GITLAB_CALLBACK' });
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

test('GitLab saves refresh rotation before an interrupted identity check and recovers on restart', async () => {
  let now = Date.now();
  const { service, directory, vault } = serviceFor('refresh', () => now);
  const origin = 'https://gitlab.example.test';
  const challenge = await service.gitlabStart({
    origin,
    clientId: 'refresh-client',
    callbackPort: await port(),
  });
  const state = new URL(service.gitlabAuthorizationUri(challenge.id)).searchParams.get('state')!;
  let refreshing = false,
    failedIdentity = false,
    refreshes = 0;
  server.use(
    http.post(`${origin}/oauth/token`, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      refreshing = body.get('grant_type') === 'refresh_token';
      if (refreshing) {
        refreshes++;
        expect(body.get('refresh_token')).toBe('first-refresh');
        expect(body.get('redirect_uri')).toBe(challenge.redirectUri);
        expect(body.get('client_secret')).toBeNull();
      }
      return HttpResponse.json({
        access_token: refreshing ? 'rotated-token' : 'initial-token',
        refresh_token: refreshing ? 'rotated-refresh' : 'first-refresh',
        token_type: 'bearer',
        expires_in: refreshing ? 7200 : 120,
        created_at: Math.floor(now / 1000),
      });
    }),
    http.get(`${origin}/api/v4/user`, ({ request }) => {
      if (refreshing) {
        expect(request.headers.get('authorization')).toBe('Bearer rotated-token');
        if (!failedIdentity) {
          failedIdentity = true;
          return HttpResponse.error();
        }
      }
      return HttpResponse.json({ id: 42, username: 'refresh-user' });
    }),
  );
  await fetch(`${challenge.redirectUri}?state=${state}&code=initial-code`);
  await service.gitlabPoll(challenge.id);
  const account = (await service.accounts()).accounts[0]!;
  now += 65000;
  await expect(service.verify(account.id)).rejects.toMatchObject({ code: 'PROVIDER_REQUEST' });
  const reopened = new ProviderService(
    directory,
    vault,
    undefined,
    undefined,
    () => now,
    undefined,
    new GitLabOAuth(undefined, () => now),
  );
  expect((await reopened.verify(account.id)).accounts[0]).toMatchObject({
    id: account.id,
    login: 'refresh-user',
    expiresAt: now - (now % 1000) + 7200000,
  });
  expect(refreshes).toBe(1);
});
