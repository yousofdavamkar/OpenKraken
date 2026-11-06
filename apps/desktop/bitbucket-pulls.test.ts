import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { providerServer } from '../../tests/provider-server.js';
import { protection } from '../../tests/provider-protection.js';
import {
  bitbucketPullFixture,
  bitbucketRepositoryFixture,
  bitbucketUserFixture,
} from '../../tests/bitbucket-fixtures.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';
import { resultSchema } from '@openkraken/ipc-contract';

const root = await mkdtemp(join(tmpdir(), 'openkraken-bitbucket-pulls-'));
const server = providerServer();
const repository = { owner: 'team', name: 'project' };
const api = 'https://api.bitbucket.org/2.0';
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
async function setup(name: string) {
  const directory = join(root, name);
  const service = new ProviderService(directory, new ProviderVault(directory, protection()));
  server.use(
    http.get(`${api}/user`, () => HttpResponse.json(bitbucketUserFixture)),
    http.get(`${api}/repositories/team/project`, () =>
      HttpResponse.json(bitbucketRepositoryFixture),
    ),
  );
  const account = (
    await service.connect({
      provider: 'bitbucket',
      origin: 'https://bitbucket.org',
      token: 'pull-secret',
    })
  ).accounts[0]!;
  return { service, account };
}

