import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';
import { githubIssueFixture as issue } from '../../packages/test-fixtures/src/provider.js';
import { protection } from '../../tests/provider-protection.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-provider-policy-'));
const server = setupServer();
const start = Date.parse('2026-11-01T00:00:00Z');
const repository = { owner: 'team', name: 'project' };
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
});
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});
async function setup(name: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  const directory = join(root, name);
  const api = 'https://api.github.com';
  server.use(http.get(`${api}/user`, () => HttpResponse.json({ id: 321, login: 'reader' })));
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  const account = (
    await providers.connect({
      provider: 'github',
      origin: 'https://github.com',
      token: 'policy-secret',
    })
  ).accounts[0]!;
  return { providers, account, api };
}

test('Retry-After prevents more provider requests until its deadline and never retries automatically', async () => {
  const { providers, account, api } = await setup('retry-after');
  let requests = 0;
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, () => {
      requests++;
      return requests === 1
        ? HttpResponse.json(
            { message: 'rate limit' },
            { status: 429, headers: { 'retry-after': '120' } },
          )
        : HttpResponse.json(issue());
    }),
  );
  const read = () => providers.issue(account.id, { repository, number: 1 });
  await expect(read()).rejects.toMatchObject({
    code: 'PROVIDER_RATE_LIMIT',
    retryAt: start + 120000,
  });
  vi.setSystemTime(start + 119999);
  await expect(read()).rejects.toMatchObject({
    code: 'PROVIDER_RATE_LIMIT',
    retryAt: start + 120000,
  });
  expect(requests).toBe(1);
  vi.setSystemTime(start + 120000);
  expect((await read()).number).toBe(1);
  expect(requests).toBe(2);
});

test.each([
  {
    name: 'HTTP-date',
    status: 503,
    headers: { 'retry-after': 'Sun, 01 Nov 2026 00:02:00 GMT' },
    seconds: 120,
  },
  {
    name: 'primary reset',
    status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1793491290' },
    seconds: 90,
  },
  {
    name: 'longer reset',
    status: 429,
    headers: {
      'retry-after': '30',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1793491290',
    },
    seconds: 90,
  },
  { name: 'unspecified 429', status: 429, headers: {}, seconds: 60 },
  { name: 'secondary 403', status: 403, headers: {}, seconds: 60 },
])('provider cooldown follows $name guidance', async ({ name, status, headers, seconds }) => {
  const { providers, account, api } = await setup(name);
  let requests = 0;
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, () => {
      requests++;
      return HttpResponse.json(
        { message: 'You have exceeded a secondary rate limit.' },
        {
          status,
          headers: new Headers(
            Object.entries(headers).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
        },
      );
    }),
  );
  await expect(providers.issue(account.id, { repository, number: 1 })).rejects.toMatchObject({
    retryAt: start + seconds * 1000,
  });
  await expect(providers.issue(account.id, { repository, number: 1 })).rejects.toMatchObject({
    code: 'PROVIDER_RATE_LIMIT',
    retryAt: start + seconds * 1000,
  });
  expect(requests).toBe(1);
});

test('a successful preflight that exhausts quota stops an issue write before dispatch', async () => {
  const { providers, account, api } = await setup('preflight-quota');
  let reads = 0,
    writes = 0;
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, () => {
      reads++;
      return HttpResponse.json(issue(), {
        headers:
          reads === 1
            ? {}
            : {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': '1793491290',
              },
      });
    }),
    http.post(`${api}/repos/team/project/issues/1/comments`, () => {
      writes++;
      return HttpResponse.json({});
    }),
  );
  const preview = await providers.previewIssueAction(account.id, { repository, number: 1 });
  await expect(
    providers.writeIssue(account.id, {
      action: 'comment',
      repository,
      number: 1,
      revision: preview.revision,
      body: 'Comment',
    }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryAt: start + 90000 });
  expect(writes).toBe(0);
});

test('polling policy exposes server intervals and cooldowns without HTTP or credential disclosure', async () => {
  const { providers, account, api } = await setup('policy');
  let requests = 0;
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, () => {
      requests++;
      return HttpResponse.json(
        issue(),
        requests === 1
          ? { headers: { 'x-poll-interval': '120' } }
          : { status: 429, headers: { 'retry-after': '90' } },
      );
    }),
  );
  expect(await providers.pollingPolicy(account.id)).toEqual({
    minimumIntervalMs: 0,
    blockedUntil: null,
  });
  await providers.issue(account.id, { repository, number: 1 });
  expect(await providers.pollingPolicy(account.id)).toEqual({
    minimumIntervalMs: 120000,
    blockedUntil: null,
  });
  await expect(providers.issue(account.id, { repository, number: 1 })).rejects.toMatchObject({
    code: 'PROVIDER_RATE_LIMIT',
  });
  server.use(
    http.get(`${api}/user`, () => {
      throw new Error('Policy lookup must not make an identity request');
    }),
  );
  expect(await providers.pollingPolicy(account.id)).toEqual({
    minimumIntervalMs: 120000,
    blockedUntil: start + 90000,
  });
  expect(requests).toBe(2);
  vi.setSystemTime(start + 90000);
  expect(await providers.pollingPolicy(account.id)).toEqual({
    minimumIntervalMs: 120000,
    blockedUntil: null,
  });
});

