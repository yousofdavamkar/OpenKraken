import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { protection } from '../../tests/provider-protection.js';
import {
  bitbucketPullFixture,
  bitbucketRepositoryFixture,
  bitbucketUserFixture,
  bitbucketCommentFixture,
} from '../../tests/bitbucket-fixtures.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-bitbucket-comments-'));
const api = 'https://api.bitbucket.org/2.0';
const endpoint = `${api}/repositories/team/project/pullrequests/1/comments`;
const options = {
  repository: { owner: 'team', name: 'project' },
  number: 1,
  repositoryId: bitbucketRepositoryFixture.uuid,
  page: 1,
};
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
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
    http.get(`${api}/repositories/team/project/pullrequests/1`, () =>
      HttpResponse.json(bitbucketPullFixture()),
    ),
  );
  const account = (
    await service.connect({
      provider: 'bitbucket',
      origin: 'https://bitbucket.org',
      token: 'comments-secret',
    })
  ).accounts[0]!;
  return { service, account };
}

test('Bitbucket comments page chronological general, inline and reply metadata without interpreting HTML or deleted content', async () => {
  const { service, account } = await setup('read');
  server.use(
    http.get(endpoint, ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get('pagelen')).toBe('100');
      expect(url.searchParams.get('sort')).toBe('created_on');
      const page = Number(url.searchParams.get('page'));
      return HttpResponse.json({
        page,
        next: `${endpoint}?page=${page + 1}`,
        values: [
          {
            ...bitbucketCommentFixture(1),
            content: { raw: 'Literal <script>text</script>', html: 'Ignored' },
            inline: {
              path: 'src/file.ts',
              from: 8,
              start_from: 5,
              to: null,
              start_to: null,
              outdated: true,
            },
            resolution: {
              type: 'comment_resolution',
              user: bitbucketUserFixture,
              created_on: '2026-10-02T12:00:00+00:00',
            },
          },
          { ...bitbucketCommentFixture(2), parent: { id: 1 }, pending: true },
          {
            ...bitbucketCommentFixture(3),
            parent: { id: 1 },
            deleted: true,
            user: null,
            content: { raw: 'Do not expose deleted content' },
            pending: undefined,
            resolution: undefined,
          },
        ],
      });
    }),
  );
  const page = await service.bitbucketPullComments(account.id, options);
  expect(page.nextPage).toBe(2);
  expect(page.limited).toBe(false);
  expect(page.comments[0]).toEqual({
    id: 1,
    author: { id: bitbucketUserFixture.uuid, name: 'Fixture Person' },
    body: 'Literal <script>text</script>',
    deleted: false,
    pending: false,
    parentId: null,
    createdAt: '2026-10-01T12:00:00+00:00',
    updatedAt: '2026-10-02T12:00:00+00:00',
    inline: {
      path: 'src/file.ts',
      oldLine: 8,
      newLine: null,
      oldStart: 5,
      newStart: null,
      outdated: true,
    },
    resolution: {
      status: 'resolved',
      author: { id: bitbucketUserFixture.uuid, name: 'Fixture Person' },
      createdAt: '2026-10-02T12:00:00+00:00',
    },
  });
  expect(page.comments[1]).toMatchObject({
    parentId: 1,
    pending: true,
    resolution: { status: 'unresolved' },
  });
  expect(page.comments[2]).toMatchObject({
    body: null,
    deleted: true,
    author: null,
    pending: null,
    resolution: { status: 'unknown' },
  });
  expect(await service.bitbucketPullComments(account.id, { ...options, page: 100 })).toMatchObject({
    nextPage: null,
    limited: true,
  });
});

test('Bitbucket retains deleted tombstones and file-level positions when content, authors, timestamps and source repositories are unavailable', async () => {
  const { service, account } = await setup('tombstone');
  server.use(
    http.get(`${api}/repositories/team/project/pullrequests/1`, () =>
      HttpResponse.json({
        ...bitbucketPullFixture(),
        source: { repository: null, branch: null, commit: null },
      }),
    ),
    http.get(endpoint, () =>
      HttpResponse.json({
        values: [
          {
            ...bitbucketCommentFixture(),
            content: {},
            deleted: true,
            user: null,
            created_on: undefined,
            updated_on: null,
            inline: { path: 'old-file.ts' },
            resolution: { type: 'comment_resolution', user: null },
          },
        ],
      }),
    ),
  );
  expect((await service.bitbucketPullComments(account.id, options)).comments[0]).toMatchObject({
    body: null,
    author: null,
    createdAt: null,
    updatedAt: null,
    inline: {
      path: 'old-file.ts',
      oldLine: null,
      newLine: null,
      oldStart: null,
      newStart: null,
      outdated: null,
    },
    resolution: { status: 'resolved', author: null, createdAt: null },
  });
});