test('Bitbucket lists repository-bound pull requests with native state filters, local page bounds and canonical URLs', async () => {
  const { service, account } = await setup('list');
  const states: string[][] = [];
  server.use(
    http.get(`${api}/repositories/team/project/pullrequests`, ({ request }) => {
      const url = new URL(request.url);
      expect(request.headers.get('authorization')).toBe('Bearer pull-secret');
      expect(url.searchParams.get('pagelen')).toBe('100');
      expect(url.searchParams.get('sort')).toBe('-created_on');
      states.push(url.searchParams.getAll('state'));
      const page = Number(url.searchParams.get('page'));
      return HttpResponse.json({
        page,
        values: [{ ...bitbucketPullFixture(page), state: states.at(-1)![0] }],
        next: `${api}/repositories/team/project/pullrequests?page=${page + 1}`,
      });
    }),
  );
  const first = await service.pullRequests(account.id, { repository, state: 'open', page: 1 });
  expect(first).toEqual({
    pullRequests: [
      {
        number: 1,
        title: 'Pull 1',
        author: 'Fixture Person',
        state: 'open',
        draft: false,
        createdAt: '2026-10-01T12:00:00+00:00',
        updatedAt: '2026-10-02T12:00:00+00:00',
        mergedAt: null,
        url: 'https://bitbucket.org/team/project/pull-requests/1',
      },
    ],
    nextPage: 2,
    limited: false,
  });
  for (const state of ['merged', 'declined', 'superseded', 'all'] as const) {
    const result = await service.pullRequests(account.id, { repository, state, page: 100 });
    expect(result).toMatchObject({ nextPage: null, limited: true });
    expect(result.pullRequests[0]!.state).toBe(state === 'all' ? 'open' : state);
    expect(result.pullRequests[0]!.mergedAt).toBeNull();
  }
  expect(states).toEqual([
    ['OPEN'],
    ['MERGED'],
    ['DECLINED'],
    ['SUPERSEDED'],
    ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'],
  ]);
  await expect(
    service.pullRequests(account.id, { repository, state: 'closed', page: 1 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
});

test('Bitbucket details preserve fork and deleted-source context, abbreviated commits and native participant metadata', async () => {
  const { service, account } = await setup('detail');
  let deleted = false;
  server.use(
    http.get(`${api}/repositories/team/project/pullrequests/7`, () =>
      HttpResponse.json({
        ...bitbucketPullFixture(7),
        state: 'MERGED',
        merge_commit: { hash: 'abcdef1' },
        queued: true,
        ...(deleted
          ? {
              source: { repository: null, branch: null, commit: null },
              author: null,
              reviewers: undefined,
              participants: undefined,
            }
          : {}),
      }),
    ),
  );
  const detail = await service.bitbucketPullRequest(account.id, { repository, number: 7 });
  expect(
    resultSchema.safeParse({ kind: 'providerBitbucketPullRequest', pullRequest: detail }).success,
  ).toBe(true);
  expect(
    resultSchema.safeParse({
      kind: 'providerBitbucketPullRequest',
      pullRequest: { ...detail, token: 'secret' },
    }).success,
  ).toBe(false);
  expect(detail).toMatchObject({
    provider: 'bitbucket',
    repositoryId: bitbucketRepositoryFixture.uuid,
    number: 7,
    state: 'merged',
    mergedAt: null,
    body: 'Literal <script>description</script>',
    queued: true,
    mergeCommit: 'abcdef1',
    closeSourceBranch: true,
    comments: 5,
    openTasks: 2,
    source: {
      repository: {
        id: '{20000000-0000-4000-8000-000000000002}',
        owner: 'contributor',
        name: 'fork',
      },
      branch: 'feature',
      commit: '1'.repeat(40),
    },
    destination: {
      repository: { id: bitbucketRepositoryFixture.uuid, owner: 'team', name: 'project' },
      branch: 'main',
      commit: '2'.repeat(40),
    },
    reviewers: [{ id: bitbucketUserFixture.uuid, name: 'Fixture Person' }],
    participants: [
      {
        user: { id: bitbucketUserFixture.uuid, name: 'Fixture Person' },
        role: 'REVIEWER',
        approved: false,
        state: 'changes_requested',
        participatedAt: '2026-10-02T12:00:00+00:00',
      },
    ],
  });
  expect(detail).not.toHaveProperty('mergeable');
  expect(detail).not.toHaveProperty('changedFiles');
  deleted = true;
  expect(await service.bitbucketPullRequest(account.id, { repository, number: 7 })).toMatchObject({
    author: null,
    source: { repository: null, branch: null, commit: null },
    reviewers: null,
    participants: null,
  });
});

test('Bitbucket refuses foreign repositories and pull identities, malformed endpoints, duplicates and oversized people lists', async () => {
  const { service, account } = await setup('invalid');
  let value: unknown;
  const response = () =>
    new HttpResponse(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  server.use(
    http.get(`${api}/repositories/team/project/pullrequests/7`, response),
    http.get(`${api}/repositories/team/project/pullrequests`, response),
  );
  const fixture = bitbucketPullFixture(7);
  for (const invalid of [
    { ...fixture, id: 8 },
    {
      ...fixture,
      destination: {
        ...fixture.destination,
        repository: { ...bitbucketRepositoryFixture, uuid: bitbucketUserFixture.uuid },
      },
    },
    {
      ...fixture,
      destination: {
        ...fixture.destination,
        repository: { ...bitbucketRepositoryFixture, full_name: 'other/project' },
      },
    },
    {
      ...fixture,
      source: {
        ...fixture.source,
        repository: { ...fixture.source.repository, full_name: 'team/../evil' },
      },
    },
    { ...fixture, source: { ...fixture.source, commit: { hash: 'invalid' } } },
    { ...fixture, comment_count: -1 },
    { ...fixture, reviewers: [bitbucketUserFixture, bitbucketUserFixture] },
    { ...fixture, participants: [fixture.participants[0], fixture.participants[0]] },
    { ...fixture, reviewers: Array.from({ length: 1001 }, () => null) },
  ]) {
    value = invalid;
    await expect(
      service.bitbucketPullRequest(account.id, { repository, number: 7 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  }
  for (const invalid of [
    { values: [fixture, fixture] },
    { values: [{ ...fixture, state: 'DECLINED' }] },
    { values: Array.from({ length: 101 }, () => fixture) },
    { values: [fixture], next: 'https://attacker.test/steal?page=2' },
  ]) {
    value = invalid;
    await expect(
      service.pullRequests(account.id, { repository, state: 'open', page: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  }
  server.use(
    http.get(`${api}/repositories/team/project`, () =>
      HttpResponse.json({ ...bitbucketRepositoryFixture, full_name: 'other/project' }),
    ),
  );
  await expect(
    service.bitbucketPullRequest(account.id, { repository, number: 7 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
});

test('Bitbucket detail reads cancel at the HTTP boundary, sanitize errors and reject unsupported provider routes', async () => {
  const { service, account } = await setup('cancel');
  let dispatched!: () => void;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  server.use(
    http.get(`${api}/repositories/team/project/pullrequests/7`, async ({ request }) => {
      dispatched();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return HttpResponse.json(bitbucketPullFixture(7));
    }),
  );
  const controller = new AbortController();
  const pending = expect(
    service.bitbucketPullRequest(account.id, { repository, number: 7 }, controller.signal),
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  await started;
  controller.abort();
  await pending;
  server.use(
    http.get(`${api}/repositories/team/project/pullrequests/7`, () =>
      HttpResponse.json({ error: { message: 'pull-secret' } }, { status: 403 }),
    ),
  );
  await expect(
    service.bitbucketPullRequest(account.id, { repository, number: 7 }),
  ).rejects.toMatchObject({
    code: 'PROVIDER_AUTH',
    message: expect.not.stringContaining('pull-secret'),
  });
  await expect(service.pullRequest(account.id, { repository, number: 7 })).rejects.toMatchObject({
    code: 'PROVIDER_UNSUPPORTED',
  });
  await expect(service.mergeRequest(account.id, { repository, number: 7 })).rejects.toMatchObject({
    code: 'PROVIDER_UNSUPPORTED',
  });
  await expect(
    service.pullRequests(account.id, {
      repository: { owner: 'team/sub', name: 'project' },
      state: 'open',
      page: 1,
    }),
  ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
});

test('GitHub and GitLab refuse Bitbucket-only state filters without dispatching collaboration requests', async () => {
  const { service } = await setup('provider-filters');
  server.use(
    http.get('https://api.github.com/user', () => HttpResponse.json({ id: 73, login: 'fixture' })),
    http.get('https://gitlab.com/api/v4/user', () =>
      HttpResponse.json({ id: 73, username: 'fixture' }),
    ),
  );
  for (const provider of ['github', 'gitlab'] as const) {
    const state = await service.connect({
      provider,
      origin: `https://${provider}.com`,
      token: 'fixture',
    });
    const account = state.accounts.find((account) => account.provider === provider)!;
    for (const filter of ['declined', 'superseded'] as const)
      await expect(
        service.pullRequests(account.id, { repository, state: filter, page: 1 }),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
    await expect(
      service.bitbucketPullRequest(account.id, { repository, number: 7 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
  }
});

test('GitHub response metadata rejects native states belonging to other providers', async () => {
  const { service } = await setup('github-state-response');
  server.use(
    http.get('https://api.github.com/user', () => HttpResponse.json({ id: 73, login: 'fixture' })),
  );
  const account = (
    await service.connect({ provider: 'github', origin: 'https://github.com', token: 'fixture' })
  ).accounts.find((account) => account.provider === 'github')!;
  for (const state of ['declined', 'superseded', 'merged', 'locked']) {
    server.use(
      http.get('https://api.github.com/repos/team/project/pulls', () =>
        HttpResponse.json([
          {
            number: 7,
            title: 'Wrong state',
            user: { login: 'fixture' },
            draft: false,
            state,
            created_at: '2026-10-01T12:00:00Z',
            updated_at: '2026-10-02T12:00:00Z',
            merged_at: null,
          },
        ]),
      ),
    );
    await expect(
      service.pullRequests(account.id, { repository, state: 'open', page: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  }
});
