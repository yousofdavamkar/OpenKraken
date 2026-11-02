import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';
import { protection } from '../../tests/provider-protection.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-pr-checks-'));
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});
const head = '1'.repeat(40);
const options = { repository: { owner: 'team', name: 'project' }, number: 1, head, after: null };
const check = {
  __typename: 'CheckRun',
  id: 'check-1',
  name: 'Tests',
  status: 'COMPLETED',
  conclusion: 'FAILURE',
};
const status = {
  __typename: 'StatusContext',
  id: 'status-1',
  context: 'deploy',
  state: 'PENDING',
  description: 'Waiting for deployment',
};
function response(nodes: unknown[] = [check, status], after: string | null = null) {
  return {
    data: {
      repository: {
        pullRequest: {
          headRefOid: head,
          commits: {
            nodes: [
              {
                commit: {
                  oid: head,
                  statusCheckRollup: {
                    state: 'FAILURE',
                    contexts: {
                      totalCount: 3,
                      nodes,
                      pageInfo: { hasNextPage: after !== null, endCursor: after },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  };
}
async function setup(name: string, origin = 'https://github.com') {
  const directory = join(root, name),
    api = origin === 'https://github.com' ? 'https://api.github.com' : `${origin}/api/v3`;
  server.use(http.get(`${api}/user`, () => HttpResponse.json({ id: 321, login: 'reviewer' })));
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  const account = (await providers.connect({ provider: 'github', origin, token: 'checks-secret' }))
    .accounts[0]!;
  return {
    providers,
    account,
    endpoint:
      origin === 'https://github.com' ? 'https://api.github.com/graphql' : `${origin}/api/graphql`,
  };
}
test('PR checks combine check runs and legacy statuses, pin the displayed head and page on GitHub Enterprise', async () => {
  const { providers, account, endpoint } = await setup('pages', 'https://git.example.test');
  const bodies: unknown[] = [];
  server.use(
    http.post(endpoint, async ({ request }) => {
      expect(request.headers.get('authorization')).toBe('token checks-secret');
      const body = (await request.json()) as { query: string; variables: { after: string | null } };
      bodies.push(body.variables);
      expect(body.query).toContain('statusCheckRollup');
      return HttpResponse.json(
        body.variables.after
          ? response([{ ...check, id: 'check-2', name: 'Build', conclusion: 'SUCCESS' }])
          : response(undefined, 'next-cursor'),
      );
    }),
  );
  expect(await providers.pullChecks(account.id, options)).toEqual({
    head,
    state: 'FAILURE',
    total: 3,
    nextCursor: 'next-cursor',
    checks: [
      {
        id: 'check-1',
        kind: 'check',
        name: 'Tests',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        description: '',
      },
      {
        id: 'status-1',
        kind: 'status',
        name: 'deploy',
        status: 'PENDING',
        conclusion: null,
        description: 'Waiting for deployment',
      },
    ],
  });
  expect(
    (await providers.pullChecks(account.id, { ...options, after: 'next-cursor' })).checks[0]?.name,
  ).toBe('Build');
  expect(bodies).toEqual([
    { owner: 'team', name: 'project', number: 1, after: null },
    { owner: 'team', name: 'project', number: 1, after: 'next-cursor' },
  ]);
});

test.each(['https://github.com', 'https://git.example.test'])(
  'absent rollups on %s are unknown, never success',
  async (origin) => {
    const { providers, account, endpoint } = await setup(`empty-${new URL(origin).host}`, origin);
    const value = response();
    server.use(
      http.post(endpoint, () =>
        HttpResponse.json({
          data: {
            repository: {
              pullRequest: {
                ...value.data.repository.pullRequest,
                commits: { nodes: [{ commit: { oid: head, statusCheckRollup: null } }] },
              },
            },
          },
        }),
      ),
    );
    expect(await providers.pullChecks(account.id, options)).toEqual({
      head,
      state: null,
      total: 0,
      checks: [],
      nextCursor: null,
    });
  },
);

test.each(['head', 'commit'])(
  'checks refuse a changed %s even if old checks pass',
  async (mode) => {
    const { providers, account, endpoint } = await setup(`stale-${mode}`);
    const value = response();
    if (mode === 'head') value.data.repository.pullRequest.headRefOid = '9'.repeat(40);
    else value.data.repository.pullRequest.commits.nodes[0]!.commit.oid = '9'.repeat(40);
    server.use(http.post(endpoint, () => HttpResponse.json(value)));
    await expect(providers.pullChecks(account.id, options)).rejects.toMatchObject({
      code: 'STALE_PROVIDER_PULL',
    });
  },
);

test.each([
  'partial',
  'missing',
  'null-node',
  'unknown',
  'oversize',
  'cursor',
  'empty-page',
  'total',
  'bad-count',
])('checks reject %s GraphQL data without leaking error text', async (mode) => {
  const { providers, account, endpoint } = await setup(`invalid-${mode}`);
  const value = response();
  const contexts =
    value.data.repository.pullRequest.commits.nodes[0]!.commit.statusCheckRollup.contexts;
  let body: unknown = value;
  if (mode === 'partial') body = { ...value, errors: [{ message: 'checks-secret' }] };
  if (mode === 'missing')
    body = { data: { repository: null }, errors: [{ message: 'checks-secret' }] };
  if (mode === 'null-node') contexts.nodes = [null];
  if (mode === 'unknown') contexts.nodes = [{ ...check, conclusion: 'NEW_STATE' }];
  if (mode === 'oversize') contexts.nodes = [{ ...check, name: 'x'.repeat(1025) }];
  if (mode === 'cursor') contexts.pageInfo = { hasNextPage: true, endCursor: null };
  if (mode === 'empty-page') {
    contexts.nodes = [];
    contexts.pageInfo = { hasNextPage: true, endCursor: 'next' };
  }
  if (mode === 'total') contexts.totalCount = 1;
  if (mode === 'bad-count') contexts.totalCount = -1;
  server.use(
    http.post(
      endpoint,
      () =>
        new HttpResponse(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    ),
  );
  await expect(providers.pullChecks(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_CHECKS_RESPONSE',
  });
  await expect(providers.pullChecks(account.id, options)).rejects.not.toThrow('checks-secret');
});

test('checks refuse a repeated cursor and oversized pages', async () => {
  const { providers, account, endpoint } = await setup('pagination');
  server.use(http.post(endpoint, () => HttpResponse.json(response(undefined, 'same'))));
  await expect(
    providers.pullChecks(account.id, { ...options, after: 'same' }),
  ).rejects.toMatchObject({ code: 'PROVIDER_CHECKS_RESPONSE' });
  server.use(
    http.post(endpoint, () =>
      HttpResponse.json(response(Array.from({ length: 101 }, () => check))),
    ),
  );
  await expect(providers.pullChecks(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_CHECKS_RESPONSE',
  });
});

test('check requests retain transport cancellation, host and response-size limits', async () => {
  const { providers, account, endpoint } = await setup('transport');
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  server.use(
    http.post(endpoint, async ({ request }) => {
      started();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return HttpResponse.json(response());
    }),
  );
  const controller = new AbortController();
  const pending = providers.pullChecks(account.id, options, controller.signal);
  await began;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  server.use(
    http.post(
      endpoint,
      () =>
        new HttpResponse(null, {
          status: 302,
          headers: { location: 'https://elsewhere.test/graphql' },
        }),
    ),
  );
  await expect(providers.pullChecks(account.id, options)).rejects.toThrow();
  server.use(http.post(endpoint, () => new HttpResponse('x'.repeat(4 * 1024 * 1024 + 1))));
  await expect(providers.pullChecks(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_REQUEST',
  });
  server.use(
    http.post(endpoint, () => HttpResponse.json({ message: 'checks-secret' }, { status: 403 })),
  );
  await expect(providers.pullChecks(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_FORBIDDEN',
  });
});
