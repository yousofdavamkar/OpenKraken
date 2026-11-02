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
} from '../../tests/bitbucket-fixtures.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-bitbucket-files-'));
const server = setupServer();
const api = 'https://api.bitbucket.org/2.0';
const repository = { owner: 'team', name: 'project' };
const revision = {
  repositoryId: bitbucketRepositoryFixture.uuid,
  sourceRepositoryId: bitbucketPullFixture().source.repository.uuid,
  sourceCommit: '1'.repeat(40),
  destinationCommit: '2'.repeat(40),
};
const spec = `contributor/fork:${revision.sourceCommit}..${revision.destinationCommit}`;
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
      token: 'files-secret',
    })
  ).accounts[0]!;
  return { service, account };
}

test('Bitbucket files follow a validated PR comparison redirect and append bounded native diffstat pages', async () => {
  const { service, account } = await setup('pages');
  let redirects = 0;
  server.use(
    http.get(`${api}/repositories/team/project/pullrequests/1/diffstat`, () => {
      redirects++;
      return new HttpResponse(null, {
        status: 302,
        headers: {
          Location: `${api}/repositories/team/project/diffstat/${spec}?topic=true&from_pullrequest_id=1`,
        },
      });
    }),
    http.get(`${api}/repositories/team/project/diffstat/${spec}`, ({ request }) => {
      const url = new URL(request.url);
      expect(request.headers.get('authorization')).toBe('Bearer files-secret');
      expect(url.searchParams.get('topic')).toBe('true');
      expect(url.searchParams.get('pagelen')).toBe('100');
      const page = Number(url.searchParams.get('page'));
      return HttpResponse.json({
        page,
        values: [
          {
            status: 'renamed',
            old: { path: 'old.ts' },
            new: { path: 'new.ts' },
            lines_added: 3,
            lines_removed: 2,
          },
        ],
        next: `${api}/repositories/team/project/diffstat/${spec}?page=${page + 1}&topic=true`,
      });
    }),
  );
  const page = await service.bitbucketPullFiles(account.id, {
    repository,
    number: 1,
    revision,
    page: 1,
  });
  expect(page).toEqual({
    files: [
      { path: 'new.ts', previousPath: 'old.ts', status: 'renamed', additions: 3, deletions: 2 },
    ],
    nextPage: 2,
    limited: false,
  });
  expect(
    await service.bitbucketPullFiles(account.id, { repository, number: 1, revision, page: 100 }),
  ).toMatchObject({ nextPage: null, limited: true });
  expect(redirects).toBe(2);
});

