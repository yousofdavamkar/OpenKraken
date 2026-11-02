import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';
import {
  githubIssueFixture as issue,
  githubPullFixture,
  githubCommentFixture,
} from '../../packages/test-fixtures/src/provider.js';
import { protection } from '../../tests/provider-protection.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-provider-cache-'));
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
});
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});
const repository = { owner: 'team', name: 'project' };
async function setup(name: string, origin = 'https://github.com') {
  const directory = join(root, name);
  const api = origin === 'https://github.com' ? 'https://api.github.com' : `${origin}/api/v3`;
  server.use(http.get(`${api}/user`, () => HttpResponse.json({ id: 321, login: 'reader' })));
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  const account = (await providers.connect({ provider: 'github', origin, token: 'cache-secret' }))
    .accounts[0]!;
  return { providers, account, api };
}

test('unchanged issue reads revalidate their ETag and changed responses replace cached content', async () => {
  const { providers, account, api } = await setup('revalidate');
  const validators: (string | null)[] = [];
  let changed = false;
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, ({ request }) => {
      const validator = request.headers.get('if-none-match');
      validators.push(validator);
      const etag = changed ? 'W/"second"' : '"first"';
      return validator === etag
        ? new HttpResponse(null, { status: 304 })
        : HttpResponse.json(
            { ...issue(), title: changed ? 'Updated issue' : 'Original issue' },
            { headers: { etag } },
          );
    }),
  );
  const read = () => providers.issue(account.id, { repository, number: 1 });
  expect((await read()).title).toBe('Original issue');
  expect((await read()).title).toBe('Original issue');
  changed = true;
  expect((await read()).title).toBe('Updated issue');
  expect((await read()).title).toBe('Updated issue');
  expect(validators).toEqual([null, '"first"', '"first"', 'W/"second"']);
});

test.each([
  ['cache-control', 'private, no-store'],
  ['vary', '*'],
])('responses forbidding storage are never revalidated from memory: %j', async (header, value) => {
  const { providers, account, api } = await setup(`no-store-${header}`);
  const validators: (string | null)[] = [];
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, ({ request }) => {
      validators.push(request.headers.get('if-none-match'));
      return HttpResponse.json(issue(), { headers: { etag: '"private"', [header]: value } });
    }),
  );
  await providers.issue(account.id, { repository, number: 1 });
  await providers.issue(account.id, { repository, number: 1 });
  expect(validators).toEqual([null, null]);
});

test('access failures never serve cached content and remove previously readable data', async () => {
  const { providers, account, api } = await setup('revoked');
  let status = 200;
  const validators: (string | null)[] = [];
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, ({ request }) => {
      validators.push(request.headers.get('if-none-match'));
      return status === 200
        ? HttpResponse.json(issue(), { headers: { etag: '"private"' } })
        : new HttpResponse(null, { status });
    }),
  );
  await providers.issue(account.id, { repository, number: 1 });
  status = 403;
  await expect(providers.issue(account.id, { repository, number: 1 })).rejects.toMatchObject({
    code: 'PROVIDER_FORBIDDEN',
  });
  status = 200;
  await providers.issue(account.id, { repository, number: 1 });
  expect(validators).toEqual([null, '"private"', null]);
});

test('even an uncertain issue write invalidates previous reads without retrying the write', async () => {
  const { providers, account, api } = await setup('write');
  const validators: (string | null)[] = [];
  let writes = 0;
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, ({ request }) => {
      validators.push(request.headers.get('if-none-match'));
      return HttpResponse.json(issue(), { headers: { etag: '"before-write"' } });
    }),
    http.post(`${api}/repos/team/project/issues`, ({ request }) => {
      expect(request.headers.get('if-none-match')).toBeNull();
      writes++;
      return new HttpResponse(null, { status: 502 });
    }),
  );
  await providers.issue(account.id, { repository, number: 1 });
  await expect(
    providers.writeIssue(account.id, {
      action: 'create',
      repository,
      title: 'New issue',
      body: 'Description',
    }),
  ).rejects.toMatchObject({ code: 'PROVIDER_WRITE_UNCERTAIN' });
  await providers.issue(account.id, { repository, number: 1 });
  expect(validators).toEqual([null, null]);
  expect(writes).toBe(1);
});

