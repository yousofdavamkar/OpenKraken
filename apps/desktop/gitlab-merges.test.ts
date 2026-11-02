import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { protection } from '../../tests/provider-protection.js';
import { gitlabFileFixture, gitlabMergeFixture } from '../../tests/gitlab-fixtures.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-gitlab-merges-'));
const server = setupServer();
const repository = { owner: 'group/subgroup', name: 'project' };
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});
async function setup(name: string, origin = 'https://gitlab.com') {
  const directory = join(root, name);
  const service = new ProviderService(directory, new ProviderVault(directory, protection()));
  server.use(
    http.get(`${origin}/api/v4/user`, () => HttpResponse.json({ id: 73, username: 'gitlab-user' })),
    http.get(`${origin}/api/v4/projects/:project`, ({ request }) => {
      expect(new URL(request.url).pathname).toBe('/api/v4/projects/group%2Fsubgroup%2Fproject');
      return HttpResponse.json({ id: 77, path_with_namespace: 'group/subgroup/project' });
    }),
  );
  const account = (await service.connect({ provider: 'gitlab', origin, token: 'merge-secret' }))
    .accounts[0]!;
  return { service, account, origin };
}

test('GitLab lists project merge requests by local number with encoded namespaces, canonical URLs and manual pages', async () => {
  const { service, account, origin } = await setup('list');
  const pages: string[] = [];
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests`, ({ request }) => {
      const url = new URL(request.url);
      expect(request.headers.get('authorization')).toBe('Bearer merge-secret');
      expect(url.searchParams.get('scope')).toBe('all');
      expect(url.searchParams.get('state')).toBe('opened');
      expect(url.searchParams.get('order_by')).toBe('updated_at');
      expect(url.searchParams.get('sort')).toBe('desc');
      expect(url.searchParams.get('per_page')).toBe('100');
      pages.push(url.searchParams.get('page')!);
      return HttpResponse.json(
        Array.from({ length: pages.at(-1) === '1' ? 100 : 1 }, (_, i) =>
          gitlabMergeFixture(pages.at(-1) === '1' ? i + 1 : 101),
        ),
        { headers: { Link: '<https://attacker.test/steal>; rel="next"' } },
      );
    }),
  );
  const first = await service.pullRequests(account.id, { repository, state: 'open', page: 1 });
  expect(first.pullRequests).toHaveLength(100);
  expect(first).toMatchObject({ nextPage: 2, limited: false });
  expect(first.pullRequests[0]).toEqual({
    number: 1,
    title: 'Merge 1',
    author: 'contributor',
    state: 'open',
    draft: false,
    createdAt: '2026-10-01T12:00:00Z',
    updatedAt: '2026-10-02T12:00:00Z',
    mergedAt: null,
    url: 'https://gitlab.com/group/subgroup/project/-/merge_requests/1',
  });
  expect(
    (await service.pullRequests(account.id, { repository, state: 'open', page: 2 }))
      .pullRequests[0]!.number,
  ).toBe(101);
  expect(pages).toEqual(['1', '2']);
  expect(JSON.stringify(first)).not.toContain('merge-secret');
});

test('GitLab detail preserves three diff revisions, fork identity, approximate counts and pending diff preparation', async () => {
  const { service, account, origin } = await setup('details');
  let prepared = true;
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests/7`, () =>
      HttpResponse.json({
        ...gitlabMergeFixture(7),
        ...(prepared
          ? {}
          : { diff_refs: {}, changes_count: '', source_project_id: null, sha: null }),
      }),
    ),
  );
  expect(await service.mergeRequest(account.id, { repository, number: 7 })).toMatchObject({
    provider: 'gitlab',
    number: 7,
    body: 'Literal <script>description</script>',
    source: { projectId: '88', branch: 'feature', sha: '1'.repeat(40) },
    target: { projectId: '77', branch: 'main' },
    diffRefs: { base: '2'.repeat(40), head: '1'.repeat(40), start: '3'.repeat(40) },
    changesCount: { count: 1000, limited: true },
    notesCount: 5,
    mergeStatus: 'checking',
    conflicts: false,
  });
  prepared = false;
  const pending = await service.mergeRequest(account.id, { repository, number: 7 });
  expect(pending).toMatchObject({
    diffRefs: null,
    changesCount: null,
    source: { projectId: null, sha: null },
  });
  expect(pending).not.toHaveProperty('commits');
  expect(pending).not.toHaveProperty('additions');
});