test('Bitbucket opens a selected file as a bounded plain-text topic diff after checking page membership', async () => {
  const { service, account } = await setup('patch');
  let patchCalls = 0;
  let text =
    'diff --git a/new.ts b/new.ts\n--- a/new.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-old\n+<script>literal</script>\n';
  server.use(
    http.get(
      `${api}/repositories/team/project/pullrequests/1/:kind`,
      ({ params }) =>
        new HttpResponse(null, {
          status: 302,
          headers: {
            Location: `${api}/repositories/team/project/${params.kind}/${spec}?topic=true&from_pullrequest_id=1`,
          },
        }),
    ),
    http.get(`${api}/repositories/team/project/diffstat/${spec}`, () =>
      HttpResponse.json({
        page: 1,
        values: [
          {
            status: 'modified',
            old: { path: 'new.ts' },
            new: { path: 'new.ts' },
            lines_added: 1,
            lines_removed: 1,
          },
        ],
      }),
    ),
    http.get(`${api}/repositories/team/project/diff/${spec}`, ({ request }) => {
      expect(new URL(request.url).searchParams.get('path')).toBe('new.ts');
      expect(request.headers.get('accept')).toBe('text/plain');
      patchCalls++;
      return HttpResponse.text(text);
    }),
  );
  const options = { repository, number: 1, revision, page: 1, path: 'new.ts' };
  expect(await service.bitbucketPullDiff(account.id, options)).toEqual({ text, truncated: false });
  text = 'x'.repeat(262145);
  expect(await service.bitbucketPullDiff(account.id, options)).toEqual({
    text: 'x'.repeat(262144),
    truncated: true,
  });
  await expect(
    service.bitbucketPullDiff(account.id, { ...options, path: 'secret.txt' }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  expect(patchCalls).toBe(2);
});

test('Bitbucket refuses foreign comparisons, changed revisions, inconsistent file sides and unsafe paging', async () => {
  const { service, account } = await setup('guards');
  const options = { repository, number: 1, revision, page: 1 };
  const good = `${api}/repositories/team/project/diffstat/${spec}?topic=true&from_pullrequest_id=1`;
  let location = good;
  let data: Record<string, unknown> = { page: 1, values: [] };
  let moved = false;
  let reads = 0;
  server.use(
    http.get(`${api}/repositories/team/project/pullrequests/1`, () => {
      const pull = bitbucketPullFixture();
      if (moved) pull.source.commit.hash = '3'.repeat(40);
      return HttpResponse.json(pull);
    }),
    http.get(
      `${api}/repositories/team/project/pullrequests/1/diffstat`,
      () => new HttpResponse(null, { status: 302, headers: { Location: location } }),
    ),
    http.get(`${api}/repositories/team/project/diffstat/${spec}`, () => {
      reads++;
      return HttpResponse.json(data);
    }),
  );
  for (const invalid of [
    good.replace('api.bitbucket.org', 'attacker.test'),
    good.replace('/team/project/', '/team/other/'),
    good.replace(revision.sourceCommit, '3'.repeat(40)),
    good.replace('topic=true', 'topic=false'),
    good + '&topic=true',
    good + '&path=hidden',
    good.replace('from_pullrequest_id=1', 'from_pullrequest_id=2'),
    good + '#hash',
    good.replace('https://', 'https://user:pass@'),
  ]) {
    location = invalid;
    await expect(service.bitbucketPullFiles(account.id, options)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
    });
  }
  expect(reads).toBe(0);
  location = good;
  moved = true;
  await expect(service.bitbucketPullFiles(account.id, options)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_MERGE',
  });
  moved = false;
  data = {
    page: 1,
    values: [
      { status: 'modified', old: null, new: { path: 'new.ts' }, lines_added: 1, lines_removed: 0 },
    ],
  };
  await expect(service.bitbucketPullFiles(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
  data = { page: 1, values: [], next: `${api}/repositories/team/other/diffstat/${spec}?page=2` };
  await expect(service.bitbucketPullFiles(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
  server.use(
    http.get(`${api}/repositories/team/project/diffstat/${spec}`, () => {
      moved = true;
      return HttpResponse.json({ page: 1, values: [] });
    }),
  );
  await expect(service.bitbucketPullFiles(account.id, options)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_MERGE',
  });
});

test('Bitbucket diff reads revalidate cached text, reject HTML and oversized bodies, and honor cancellation', async () => {
  const { service, account } = await setup('transport');
  const options = { repository, number: 1, revision, page: 1, path: 'file.ts' };
  let mode: 'text' | 'cached' | 'html' | 'large' | 'wait' = 'text';
  let started = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  server.use(
    http.get(
      `${api}/repositories/team/project/pullrequests/1/:kind`,
      ({ params }) =>
        new HttpResponse(null, {
          status: 302,
          headers: {
            Location: `${api}/repositories/team/project/${params.kind}/${spec}?topic=true`,
          },
        }),
    ),
    http.get(`${api}/repositories/team/project/diffstat/${spec}`, () =>
      HttpResponse.json({
        page: 1,
        values: [
          {
            status: 'added',
            old: null,
            new: { path: 'file.ts' },
            lines_added: 1,
            lines_removed: 0,
          },
        ],
      }),
    ),
    http.get(`${api}/repositories/team/project/diff/${spec}`, async ({ request }) => {
      if (mode === 'cached') {
        expect(request.headers.get('if-none-match')).toBe('"patch"');
        return new HttpResponse(null, { status: 304 });
      }
      if (mode === 'html')
        return new HttpResponse('<html>files-secret</html>', {
          headers: { 'Content-Type': 'text/html' },
        });
      if (mode === 'large') return HttpResponse.text('x'.repeat(4 * 1024 * 1024 + 1));
      if (mode === 'wait') {
        started();
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      return HttpResponse.text('literal patch', { headers: { ETag: '"patch"' } });
    }),
  );
  expect(await service.bitbucketPullDiff(account.id, options)).toEqual({
    text: 'literal patch',
    truncated: false,
  });
  mode = 'cached';
  expect(await service.bitbucketPullDiff(account.id, options)).toEqual({
    text: 'literal patch',
    truncated: false,
  });
  mode = 'html';
  await expect(service.bitbucketPullDiff(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
  mode = 'large';
  await expect(service.bitbucketPullDiff(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_REQUEST',
  });
  mode = 'wait';
  const controller = new AbortController();
  const pending = service.bitbucketPullDiff(account.id, options, controller.signal);
  const cancelled = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  await entered;
  controller.abort();
  await cancelled;
});