test('read-only GraphQL checks always reach the server without discarding REST validators', async () => {
  const { providers, account, api } = await setup('graphql');
  const validators: (string | null)[] = [];
  const head = '1'.repeat(40);
  let requests = 0;
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, ({ request }) => {
      validators.push(request.headers.get('if-none-match'));
      return HttpResponse.json(issue(), { headers: { etag: '"issue"' } });
    }),
    http.post(`${api}/graphql`, ({ request }) => {
      expect(request.headers.get('if-none-match')).toBeNull();
      requests++;
      return HttpResponse.json(
        {
          data: {
            repository: {
              pullRequest: {
                headRefOid: head,
                commits: { nodes: [{ commit: { oid: head, statusCheckRollup: null } }] },
              },
            },
          },
        },
        { headers: { etag: '"checks"' } },
      );
    }),
  );
  await providers.issue(account.id, { repository, number: 1 });
  for (let i = 0; i < 2; i++) {
    expect(
      await providers.pullChecks(account.id, { repository, number: 1, head, after: null }),
    ).toMatchObject({ checks: [], state: null });
  }
  await providers.issue(account.id, { repository, number: 1 });
  expect(validators).toEqual([null, '"issue"']);
  expect(requests).toBe(2);
});

test('private response bodies expire after five minutes even when repeatedly revalidated', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
  const { providers, account, api } = await setup('expiry');
  const validators: (string | null)[] = [];
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, ({ request }) => {
      const validator = request.headers.get('if-none-match');
      validators.push(validator);
      return validator
        ? new HttpResponse(null, { status: 304 })
        : HttpResponse.json(issue(), { headers: { etag: '"expiring"' } });
    }),
  );
  await providers.issue(account.id, { repository, number: 1 });
  vi.setSystemTime(new Date('2026-11-01T00:04:00Z'));
  await providers.issue(account.id, { repository, number: 1 });
  vi.setSystemTime(new Date('2026-11-01T00:05:00Z'));
  await providers.issue(account.id, { repository, number: 1 });
  expect(validators).toEqual([null, '"expiring"', null]);
});

test.each([
  { name: 'entry count', count: 257, padding: 0 },
  { name: 'total bytes', count: 5, padding: 3500000 },
])(
  'the provider cache evicts old responses when its $name limit is reached',
  async ({ name, count, padding }) => {
    const { providers, account, api } = await setup(`bound-${name}`);
    const validators: (string | null)[] = [];
    server.use(
      http.get(`${api}/repos/team/project/issues/:number`, ({ request, params }) => {
        const validator = request.headers.get('if-none-match');
        validators.push(validator);
        return validator
          ? new HttpResponse(null, { status: 304 })
          : HttpResponse.json(
              { ...issue(Number(params.number)), extra: 'x'.repeat(padding) },
              { headers: { etag: '"bounded"' } },
            );
      }),
    );
    for (let number = 1; number <= count; number++) {
      await providers.issue(account.id, { repository, number });
    }
    await providers.issue(account.id, { repository, number: count });
    await providers.issue(account.id, { repository, number: 1 });
    expect(validators.slice(-2)).toEqual(['"bounded"', null]);
  },
);

test.each(['replace credential', 'disconnect and reconnect'])(
  'connecting an account forgets earlier private responses: %s',
  async (action) => {
    const { providers, account, api } = await setup(`account-${action}`);
    const validators: (string | null)[] = [];
    server.use(
      http.get(`${api}/repos/team/project/issues/1`, ({ request }) => {
        validators.push(request.headers.get('if-none-match'));
        return HttpResponse.json(issue(), { headers: { etag: '"private"' } });
      }),
    );
    await providers.issue(account.id, { repository, number: 1 });
    if (action === 'disconnect and reconnect') await providers.disconnect(account.id);
    await providers.connect({
      provider: 'github',
      origin: 'https://github.com',
      token: 'cache-secret',
    });
    await providers.issue(account.id, { repository, number: 1 });
    expect(validators).toEqual([null, null]);
  },
);

test('validators stay isolated by account, Enterprise host, page and filter', async () => {
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
    await providers.connect({ provider: 'github', origin: enterprise, token: 'cache-secret' })
  ).accounts.find((item) => item.origin === enterprise)!;
  const validators: (string | null)[] = [];
  const response = ({ request }: { request: Request }) => {
    validators.push(request.headers.get('if-none-match'));
    return request.headers.has('if-none-match')
      ? new HttpResponse(null, { status: 304 })
      : HttpResponse.json([issue()], { headers: { etag: '"same-validator"' } });
  };
  server.use(
    http.get(`${api}/repos/team/project/issues`, response),
    http.get(`${enterprise}/api/v3/repos/team/project/issues`, response),
  );
  const options = { repository, state: 'open' as const, page: 1 };
  await providers.issues(account.id, options);
  await providers.issues(other.id, options);
  await providers.issues(hosted.id, options);
  await providers.issues(account.id, { ...options, page: 2 });
  await providers.issues(account.id, { ...options, state: 'closed' });
  await providers.issues(account.id, options);
  expect(validators).toEqual([null, null, null, null, null, '"same-validator"']);
});