test('repeated secondary limits back off despite successful identity reads and recovery resets the delay', async () => {
  const { providers, account, api } = await setup('backoff');
  let limited = true;
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, () =>
      limited ? new HttpResponse(null, { status: 429 }) : HttpResponse.json(issue()),
    ),
  );
  const read = () => providers.issue(account.id, { repository, number: 1 });
  await expect(read()).rejects.toMatchObject({ retryAt: start + 60000 });
  vi.setSystemTime(start + 60000);
  await expect(read()).rejects.toMatchObject({ retryAt: start + 180000 });
  vi.setSystemTime(start + 180000);
  limited = false;
  await read();
  limited = true;
  await expect(read()).rejects.toMatchObject({ retryAt: start + 240000 });
});

test('server delay headers survive a response that exceeds the body limit', async () => {
  const { providers, account, api } = await setup('oversize');
  server.use(
    http.get(
      `${api}/repos/team/project/issues/1`,
      () =>
        new HttpResponse('x'.repeat(4 * 1024 * 1024 + 1), {
          status: 429,
          headers: { 'retry-after': '120' },
        }),
    ),
  );
  await expect(providers.issue(account.id, { repository, number: 1 })).rejects.toMatchObject({
    retryAt: start + 120000,
  });
  expect((await providers.pollingPolicy(account.id)).blockedUntil).toBe(start + 120000);
});

test('cooldowns are isolated by credential and host and survive reconnect attempts', async () => {
  const { providers, account, api } = await setup('isolation');
  const enterprise = 'https://git.example.test';
  server.use(
    http.get(`${api}/user`, ({ request }) =>
      HttpResponse.json({
        id: request.headers.get('authorization') === 'token other-secret' ? 322 : 321,
        login: 'reader',
      }),
    ),
    http.get(`${enterprise}/api/v3/user`, () => HttpResponse.json({ id: 321, login: 'reader' })),
  );
  const other = (
    await providers.connect({
      provider: 'github',
      origin: 'https://github.com',
      token: 'other-secret',
    })
  ).accounts.find((item) => item.providerUserId === '322')!;
  const hosted = (
    await providers.connect({ provider: 'github', origin: enterprise, token: 'policy-secret' })
  ).accounts.find((item) => item.origin === enterprise)!;
  server.use(
    http.get(
      `${api}/repos/team/project/issues/1`,
      () => new HttpResponse(null, { status: 429, headers: { 'retry-after': '90' } }),
    ),
  );
  await expect(providers.issue(account.id, { repository, number: 1 })).rejects.toMatchObject({
    retryAt: start + 90000,
  });
  expect(await providers.pollingPolicy(other.id)).toEqual({
    minimumIntervalMs: 0,
    blockedUntil: null,
  });
  expect(await providers.pollingPolicy(hosted.id)).toEqual({
    minimumIntervalMs: 0,
    blockedUntil: null,
  });
  await expect(
    providers.connect({ provider: 'github', origin: 'https://github.com', token: 'policy-secret' }),
  ).rejects.toMatchObject({ retryAt: start + 90000 });
  await providers.verify(other.id);
  await providers.verify(hosted.id);
});

test('a cooldown learned after write dispatch preserves uncertain outcome handling', async () => {
  const { providers, account, api } = await setup('uncertain-write');
  let writes = 0;
  server.use(
    http.post(`${api}/repos/team/project/issues`, () => {
      writes++;
      return new HttpResponse(null, { status: 502, headers: { 'retry-after': '90' } });
    }),
  );
  const options = { action: 'create' as const, repository, title: 'Title', body: 'Body' };
  await expect(providers.writeIssue(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_WRITE_UNCERTAIN',
    retryAt: start + 90000,
  });
  await expect(providers.writeIssue(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_RATE_LIMIT',
    retryAt: start + 90000,
  });
  expect(writes).toBe(1);
});

test('very large server delays stay finite without being shortened to a polling interval', async () => {
  const { providers, account, api } = await setup('long-delay');
  server.use(
    http.get(
      `${api}/repos/team/project/issues/1`,
      () =>
        new HttpResponse(null, {
          status: 429,
          headers: { 'retry-after': '9'.repeat(80), 'x-poll-interval': '9'.repeat(80) },
        }),
    ),
  );
  await expect(providers.issue(account.id, { repository, number: 1 })).rejects.toMatchObject({
    retryAt: 8640000000000000,
  });
  expect(await providers.pollingPolicy(account.id)).toEqual({
    minimumIntervalMs: 8640000000000000,
    blockedUntil: 8640000000000000,
  });
});

test('heavy credential rotation cannot discard active server delay constraints', async () => {
  const { providers, account, api } = await setup('policy-capacity');
  server.use(
    http.get(`${api}/user`, () =>
      HttpResponse.json({ id: 321, login: 'reader' }, { headers: { 'x-poll-interval': '1' } }),
    ),
    http.get(
      `${api}/repos/team/project/issues/1`,
      () => new HttpResponse(null, { status: 429, headers: { 'retry-after': '90' } }),
    ),
  );
  await expect(providers.issue(account.id, { repository, number: 1 })).rejects.toMatchObject({
    retryAt: start + 90000,
  });
  for (let i = 0; i < 256; i++)
    await providers.connect({
      provider: 'github',
      origin: 'https://github.com',
      token: `rotated-${i}`,
    });
  expect(await providers.pollingPolicy(account.id)).toEqual({
    minimumIntervalMs: 1000,
    blockedUntil: start + 90000,
  });
});