test('GitLab native states remain distinct and the final manual page is bounded on self-managed hosts', async () => {
  const { service, account, origin } = await setup('states', 'https://code.example.test');
  const states: string[] = [];
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests`, ({ request }) => {
      const url = new URL(request.url);
      const state = url.searchParams.get('state')!;
      states.push(state);
      return HttpResponse.json(
        Array.from({ length: 100 }, (_, i) => ({
          ...gitlabMergeFixture(i + 1),
          state,
          author: null,
        })),
      );
    }),
  );
  for (const state of ['closed', 'merged', 'locked'] as const) {
    const result = await service.pullRequests(account.id, { repository, state, page: 100 });
    expect(result).toMatchObject({ nextPage: null, limited: true });
    expect(result.pullRequests[0]).toMatchObject({
      state,
      author: null,
      url: `${origin}/group/subgroup/project/-/merge_requests/1`,
    });
  }
  expect(states).toEqual(['closed', 'merged', 'locked']);
});

test('GitLab refuses foreign projects, wrong local numbers, partial revisions and malformed counts without leaking responses', async () => {
  const { service, account, origin } = await setup('invalid');
  let changed: Record<string, unknown> = {};
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests/7`, () =>
      HttpResponse.json({ ...gitlabMergeFixture(7), ...changed }),
    ),
  );
  for (const value of [
    { project_id: 78 },
    { target_project_id: 78 },
    { iid: 8 },
    { diff_refs: { base_sha: '2'.repeat(40) } },
    {
      diff_refs: { base_sha: 'merge-secret', head_sha: '1'.repeat(40), start_sha: '3'.repeat(40) },
    },
    { changes_count: '9007199254740992' },
    { changes_count: '-1' },
    { changes_count: '12files' },
    { description: 'x'.repeat(262145) },
    { source_project_id: 0 },
  ]) {
    changed = value;
    await expect(service.mergeRequest(account.id, { repository, number: 7 })).rejects.toMatchObject(
      { code: 'PROVIDER_RESPONSE', message: expect.not.stringContaining('merge-secret') },
    );
  }
  server.use(
    http.get(`${origin}/api/v4/projects/:project`, () =>
      HttpResponse.json({ id: 77, path_with_namespace: 'another/project' }),
    ),
  );
  await expect(service.mergeRequest(account.id, { repository, number: 7 })).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
});

test('GitLab all-state pages omit the filter, bound metadata and reject wrong-state results', async () => {
  const { service, account, origin } = await setup('all');
  let entries: unknown[] = [gitlabMergeFixture(1), { ...gitlabMergeFixture(2), state: 'merged' }];
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests`, ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get('scope')).toBe('all');
      if (url.searchParams.get('page') === '2') expect(url.searchParams.has('state')).toBe(false);
      return HttpResponse.json(entries);
    }),
  );
  const page = await service.pullRequests(account.id, { repository, state: 'all', page: 2 });
  expect(page.pullRequests.map((request) => request.state)).toEqual(['open', 'merged']);
  expect(page.nextPage).toBeNull();
  await expect(
    service.pullRequests(account.id, { repository, state: 'open', page: 1 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  entries = Array.from({ length: 101 }, (_, i) => gitlabMergeFixture(i + 1));
  await expect(
    service.pullRequests(account.id, { repository, state: 'all', page: 2 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
});

test('Cancelling GitLab detail reads aborts transport and never returns late metadata', async () => {
  const { service, account, origin } = await setup('cancel');
  let markStarted!: () => void;
  let markAborted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests/7`, async ({ request }) => {
      markStarted();
      request.signal.addEventListener('abort', () => markAborted(), { once: true });
      await aborted;
      return HttpResponse.json(gitlabMergeFixture(7));
    }),
  );
  const controller = new AbortController();
  const pending = service.mergeRequest(account.id, { repository, number: 7 }, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  await started;
  controller.abort();
  await rejected;
  await aborted;
});

