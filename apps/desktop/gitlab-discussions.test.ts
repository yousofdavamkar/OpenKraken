import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { protection } from '../../tests/provider-protection.js';
import { gitlabDiscussionFixture, gitlabMergeFixture } from '../../tests/gitlab-fixtures.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-gitlab-discussions-'));
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
    http.get(`${origin}/api/v4/projects/:project`, () =>
      HttpResponse.json({ id: 77, path_with_namespace: 'group/subgroup/project' }),
    ),
    http.get(`${origin}/api/v4/projects/77/merge_requests/7`, () =>
      HttpResponse.json(gitlabMergeFixture(7)),
    ),
  );
  const account = (
    await service.connect({ provider: 'gitlab', origin, token: 'discussion-secret' })
  ).accounts[0]!;
  return { service, account, origin };
}

test('GitLab discussion pages preserve thread identity, replies, resolution and native diff context', async () => {
  const { service, account, origin } = await setup('pages');
  const pages: string[] = [];
  const discussion = gitlabDiscussionFixture();
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests/7/discussions`, ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get('per_page')).toBe('100');
      pages.push(url.searchParams.get('page')!);
      return HttpResponse.json(
        pages.at(-1) === '1'
          ? Array.from({ length: 100 }, (_, i) => gitlabDiscussionFixture(i + 1))
          : [
              {
                ...discussion,
                notes: [
                  discussion.notes[0],
                  {
                    ...discussion.notes[0],
                    id: 11,
                    type: 'DiscussionNote',
                    body: 'Reply',
                    author: null,
                    position: null,
                    resolved: true,
                    resolved_by: { username: 'maintainer' },
                    resolved_at: '2026-10-03T00:00:00Z',
                  },
                ],
              },
            ],
        { headers: { Link: '<https://attacker.test/steal>; rel="next"' } },
      );
    }),
  );
  const first = await service.mergeRequestDiscussions(account.id, {
    repository,
    number: 7,
    page: 1,
  });
  expect(first).toMatchObject({ nextPage: 2, limited: false });
  expect(first.discussions[0]).toMatchObject({
    id: '0'.repeat(39) + '1',
    individual: false,
    notes: [
      {
        id: 10,
        type: 'DiffNote',
        author: 'reviewer',
        resolvable: true,
        resolved: false,
        position: {
          kind: 'text',
          revision: { base: '2'.repeat(40), head: '1'.repeat(40), start: '3'.repeat(40) },
          oldPath: 'old.ts',
          newPath: 'new.ts',
          oldLine: null,
          newLine: 12,
          range: null,
        },
      },
    ],
  });
  const second = await service.mergeRequestDiscussions(account.id, {
    repository,
    number: 7,
    page: 2,
  });
  expect(second).toMatchObject({ nextPage: null, limited: false });
  expect(second.discussions[0]!.notes[1]).toMatchObject({
    id: 11,
    body: 'Reply',
    author: null,
    position: null,
    resolved: true,
    resolvedBy: 'maintainer',
    resolvedAt: '2026-10-03T00:00:00Z',
  });
  expect(pages).toEqual(['1', '2']);
});

test('GitLab discussion reads retain multiline, image and file positions and unavailable resolution metadata', async () => {
  const { service, account, origin } = await setup('positions', 'https://code.example.test');
  const original = gitlabDiscussionFixture().notes[0]!;
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests/7/discussions`, () =>
      HttpResponse.json([
        {
          ...gitlabDiscussionFixture(1),
          notes: [
            {
              ...original,
              position: {
                ...original.position,
                line_range: {
                  start: { type: 'new', new_line: 12, old_line: null, line_code: 'abc_0_12' },
                  end: { type: 'new', new_line: 15, old_line: null, line_code: 'abc_0_15' },
                },
              },
            },
          ],
        },
        {
          ...gitlabDiscussionFixture(2),
          notes: [
            {
              ...original,
              id: 20,
              position: {
                ...original.position,
                position_type: 'image',
                width: 640,
                height: 480,
                x: 12.5,
                y: 40,
              },
            },
          ],
        },
        {
          ...gitlabDiscussionFixture(3),
          notes: [
            { ...original, id: 30, position: { ...original.position, position_type: 'file' } },
          ],
        },
        {
          ...gitlabDiscussionFixture(4),
          individual_note: true,
          notes: [
            {
              ...original,
              id: 40,
              type: null,
              system: true,
              resolvable: false,
              resolved: undefined,
              resolved_by: undefined,
              resolved_at: undefined,
              position: null,
            },
          ],
        },
      ]),
    ),
  );
  const result = await service.mergeRequestDiscussions(account.id, {
    repository,
    number: 7,
    page: 1,
  });
  expect(result.discussions[0]!.notes[0]!.position).toMatchObject({
    kind: 'text',
    range: { start: { side: 'new', newLine: 12 }, end: { side: 'new', newLine: 15 } },
  });
  expect(result.discussions[1]!.notes[0]!.position).toMatchObject({
    kind: 'image',
    width: 640,
    height: 480,
    x: 12.5,
    y: 40,
  });
  expect(result.discussions[2]!.notes[0]!.position).toMatchObject({ kind: 'file' });
  expect(result.discussions[2]!.notes[0]!.position).not.toHaveProperty('newLine');
  expect(result.discussions[3]!.notes[0]).toMatchObject({
    system: true,
    type: null,
    position: null,
    resolved: null,
    resolvedBy: null,
    resolvedAt: null,
  });
});