test('a 304 without a stored response fails instead of manufacturing data', async () => {
  const { providers, account, api } = await setup('unsolicited-304');
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, () => new HttpResponse(null, { status: 304 })),
  );
  await expect(providers.issue(account.id, { repository, number: 1 })).rejects.toMatchObject({
    code: 'PROVIDER_REQUEST',
  });
});

test('a no-store revalidation drops its saved representation for the next request', async () => {
  const { providers, account, api } = await setup('304-no-store');
  const validators: (string | null)[] = [];
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, ({ request }) => {
      const validator = request.headers.get('if-none-match');
      validators.push(validator);
      return validator
        ? new HttpResponse(null, { status: 304, headers: { 'cache-control': 'no-store' } })
        : HttpResponse.json(issue(), { headers: { etag: '"one-use"' } });
    }),
  );
  for (let i = 0; i < 3; i++) await providers.issue(account.id, { repository, number: 1 });
  expect(validators).toEqual([null, '"one-use"', null]);
});

test('a fully loaded PR list and discussion can both revalidate their pages without cache thrashing', async () => {
  const { providers, account, api } = await setup('loaded-pages');
  let conditional = 0;
  const response = (request: globalThis.Request, comments: boolean) => {
    const page = Number(new URL(request.url).searchParams.get('page'));
    const etag = `"${comments ? 'comments' : 'pulls'}-${page}"`;
    if (request.headers.get('if-none-match') === etag) {
      conditional++;
      return new HttpResponse(null, { status: 304 });
    }
    return HttpResponse.json(
      Array.from({ length: 100 }, (_, i) =>
        comments
          ? githubCommentFixture((page - 1) * 100 + i + 1)
          : githubPullFixture((page - 1) * 100 + i + 1),
      ),
      { headers: { etag } },
    );
  };
  server.use(
    http.get(`${api}/repos/team/project/pulls`, ({ request }) => response(request, false)),
    http.get(`${api}/repos/team/project/pulls/1`, () => HttpResponse.json(githubPullFixture())),
    http.get(`${api}/repos/team/project/pulls/1/comments`, ({ request }) =>
      response(request, true),
    ),
  );
  for (let cycle = 0; cycle < 2; cycle++) {
    for (let page = 1; page <= 100; page++)
      await providers.pullRequests(account.id, { repository, state: 'open', page });
    for (let page = 1; page <= 100; page++)
      await providers.pullComments(account.id, { repository, number: 1, page });
  }
  expect(conditional).toBe(200);
});

test.each([
  ['etag', 'invalid'],
  ['etag', '"' + 'x'.repeat(1024) + '"'],
  ['content-type', 'application/json;' + 'x'.repeat(1024)],
])('invalid or oversized cache metadata is not retained: %s', async (header, value) => {
  const { providers, account, api } = await setup(`metadata-${header}-${value.length}`);
  const validators: (string | null)[] = [];
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, ({ request }) => {
      validators.push(request.headers.get('if-none-match'));
      return HttpResponse.json(issue(), { headers: { etag: '"valid"', [header]: value } });
    }),
  );
  await providers.issue(account.id, { repository, number: 1 });
  await providers.issue(account.id, { repository, number: 1 });
  expect(validators).toEqual([null, null]);
});

test.each([429, 502])(
  'a failed revalidation reports HTTP %s without stale fallback',
  async (status) => {
    const { providers, account, api } = await setup(`error-${status}`);
    server.use(
      http.get(`${api}/repos/team/project/issues/1`, () =>
        HttpResponse.json(issue(), { headers: { etag: '"old"' } }),
      ),
    );
    await providers.issue(account.id, { repository, number: 1 });
    server.use(
      http.get(`${api}/repos/team/project/issues/1`, ({ request }) => {
        expect(request.headers.get('if-none-match')).toBe('"old"');
        return new HttpResponse(null, { status });
      }),
    );
    await expect(providers.issue(account.id, { repository, number: 1 })).rejects.toMatchObject({
      code: status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_REQUEST',
    });
  },
);
