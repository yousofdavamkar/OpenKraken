import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { protection } from '../../tests/provider-protection.js';
import {
  gitlabDiscussionFixture,
  gitlabMergeFixture,
  gitlabFileFixture,
} from '../../tests/gitlab-fixtures.js';
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

const patch =
  '@@ -10,3 +20,4 @@\n context\n-old\n+new\n+extra\n tail\n@@ -30 +40 @@\n-last\n+last-new\n';
const revision = { base: '2'.repeat(40), head: '1'.repeat(40), start: '3'.repeat(40) };

test.each([
  { oldLine: 11, newLine: null, text: '-old' },
  { oldLine: null, newLine: 21, text: '+new' },
  { oldLine: 12, newLine: 23, text: ' tail' },
  { oldLine: null, newLine: 40, text: '+last-new' },
])(
  'GitLab posts a reviewed renamed-file location $oldLine/$newLine with its three diff SHAs',
  async ({ oldLine, newLine, text }) => {
    const { service, account, origin } = await setup(`line-${oldLine}-${newLine}`);
    const target = { revision, oldPath: 'old.ts', newPath: 'new.ts', oldLine, newLine };
    const intent = {
      action: 'inline' as const,
      repository,
      number: 7,
      body: 'Inline <script>comment</script>',
      page: 2,
      position: target,
    };
    const writes: unknown[] = [];
    server.use(
      http.get(`${origin}/api/v4/projects/77/merge_requests/7/diffs`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('page')).toBe('2');
        return HttpResponse.json([
          { ...gitlabFileFixture('new.ts'), old_path: 'old.ts', diff: patch },
        ]);
      }),
      http.post(
        `${origin}/api/v4/projects/77/merge_requests/7/discussions`,
        async ({ request }) => {
          writes.push(Object.fromEntries(await request.formData()));
          const discussion = gitlabDiscussionFixture();
          return HttpResponse.json(
            {
              ...discussion,
              notes: [
                {
                  ...discussion.notes[0],
                  body: intent.body,
                  position: {
                    ...discussion.notes[0]!.position,
                    old_line: oldLine,
                    new_line: newLine,
                  },
                },
              ],
            },
            { status: 201 },
          );
        },
      ),
    );
    const preview = await service.previewMergeDiscussionAction(account.id, intent);
    expect(preview).toMatchObject({ inline: { position: target, text }, discussion: null });
    expect(writes).toEqual([]);
    expect(
      await service.writeMergeDiscussion(account.id, { intent, revision: preview.revision }),
    ).toMatchObject({
      kind: 'commented',
      discussion: { notes: [{ position: { kind: 'text', ...target, range: null } }] },
    });
    expect(writes).toEqual([
      {
        body: intent.body,
        'position[position_type]': 'text',
        'position[base_sha]': revision.base,
        'position[head_sha]': revision.head,
        'position[start_sha]': revision.start,
        'position[old_path]': 'old.ts',
        'position[new_path]': 'new.ts',
        ...(oldLine === null ? {} : { 'position[old_line]': String(oldLine) }),
        ...(newLine === null ? {} : { 'position[new_line]': String(newLine) }),
      },
    ]);
  },
);