test('GitLab file pages preserve rename/mode metadata and patch availability within the selected diff revisions', async () => {
  const { service, account, origin } = await setup('files');
  const revision = { base: '2'.repeat(40), head: '1'.repeat(40), start: '3'.repeat(40) };
  const pages: string[] = [];
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests/7`, () =>
      HttpResponse.json(gitlabMergeFixture(7)),
    ),
    http.get(`${origin}/api/v4/projects/77/merge_requests/7/diffs`, ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get('per_page')).toBe('100');
      pages.push(url.searchParams.get('page')!);
      return HttpResponse.json(
        pages.at(-1) === '1'
          ? Array.from({ length: 100 }, (_, i) => gitlabFileFixture(`file-${i}`))
          : [{ ...gitlabFileFixture(), diff: '', collapsed: true, generated_file: true }],
        { headers: { Link: '<https://attacker.test/steal>; rel="next"' } },
      );
    }),
  );
  const first = await service.mergeRequestFiles(account.id, {
    repository,
    number: 7,
    revision,
    page: 1,
  });
  expect(first).toMatchObject({ nextPage: 2, limited: false });
  expect(first.files[0]).toEqual({
    path: 'file-0',
    previousPath: 'src/old.ts',
    status: 'renamed',
    oldMode: '100644',
    newMode: '100755',
    generated: false,
    collapsed: false,
    tooLarge: false,
    patch: '@@ -1 +1 @@\n-old\n+<script>new</script>\n',
    patchTruncated: false,
  });
  const second = await service.mergeRequestFiles(account.id, {
    repository,
    number: 7,
    revision,
    page: 2,
  });
  expect(second).toMatchObject({
    nextPage: null,
    limited: false,
    files: [{ patch: null, collapsed: true, generated: true }],
  });
  expect(second.files[0]).not.toHaveProperty('sha');
  expect(second.files[0]).not.toHaveProperty('additions');
  expect(pages).toEqual(['1', '2']);
});

test('GitLab file reads refuse stale source/base/target revisions before dispatch and detect changes during a page', async () => {
  const { service, account, origin } = await setup('stale-files');
  const revision = { base: '2'.repeat(40), head: '1'.repeat(40), start: '3'.repeat(40) };
  let detail = gitlabMergeFixture(7);
  let fileReads = 0;
  let changeDuringRead = false;
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests/7`, () => HttpResponse.json(detail)),
    http.get(`${origin}/api/v4/projects/77/merge_requests/7/diffs`, () => {
      fileReads++;
      if (changeDuringRead)
        detail = { ...detail, diff_refs: { ...detail.diff_refs, start_sha: '4'.repeat(40) } };
      return HttpResponse.json([gitlabFileFixture()]);
    }),
  );
  for (const field of ['base_sha', 'head_sha', 'start_sha'] as const) {
    detail = {
      ...gitlabMergeFixture(7),
      diff_refs: { ...gitlabMergeFixture(7).diff_refs, [field]: '4'.repeat(40) },
    };
    await expect(
      service.mergeRequestFiles(account.id, { repository, number: 7, revision, page: 1 }),
    ).rejects.toMatchObject({ code: 'STALE_PROVIDER_MERGE' });
  }
  detail = { ...gitlabMergeFixture(7), sha: '5'.repeat(40) };
  await expect(
    service.mergeRequestFiles(account.id, { repository, number: 7, revision, page: 1 }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_MERGE' });
  expect(fileReads).toBe(0);
  detail = gitlabMergeFixture(7);
  changeDuringRead = true;
  await expect(
    service.mergeRequestFiles(account.id, { repository, number: 7, revision, page: 1 }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_MERGE' });
  expect(fileReads).toBe(1);
});

test('GitLab file pages bound patches, flag provider omissions and reject malformed metadata', async () => {
  const { service, account, origin } = await setup('file-bounds');
  const revision = { base: '2'.repeat(40), head: '1'.repeat(40), start: '3'.repeat(40) };
  let entries: unknown[] = [
    { ...gitlabFileFixture('huge'), diff: 'x'.repeat(262145) },
    { ...gitlabFileFixture('omitted'), diff: null, too_large: true },
    {
      ...gitlabFileFixture('older-server'),
      diff: undefined,
      generated_file: undefined,
      collapsed: undefined,
      too_large: undefined,
    },
  ];
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests/7`, () =>
      HttpResponse.json(gitlabMergeFixture(7)),
    ),
    http.get(`${origin}/api/v4/projects/77/merge_requests/7/diffs`, () =>
      HttpResponse.json(entries),
    ),
  );
  const first = await service.mergeRequestFiles(account.id, {
    repository,
    number: 7,
    revision,
    page: 1,
  });
  expect(first.files[0]!.patch).toHaveLength(262144);
  expect(first.files[0]!.patchTruncated).toBe(true);
  expect(first.files[1]).toMatchObject({ patch: null, tooLarge: true });
  expect(first.files[2]).toMatchObject({
    patch: null,
    generated: null,
    collapsed: null,
    tooLarge: null,
  });
  entries = Array.from({ length: 100 }, (_, i) => gitlabFileFixture(`file-${i}`));
  expect(
    await service.mergeRequestFiles(account.id, { repository, number: 7, revision, page: 30 }),
  ).toMatchObject({ nextPage: null, limited: true });
  for (const value of [
    { diff: 15 },
    { a_mode: 'secret' },
    { new_path: '' },
    { new_file: true },
    { too_large: 'true' },
  ]) {
    entries = [{ ...gitlabFileFixture(), ...value }];
    await expect(
      service.mergeRequestFiles(account.id, { repository, number: 7, revision, page: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  }
  entries = Array.from({ length: 101 }, () => gitlabFileFixture());
  await expect(
    service.mergeRequestFiles(account.id, { repository, number: 7, revision, page: 1 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
});
