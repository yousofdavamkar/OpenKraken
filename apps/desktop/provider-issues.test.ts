import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';
import { githubIssueFixture as issue } from '../../packages/test-fixtures/src/provider.js';
import { protection } from '../../tests/provider-protection.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-issues-'));
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});
const repository = { owner: 'team', name: 'project' };
async function setup(name: string, origin = 'https://github.com') {
  const directory = join(root, name),
    api = origin === 'https://github.com' ? 'https://api.github.com' : `${origin}/api/v3`;
  server.use(http.get(`${api}/user`, () => HttpResponse.json({ id: 321, login: 'reader' })));
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  const account = (await providers.connect({ provider: 'github', origin, token: 'issues-secret' }))
    .accounts[0]!;
  return { providers, account, api };
}
test('repository issue pages exclude PRs without losing subsequent pages and normalize metadata on Enterprise', async () => {
  const { providers, account, api } = await setup('pages', 'https://git.example.test');
  server.use(
    http.get(`${api}/repos/team/project/issues`, ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get('state')).toBe('all');
      expect(url.searchParams.get('per_page')).toBe('100');
      expect(url.searchParams.get('sort')).toBe('created');
      expect(url.searchParams.get('direction')).toBe('desc');
      expect(request.headers.get('authorization')).toBe('token issues-secret');
      return HttpResponse.json(
        url.searchParams.get('page') === '1'
          ? Array.from({ length: 100 }, (_, i) => ({ ...issue(i + 1), pull_request: {} }))
          : [issue(101)],
      );
    }),
  );
  expect(await providers.issues(account.id, { repository, state: 'all', page: 1 })).toEqual({
    issues: [],
    nextPage: 2,
    limited: false,
  });
  expect(await providers.issues(account.id, { repository, state: 'all', page: 2 })).toEqual({
    issues: [
      {
        number: 101,
        title: 'A bug to fix',
        state: 'open',
        stateReason: null,
        author: 'author',
        labels: ['bug', 'help wanted'],
        assignees: ['maintainer'],
        milestone: 'Next release',
        locked: false,
        comments: 1,
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z',
        closedAt: null,
        url: 'https://git.example.test/team/project/issues/101',
      },
    ],
    nextPage: null,
    limited: false,
  });
});

test('issue details and comment pages preserve closed state, deleted authors and literal text', async () => {
  const { providers, account, api } = await setup('details');
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, () =>
      HttpResponse.json({
        ...issue(),
        user: null,
        state: 'closed',
        state_reason: 'completed',
        closed_at: '2026-10-03T00:00:00Z',
        body: '<script>literal</script>',
      }),
    ),
    http.get(`${api}/repos/team/project/issues/1/comments`, ({ request }) => {
      expect(new URL(request.url).searchParams.get('page')).toBe('2');
      return HttpResponse.json([
        {
          id: 10,
          user: null,
          body: '<img src=x> literal comment',
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-02T00:00:00Z',
          issue_url: `${api}/repos/team/project/issues/1`,
        },
      ]);
    }),
  );
  expect(await providers.issue(account.id, { repository, number: 1 })).toMatchObject({
    author: null,
    state: 'closed',
    stateReason: 'completed',
    body: '<script>literal</script>',
    url: 'https://github.com/team/project/issues/1',
  });
  expect(await providers.issueComments(account.id, { repository, number: 1, page: 2 })).toEqual({
    comments: [
      {
        id: '10',
        author: null,
        body: '<img src=x> literal comment',
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z',
      },
    ],
    nextPage: null,
    limited: false,
  });
});