test('Bitbucket rejects foreign comment identity, malformed ranges, duplicate IDs and cyclic reply relationships', async () => {
  const { service, account } = await setup('guards');
  let values: unknown[] = [];
  server.use(http.get(endpoint, () => HttpResponse.json({ values })));
  for (const invalid of [
    { ...bitbucketCommentFixture(), pullrequest: { id: 2 } },
    {
      ...bitbucketCommentFixture(),
      pullrequest: {
        id: 1,
        destination: { repository: { ...bitbucketRepositoryFixture, full_name: 'team/other' } },
      },
    },
    { ...bitbucketCommentFixture(), parent: { id: 1 } },
    { ...bitbucketCommentFixture(), inline: { path: 'x.ts', from: 5, start_from: 6 } },
    { ...bitbucketCommentFixture(), inline: { path: 'x.ts', start_to: 2 } },
    { ...bitbucketCommentFixture(), inline: { path: 'x.ts', to: 0 } },
    { ...bitbucketCommentFixture(), content: {} },
    { ...bitbucketCommentFixture(), user: { ...bitbucketUserFixture, uuid: 'not-a-uuid' } },
  ]) {
    values = [invalid];
    await expect(service.bitbucketPullComments(account.id, options)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
    });
  }
  values = [bitbucketCommentFixture(), bitbucketCommentFixture()];
  await expect(service.bitbucketPullComments(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
  values = Array.from({ length: 101 }, (_, i) => bitbucketCommentFixture(i + 1));
  await expect(service.bitbucketPullComments(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
  values = [
    { ...bitbucketCommentFixture(1), parent: { id: 2 } },
    { ...bitbucketCommentFixture(2), parent: { id: 1 } },
  ];
  await expect(service.bitbucketPullComments(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
});

test('Bitbucket comment pages reject repository replacement and unsafe next links and cancel HTTP reads without exposing provider failures', async () => {
  const { service, account } = await setup('lifecycle');
  let replaced = false;
  let mode: 'normal' | 'replace' | 'next' | 'fail' | 'wait' = 'normal';
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const repository = () => ({
    ...bitbucketRepositoryFixture,
    uuid: replaced ? '{20000000-0000-4000-8000-000000000099}' : bitbucketRepositoryFixture.uuid,
  });
  server.use(
    http.get(`${api}/repositories/team/project`, () => HttpResponse.json(repository())),
    http.get(`${api}/repositories/team/project/pullrequests/1`, () =>
      HttpResponse.json({
        ...bitbucketPullFixture(),
        destination: { ...bitbucketPullFixture().destination, repository: repository() },
      }),
    ),
    http.get(endpoint, async ({ request }) => {
      if (mode === 'fail')
        return HttpResponse.json({ message: 'comments-secret' }, { status: 403 });
      if (mode === 'wait') {
        entered();
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      if (mode === 'replace') replaced = true;
      return HttpResponse.json({
        page: 1,
        values: [],
        ...(mode === 'next' ? { next: 'https://attacker.test/comments?page=2' } : {}),
      });
    }),
  );
  mode = 'replace';
  await expect(service.bitbucketPullComments(account.id, options)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_MERGE',
  });
  mode = 'normal';
  await expect(service.bitbucketPullComments(account.id, options)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_MERGE',
  });
  replaced = false;
  mode = 'next';
  await expect(service.bitbucketPullComments(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
  mode = 'fail';
  await expect(service.bitbucketPullComments(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_AUTH',
    message: expect.not.stringContaining('comments-secret'),
  });
  mode = 'wait';
  const controller = new AbortController();
  const pending = service.bitbucketPullComments(account.id, options, controller.signal);
  const cancelled = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  await started;
  controller.abort();
  await cancelled;
});