test('GitLab refuses ambiguous files and locations outside complete hunks before posting', async () => {
  const { service, account, origin } = await setup('invalid-lines');
  const file = { ...gitlabFileFixture('new.ts'), old_path: 'old.ts', diff: patch };
  const intent = {
    action: 'inline' as const,
    repository,
    number: 7,
    body: 'Comment',
    page: 1,
    position: { revision, oldPath: 'old.ts', newPath: 'new.ts', oldLine: 12, newLine: 23 },
  };
  for (const files of [
    [file, file],
    [{ ...file, old_path: 'different.ts' }],
    [{ ...file, diff: null }],
    [{ ...file, collapsed: true }],
    [{ ...file, too_large: true }],
    [{ ...file, diff: patch + '+'.repeat(262144) }],
    [{ ...file, diff: '@@ -10,3 +20,4 @@\n context\n-old\n+new\n+extra\n' }],
    [{ ...file, diff: patch + '+outside hunk\n' }],
    [{ ...file, diff: '@@ -12 +23 @@\n tail\n@@ -12 +23 @@\n duplicate\n' }],
    [{ ...file, diff: '@@ -9007199254740991,2 +23 @@\n tail\n' }],
  ]) {
    server.use(
      http.get(`${origin}/api/v4/projects/77/merge_requests/7/diffs`, () =>
        HttpResponse.json(files),
      ),
    );
    await expect(service.previewMergeDiscussionAction(account.id, intent)).rejects.toMatchObject({
      code: 'PROVIDER_COMMENT_TARGET',
    });
  }
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests/7/diffs`, () =>
      HttpResponse.json([file]),
    ),
  );
  // Context must carry both coordinates, not a guessed old or new side.
  for (const position of [
    { ...intent.position, oldLine: null },
    { ...intent.position, newLine: null },
    { ...intent.position, newLine: 22 },
  ])
    await expect(
      service.previewMergeDiscussionAction(account.id, { ...intent, position }),
    ).rejects.toMatchObject({ code: 'PROVIDER_COMMENT_TARGET' });
});

test.each([
  {
    diff: '@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n',
    oldLine: null,
    newLine: 2,
    text: '+two',
  },
  { diff: '@@ -1,2 +0,0 @@\n-one\n-two\n', oldLine: 2, newLine: null, text: '-two' },
  { diff: '@@ -10 +20 @@\r\n context\r\n', oldLine: 10, newLine: 20, text: ' context\r' },
  { diff: '@@ -1 +1 @@\n context\n@@ -1,0 +2 @@\n+new\n', oldLine: null, newLine: 2, text: '+new' },
])(
  'GitLab accepts complete zero-count and no-newline hunks at $oldLine/$newLine',
  async ({ diff, oldLine, newLine, text }) => {
    const { service, account, origin } = await setup(
      `complete-${oldLine}-${newLine}-${diff.length}`,
    );
    server.use(
      http.get(`${origin}/api/v4/projects/77/merge_requests/7/diffs`, () =>
        HttpResponse.json([{ ...gitlabFileFixture('new.ts'), old_path: 'old.ts', diff }]),
      ),
    );
    const intent = {
      action: 'inline' as const,
      repository,
      number: 7,
      body: 'Comment',
      page: 1,
      position: { revision, oldPath: 'old.ts', newPath: 'new.ts', oldLine, newLine },
    };
    expect(await service.previewMergeDiscussionAction(account.id, intent)).toMatchObject({
      inline: { text },
    });
  },
);

test('GitLab rechecks inline diff SHAs and reviewed patch contents, and treats a misplaced acknowledgment as uncertain', async () => {
  const { service, account, origin } = await setup('stale-inline');
  let diff = patch;
  const intent = {
    action: 'inline' as const,
    repository,
    number: 7,
    body: 'Comment',
    page: 1,
    position: { revision, oldPath: 'old.ts', newPath: 'new.ts', oldLine: 12, newLine: 23 },
  };
  let writes = 0;
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests/7/diffs`, () =>
      HttpResponse.json([{ ...gitlabFileFixture('new.ts'), old_path: 'old.ts', diff }]),
    ),
    http.post(`${origin}/api/v4/projects/77/merge_requests/7/discussions`, () => {
      writes++;
      return HttpResponse.json(gitlabDiscussionFixture(), { status: 201 });
    }),
  );
  const preview = await service.previewMergeDiscussionAction(account.id, intent);
  diff = diff.replace('+new', '+different');
  await expect(
    service.writeMergeDiscussion(account.id, { intent, revision: preview.revision }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_DISCUSSION' });
  diff = patch;
  for (const key of ['base', 'head', 'start'] as const)
    await expect(
      service.previewMergeDiscussionAction(account.id, {
        ...intent,
        position: { ...intent.position, revision: { ...revision, [key]: '4'.repeat(40) } },
      }),
    ).rejects.toMatchObject({ code: 'STALE_PROVIDER_MERGE' });
  expect(writes).toBe(0);
  await expect(
    service.writeMergeDiscussion(account.id, { intent, revision: preview.revision }),
  ).rejects.toMatchObject({ code: 'PROVIDER_WRITE_UNCERTAIN' });
  expect(writes).toBe(1);
});