test('GitLab rejects foreign note targets, malformed positions, duplicate IDs and contradictory thread metadata', async () => {
  const { service, account, origin } = await setup('invalid');
  const discussion = gitlabDiscussionFixture();
  const note = discussion.notes[0]!;
  let entries: unknown[] = [];
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests/7/discussions`, () =>
      HttpResponse.json(entries),
    ),
  );
  for (const change of [
    { project_id: 78 },
    { noteable_id: 1008 },
    { noteable_iid: 8 },
    { noteable_type: 'Issue' },
    { position: { ...note.position, head_sha: 'secret' } },
    { position: { ...note.position, new_line: -1 } },
    {
      position: {
        ...note.position,
        line_range: { start: { type: 'new', new_line: null }, end: { type: 'new', new_line: 10 } },
      },
    },
    {
      position: {
        ...note.position,
        line_range: { start: { type: 'new', new_line: 12 }, end: { type: 'new', new_line: 10 } },
      },
    },
    { body: 'x'.repeat(262145) },
  ]) {
    entries = [{ ...discussion, notes: [{ ...note, ...change }] }];
    await expect(
      service.mergeRequestDiscussions(account.id, { repository, number: 7, page: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  }
  for (const discussions of [
    [discussion, discussion],
    [{ ...discussion, notes: [note, note] }],
    [{ ...discussion, individual_note: true, notes: [note, { ...note, id: 11 }] }],
  ]) {
    entries = discussions;
    await expect(
      service.mergeRequestDiscussions(account.id, { repository, number: 7, page: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  }
});

test('GitLab discussions enforce page and nested-note bounds and abort obsolete reads', async () => {
  const { service, account, origin } = await setup('bounds');
  let data: unknown[] = Array.from({ length: 100 }, (_, i) => gitlabDiscussionFixture(i + 1));
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests/7/discussions`, () =>
      HttpResponse.json(data),
    ),
  );
  expect(
    await service.mergeRequestDiscussions(account.id, { repository, number: 7, page: 10 }),
  ).toMatchObject({ nextPage: null, limited: true });
  data = Array.from({ length: 101 }, (_, i) => gitlabDiscussionFixture(i + 1));
  await expect(
    service.mergeRequestDiscussions(account.id, { repository, number: 7, page: 1 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  const discussion = gitlabDiscussionFixture();
  data = [
    {
      ...discussion,
      notes: Array.from({ length: 1001 }, (_, i) => ({ ...discussion.notes[0], id: i + 1 })),
    },
  ];
  await expect(
    service.mergeRequestDiscussions(account.id, { repository, number: 7, page: 1 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  data = Array.from({ length: 100 }, (_, i) => ({
    ...gitlabDiscussionFixture(i + 1),
    notes: Array.from({ length: 11 }, (_, j) => ({ ...discussion.notes[0], id: i * 11 + j + 1 })),
  }));
  await expect(
    service.mergeRequestDiscussions(account.id, { repository, number: 7, page: 1 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  let start!: () => void;
  let abort!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    abort = resolve;
  });
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests/7/discussions`, async ({ request }) => {
      start();
      request.signal.addEventListener('abort', abort, { once: true });
      await aborted;
      return HttpResponse.json([discussion]);
    }),
  );
  const controller = new AbortController();
  const pending = service.mergeRequestDiscussions(
    account.id,
    { repository, number: 7, page: 1 },
    controller.signal,
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  await started;
  controller.abort();
  await rejected;
  await aborted;
});
