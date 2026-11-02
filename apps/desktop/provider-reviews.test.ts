import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';
import { protection } from '../../tests/provider-protection.js';
import { githubPullFixture } from '../../packages/test-fixtures/src/provider.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-pr-review-'));
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});
const repository = { owner: 'team', name: 'project' };
const revision = { head: '1'.repeat(40), base: '2'.repeat(40) };
async function setup(name: string, origin = 'https://github.com') {
  const directory = join(root, name),
    api = origin === 'https://github.com' ? 'https://api.github.com' : `${origin}/api/v3`;
  server.use(http.get(`${api}/user`, () => HttpResponse.json({ id: 321, login: 'reviewer' })));
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  const account = (await providers.connect({ provider: 'github', origin, token: 'review-secret' }))
    .accounts[0]!;
  return { providers, account, api };
}
test('PR file pages are revision-checked and keep renamed, binary and bounded patch metadata', async () => {
  const { providers, account, api } = await setup('files');
  let changed = false;
  server.use(
    http.get(`${api}/repos/team/project/pulls/1`, () =>
      HttpResponse.json({
        ...githubPullFixture(),
        head: { ...githubPullFixture().head, sha: changed ? '3'.repeat(40) : revision.head },
      }),
    ),
    http.get(`${api}/repos/team/project/pulls/1/files`, ({ request }) => {
      expect(new URL(request.url).searchParams.get('per_page')).toBe('100');
      expect(request.headers.get('authorization')).toBe('token review-secret');
      return HttpResponse.json([
        {
          filename: 'new.txt',
          previous_filename: 'old.txt',
          status: 'renamed',
          additions: 1,
          deletions: 1,
          changes: 2,
          sha: '4'.repeat(40),
          patch: '@@ -1 +1 @@\n-old\n+new',
          raw_url: 'https://attacker.test',
        },
        {
          filename: 'image.png',
          status: 'added',
          additions: 0,
          deletions: 0,
          changes: 0,
          sha: '5'.repeat(40),
        },
        {
          filename: 'large.txt',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          sha: '6'.repeat(40),
          patch: '+'.repeat(262145),
        },
      ]);
    }),
  );
  const options = { repository, number: 1, revision, page: 1 };
  const page = await providers.pullFiles(account.id, options);
  expect(page.files[0]).toMatchObject({
    path: 'new.txt',
    previousPath: 'old.txt',
    patch: '@@ -1 +1 @@\n-old\n+new',
    patchTruncated: false,
  });
  expect(page.files[1]!.patch).toBeNull();
  expect(page.files[2]!.patch).toHaveLength(262144);
  expect(page.files[2]!.patchTruncated).toBe(true);
  expect(page).toMatchObject({ nextPage: null, limited: false });
  expect(JSON.stringify(page)).not.toContain('attacker.test');
  server.use(
    http.get(`${api}/repos/team/project/pulls/1/files`, () => {
      changed = true;
      return HttpResponse.json([]);
    }),
  );
  await expect(providers.pullFiles(account.id, options)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_PULL',
  });
});