test('issue pages enforce raw-page bounds and explicitly signal the final browsing page', async () => {
  const { providers, account, api } = await setup('bounds');
  server.use(
    http.get(`${api}/repos/team/project/issues`, () =>
      HttpResponse.json(Array.from({ length: 100 }, (_, i) => issue(i + 1))),
    ),
  );
  expect(
    await providers.issues(account.id, { repository, state: 'open', page: 100 }),
  ).toMatchObject({ nextPage: null, limited: true });
  server.use(
    http.get(`${api}/repos/team/project/issues`, () =>
      HttpResponse.json(Array.from({ length: 101 }, (_, i) => issue(i + 1))),
    ),
  );
  await expect(
    providers.issues(account.id, { repository, state: 'open', page: 1 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
});
test.each([
  { title: '' },
  { number: -1 },
  { state: 'unknown' },
  { labels: [null] },
  { assignees: [{ login: '' }] },
  { comments: -1 },
  { created_at: 'bad-date' },
  { locked: undefined },
  { labels: Array.from({ length: 101 }, () => 'bug') },
  { milestone: { title: 'x'.repeat(256) } },
])('issue pages reject malformed metadata %j', async (extra) => {
  const { providers, account, api } = await setup(`invalid-${crypto.randomUUID()}`);
  server.use(
    http.get(`${api}/repos/team/project/issues`, () =>
      HttpResponse.json([{ ...issue(), ...extra }]),
    ),
  );
  await expect(
    providers.issues(account.id, { repository, state: 'open', page: 1 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
});
test.each(['pull', 'wrong-number', 'body-size'])(
  'issue details refuse %s and comments cannot bypass that check',
  async (mode) => {
    const { providers, account, api } = await setup(`details-${mode}`);
    let comments = 0;
    server.use(
      http.get(`${api}/repos/team/project/issues/1`, () =>
        HttpResponse.json({
          ...issue(),
          ...(mode === 'pull'
            ? { pull_request: {} }
            : mode === 'wrong-number'
              ? { number: 2 }
              : { body: 'x'.repeat(262145) }),
        }),
      ),
      http.get(`${api}/repos/team/project/issues/1/comments`, () => {
        comments++;
        return HttpResponse.json([]);
      }),
    );
    const code = mode === 'pull' ? 'PROVIDER_ISSUE_IS_PULL' : 'PROVIDER_RESPONSE';
    await expect(providers.issue(account.id, { repository, number: 1 })).rejects.toMatchObject({
      code,
    });
    await expect(
      providers.issueComments(account.id, { repository, number: 1, page: 1 }),
    ).rejects.toMatchObject({ code });
    expect(comments).toBe(0);
  },
);
test('comment pages enforce selected-issue ownership, bounds and pagination', async () => {
  const { providers, account, api } = await setup('comments', 'https://git.example.test');
  const comment = {
    id: 10,
    user: null,
    body: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    issue_url: `${api}/repos/team/project/issues/1`,
  };
  server.use(http.get(`${api}/repos/team/project/issues/1`, () => HttpResponse.json(issue())));
  server.use(
    http.get(`${api}/repos/team/project/issues/1/comments`, () =>
      HttpResponse.json(Array.from({ length: 100 }, (_, i) => ({ ...comment, id: i + 1 }))),
    ),
  );
  expect(
    await providers.issueComments(account.id, { repository, number: 1, page: 1 }),
  ).toMatchObject({ nextPage: 2, limited: false });
  expect(
    await providers.issueComments(account.id, { repository, number: 1, page: 100 }),
  ).toMatchObject({ nextPage: null, limited: true });
  for (const extra of [
    { issue_url: `${api}/repos/team/other/issues/1` },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { body: 'x'.repeat(262145) },
    { user: { login: '' } },
    { updated_at: 'bad' },
  ]) {
    server.use(
      http.get(`${api}/repos/team/project/issues/1/comments`, () =>
        HttpResponse.json([{ ...comment, ...extra }]),
      ),
    );
    await expect(
      providers.issueComments(account.id, { repository, number: 1, page: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  }
});
test('issue request cancellation stops obsolete reads and provider errors are sanitized', async () => {
  const { providers, account, api } = await setup('cancel');
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  server.use(
    http.get(`${api}/repos/team/project/issues`, async ({ request }) => {
      started();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return HttpResponse.json([]);
    }),
  );
  const controller = new AbortController();
  const pending = providers.issues(
    account.id,
    { repository, state: 'open', page: 1 },
    controller.signal,
  );
  await began;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, () =>
      HttpResponse.json({ message: 'issues-secret' }, { status: 403 }),
    ),
  );
  await expect(providers.issue(account.id, { repository, number: 1 })).rejects.toMatchObject({
    code: 'PROVIDER_FORBIDDEN',
  });
  await expect(providers.issue(account.id, { repository, number: 1 })).rejects.not.toThrow(
    'issues-secret',
  );
});
