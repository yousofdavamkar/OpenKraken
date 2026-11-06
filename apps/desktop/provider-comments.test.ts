import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { http, HttpResponse } from 'msw';
import { providerServer } from '../../tests/provider-server.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';
import { protection } from '../../tests/provider-protection.js';
import {
  githubCommentFixture,
  githubPullFixture,
} from '../../packages/test-fixtures/src/provider.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-pr-comments-'));
const server = providerServer();
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const repository = { owner: 'team', name: 'project' };
const revision = { head: '1'.repeat(40), base: '2'.repeat(40) };
async function setup(name: string, origin = 'https://github.com') {
  const directory = join(root, name),
    api = origin === 'https://github.com' ? 'https://api.github.com' : `${origin}/api/v3`;
  server.use(http.get(`${api}/user`, () => HttpResponse.json({ id: 321, login: 'reviewer' })));
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  const account = (await providers.connect({ provider: 'github', origin, token: 'comment-secret' }))
    .accounts[0]!;
  return { providers, account, api };
}
test('inline comment pages preserve thread roots, outdated locations and bounded literal hunks', async () => {
  const { providers, account, api } = await setup('read');
  server.use(
    http.get(`${api}/repos/team/project/pulls/1/comments`, ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get('sort')).toBe('created');
      expect(url.searchParams.get('direction')).toBe('asc');
      expect(url.searchParams.get('per_page')).toBe('100');
      return HttpResponse.json([
        githubCommentFixture(),
        {
          ...githubCommentFixture(11),
          in_reply_to_id: 10,
          user: null,
          line: null,
          start_line: null,
          original_line: 9,
          original_start_line: 8,
          start_side: 'RIGHT',
          diff_hunk: '+'.repeat(262145),
        },
      ]);
    }),
  );
  const result = await providers.pullComments(account.id, { repository, number: 1, page: 1 });
  expect(result).toMatchObject({
    nextPage: null,
    limited: false,
    comments: [
      { id: 10, replyTo: null, path: 'src/main.ts', line: 2, side: 'RIGHT', hunkTruncated: false },
      {
        id: 11,
        replyTo: 10,
        author: null,
        line: null,
        originalLine: 9,
        originalStartLine: 8,
        hunkTruncated: true,
      },
    ],
  });
  expect(result.comments[1]!.hunk).toHaveLength(262144);
  expect(JSON.stringify(result)).not.toContain('pull_request_url');
});

test('inline comments bind a reviewed line and replies verify the original thread belongs to the PR', async () => {
  const { providers, account, api } = await setup('write', 'https://git.example.test');
  const posts: unknown[] = [];
  let rootComment = {
    ...githubCommentFixture(),
    pull_request_url: `${api}/repos/team/project/pulls/1`,
  };
  let current = githubPullFixture();
  server.use(
    http.get(`${api}/repos/team/project/pulls/1`, () => HttpResponse.json(current)),
    http.get(`${api}/repos/team/project/pulls/comments/10`, () => HttpResponse.json(rootComment)),
    http.post(`${api}/repos/team/project/pulls/1/comments`, async ({ request }) => {
      expect(request.headers.get('x-github-api-version')).toBe('2022-11-28');
      const body = await request.json();
      posts.push(body);
      return HttpResponse.json({
        ...rootComment,
        id: 20,
        body: 'An inline comment',
        side: 'LEFT',
        line: 2,
      });
    }),
    http.post(`${api}/repos/team/project/pulls/1/comments/10/replies`, async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json({ ...rootComment, id: 21, in_reply_to_id: 10, body: 'A reply' });
    }),
  );
  const options = {
    repository,
    number: 1,
    revision,
    body: 'An inline comment',
    target: { kind: 'line' as const, path: 'src/main.ts', line: 2, side: 'LEFT' as const },
  };
  expect(await providers.createComment(account.id, options)).toMatchObject({
    id: 20,
    line: 2,
    side: 'LEFT',
  });
  expect(posts[0]).toEqual({
    body: 'An inline comment',
    commit_id: revision.head,
    path: 'src/main.ts',
    line: 2,
    side: 'LEFT',
  });
  const reply = {
    repository,
    number: 1,
    revision,
    body: 'A reply',
    target: { kind: 'reply' as const, commentId: 10 },
  };
  expect(await providers.createComment(account.id, reply)).toMatchObject({ id: 21, replyTo: 10 });
  expect(posts[1]).toEqual({ body: 'A reply' });
  rootComment = { ...rootComment, pull_request_url: `${api}/repos/team/project/pulls/2` };
  await expect(providers.createComment(account.id, reply)).rejects.toMatchObject({
    code: 'PROVIDER_COMMENT_TARGET',
  });
  current = { ...current, head: { ...current.head, sha: '9'.repeat(40) } };
  await expect(providers.createComment(account.id, options)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_PULL',
  });
  expect(posts).toHaveLength(2);
});