test('PR reviews page through Enterprise and submissions bind the reviewed head after checking current state', async () => {
  const { providers, account, api } = await setup('submit', 'https://git.example.test');
  let current = githubPullFixture();
  const posted: unknown[] = [];
  const review = {
    id: 45,
    user: { login: 'reviewer' },
    state: 'APPROVED',
    body: 'Looks good',
    submitted_at: '2026-10-03T00:00:00Z',
    commit_id: revision.head,
    html_url: 'https://attacker.test',
  };
  server.use(
    http.get(`${api}/repos/team/project/pulls/1`, () => HttpResponse.json(current)),
    http.get(`${api}/repos/team/project/pulls/1/reviews`, ({ request }) => {
      expect(request.headers.get('x-github-api-version')).toBe('2022-11-28');
      expect(new URL(request.url).searchParams.get('per_page')).toBe('100');
      return HttpResponse.json([
        review,
        { ...review, id: 46, user: null, state: 'PENDING', submitted_at: null, commit_id: null },
      ]);
    }),
    http.post(`${api}/repos/team/project/pulls/1/reviews`, async ({ request }) => {
      const body = (await request.json()) as { event: string; body: string; commit_id: string };
      posted.push(body);
      return HttpResponse.json({
        ...review,
        body: body.body,
        state:
          body.event === 'APPROVE'
            ? 'APPROVED'
            : body.event === 'COMMENT'
              ? 'COMMENTED'
              : 'CHANGES_REQUESTED',
      });
    }),
  );
  const page = await providers.pullReviews(account.id, { repository, number: 1, page: 1 });
  expect(page).toMatchObject({
    nextPage: null,
    limited: false,
    reviews: [
      { id: '45', state: 'APPROVED' },
      { id: '46', author: null, submittedAt: null, commitId: null },
    ],
  });
  expect(JSON.stringify(page)).not.toContain('attacker.test');
  for (const event of ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] as const) {
    const result = await providers.submitReview(account.id, {
      repository,
      number: 1,
      revision,
      event,
      body: 'Reviewed text',
    });
    expect(result.commitId).toBe(revision.head);
    expect(posted.at(-1)).toEqual({ event, body: 'Reviewed text', commit_id: revision.head });
  }
  current = { ...current, head: { ...current.head, sha: '9'.repeat(40) } };
  await expect(
    providers.submitReview(account.id, {
      repository,
      number: 1,
      revision,
      event: 'APPROVE',
      body: '',
    }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_PULL' });
  current = { ...githubPullFixture(), state: 'closed' };
  await expect(
    providers.submitReview(account.id, {
      repository,
      number: 1,
      revision,
      event: 'APPROVE',
      body: '',
    }),
  ).rejects.toMatchObject({ code: 'PROVIDER_PULL_CLOSED' });
  current = { ...githubPullFixture(), draft: true };
  await expect(
    providers.submitReview(account.id, {
      repository,
      number: 1,
      revision,
      event: 'REQUEST_CHANGES',
      body: 'Not yet',
    }),
  ).rejects.toMatchObject({ code: 'PROVIDER_PULL_DRAFT' });
  expect(posted).toHaveLength(3);
});

test.each(['server', 'acknowledgment', 'cancel', 'rejected'] as const)(
  'review submission handles %s without retrying a notification-producing request',
  async (mode) => {
    const { providers, account, api } = await setup(`write-${mode}`);
    const controller = new AbortController();
    let posts = 0;
    server.use(
      http.get(`${api}/repos/team/project/pulls/1`, () => HttpResponse.json(githubPullFixture())),
      http.post(`${api}/repos/team/project/pulls/1/reviews`, () => {
        posts++;
        if (mode === 'cancel') controller.abort();
        return HttpResponse.json(
          {
            message: 'Secret review-secret',
            id: 1,
            user: null,
            state: 'APPROVED',
            body: '',
            submitted_at: '2026-10-03T00:00:00Z',
            commit_id: '9'.repeat(40),
          },
          { status: mode === 'server' ? 500 : mode === 'rejected' ? 422 : 200 },
        );
      }),
    );
    await expect(
      providers.submitReview(
        account.id,
        { repository, number: 1, revision, event: 'APPROVE', body: '' },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      code: mode === 'rejected' ? 'PROVIDER_REVIEW_REJECTED' : 'PROVIDER_WRITE_UNCERTAIN',
    });
    await providers.idle();
    expect(posts).toBe(1);
  },
);

test('provider file and review pages enforce caps and reject malformed metadata', async () => {
  const { providers, account, api } = await setup('page-limits');
  const file = {
    filename: 'file.txt',
    status: 'added',
    additions: 1,
    deletions: 0,
    changes: 1,
    sha: '4'.repeat(40),
    patch: '+text',
  };
  let malformed = false;
  server.use(
    http.get(`${api}/repos/team/project/pulls/1`, () => HttpResponse.json(githubPullFixture())),
    http.get(`${api}/repos/team/project/pulls/1/files`, () =>
      HttpResponse.json(
        malformed
          ? [{ ...file, patch: 123 }]
          : Array.from({ length: 100 }, (_, i) => ({ ...file, filename: `file-${i}.txt` })),
      ),
    ),
    http.get(`${api}/repos/team/project/pulls/1/reviews`, () =>
      HttpResponse.json(
        Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          user: null,
          state: malformed ? 'UNKNOWN' : 'COMMENTED',
          body: '',
          commit_id: '1'.repeat(40),
          submitted_at: '2026-10-03T00:00:00Z',
        })),
      ),
    ),
  );
  expect(
    await providers.pullFiles(account.id, { repository, number: 1, revision, page: 29 }),
  ).toMatchObject({ nextPage: 30, limited: false });
  expect(
    await providers.pullFiles(account.id, { repository, number: 1, revision, page: 30 }),
  ).toMatchObject({ nextPage: null, limited: true });
  await expect(
    providers.pullFiles(account.id, { repository, number: 1, revision, page: 31 }),
  ).rejects.toThrow();
  expect(
    await providers.pullReviews(account.id, { repository, number: 1, page: 99 }),
  ).toMatchObject({ nextPage: 100, limited: false });
  expect(
    await providers.pullReviews(account.id, { repository, number: 1, page: 100 }),
  ).toMatchObject({ nextPage: null, limited: true });
  malformed = true;
  await expect(
    providers.pullFiles(account.id, { repository, number: 1, revision, page: 1 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  await expect(
    providers.pullReviews(account.id, { repository, number: 1, page: 1 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
});

test('a changed base or cancelled preflight prevents sending a review', async () => {
  const { providers, account, api } = await setup('preflight');
  let posts = 0;
  const controller = new AbortController();
  let cancel = false;
  server.use(
    http.get(`${api}/repos/team/project/pulls/1`, () => {
      if (cancel) controller.abort();
      const pull = githubPullFixture();
      return HttpResponse.json({
        ...pull,
        base: { ...pull.base, sha: cancel ? revision.base : '8'.repeat(40) },
      });
    }),
    http.post(`${api}/repos/team/project/pulls/1/reviews`, () => {
      posts++;
      return HttpResponse.json({});
    }),
  );
  const options = { repository, number: 1, revision, event: 'APPROVE' as const, body: '' };
  await expect(providers.submitReview(account.id, options)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_PULL',
  });
  cancel = true;
  await expect(
    providers.submitReview(account.id, options, controller.signal),
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(posts).toBe(0);
});