test.each(['server', 'acknowledgment', 'cancel', 'rejected'] as const)(
  'comment %s failure never retries a write',
  async (mode) => {
    const { providers, account, api } = await setup(mode);
    const controller = new AbortController();
    let posts = 0;
    server.use(
      http.get(`${api}/repos/team/project/pulls/1`, () => HttpResponse.json(githubPullFixture())),
      http.post(`${api}/repos/team/project/pulls/1/comments`, () => {
        posts++;
        if (mode === 'cancel') controller.abort();
        return HttpResponse.json(
          { ...githubCommentFixture(), commit_id: '9'.repeat(40), message: 'comment-secret' },
          { status: mode === 'server' ? 500 : mode === 'rejected' ? 422 : 201 },
        );
      }),
    );
    await expect(
      providers.createComment(
        account.id,
        {
          repository,
          number: 1,
          revision,
          body: 'Comment',
          target: { kind: 'line', path: 'src/main.ts', side: 'RIGHT', line: 2 },
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      code: mode === 'rejected' ? 'PROVIDER_COMMENT_REJECTED' : 'PROVIDER_WRITE_UNCERTAIN',
    });
    expect(posts).toBe(1);
  },
);

test('comment paging is bounded and malformed anchors are refused', async () => {
  const { providers, account, api } = await setup('caps');
  let malformed = false;
  server.use(
    http.get(`${api}/repos/team/project/pulls/1/comments`, () =>
      HttpResponse.json(
        malformed
          ? [{ ...githubCommentFixture(), line: -1 }]
          : Array.from({ length: 100 }, (_, i) => githubCommentFixture(i + 1)),
      ),
    ),
  );
  expect(
    await providers.pullComments(account.id, { repository, number: 1, page: 99 }),
  ).toMatchObject({ nextPage: 100, limited: false });
  expect(
    await providers.pullComments(account.id, { repository, number: 1, page: 100 }),
  ).toMatchObject({ nextPage: null, limited: true });
  await expect(
    providers.pullComments(account.id, { repository, number: 1, page: 101 }),
  ).rejects.toThrow();
  malformed = true;
  await expect(
    providers.pullComments(account.id, { repository, number: 1, page: 1 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
});

test('replies refuse nested targets and closed PRs, and cancellation before dispatch sends nothing', async () => {
  const { providers, account, api } = await setup('reply-guards');
  const controller = new AbortController();
  let closed = false,
    cancel = false,
    posts = 0;
  server.use(
    http.get(`${api}/repos/team/project/pulls/1`, () => {
      if (cancel) controller.abort();
      return HttpResponse.json({ ...githubPullFixture(), state: closed ? 'closed' : 'open' });
    }),
    http.get(`${api}/repos/team/project/pulls/comments/10`, () =>
      HttpResponse.json({ ...githubCommentFixture(), in_reply_to_id: 9 }),
    ),
    http.post(`${api}/repos/team/project/pulls/1/comments/10/replies`, () => {
      posts++;
      return HttpResponse.json({});
    }),
  );
  const options = {
    repository,
    number: 1,
    revision,
    body: 'Reply',
    target: { kind: 'reply' as const, commentId: 10 },
  };
  await expect(providers.createComment(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_COMMENT_TARGET',
  });
  closed = true;
  await expect(providers.createComment(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_PULL_CLOSED',
  });
  closed = false;
  cancel = true;
  await expect(
    providers.createComment(account.id, options, controller.signal),
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(posts).toBe(0);
});
