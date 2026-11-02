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

test('GitLab overview comments review fresh merge state and send exactly the confirmed body once', async () => {
  const { service, account, origin } = await setup('create');
  const intent = {
    action: 'comment' as const,
    repository,
    number: 7,
    body: 'Reviewed <script>text</script>\r\n',
  };
  const writes: unknown[] = [];
  const discussion = gitlabDiscussionFixture();
  server.use(
    http.post(`${origin}/api/v4/projects/77/merge_requests/7/discussions`, async ({ request }) => {
      expect(request.headers.get('authorization')).toBe('Bearer discussion-secret');
      writes.push(await request.json());
      return HttpResponse.json(
        {
          ...discussion,
          notes: [
            {
              ...discussion.notes[0],
              type: 'DiscussionNote',
              position: null,
              body: 'Reviewed <script>text</script>\n',
            },
          ],
        },
        { status: 201 },
      );
    }),
  );
  const preview = await service.previewMergeDiscussionAction(account.id, intent);
  expect(preview).toMatchObject({ mergeRequest: { number: 7, id: '1007' }, discussion: null });
  expect(writes).toEqual([]);
  const result = await service.writeMergeDiscussion(account.id, {
    intent,
    revision: preview.revision,
  });
  expect(result).toMatchObject({
    kind: 'commented',
    discussion: { id: discussion.id, notes: [{ body: 'Reviewed <script>text</script>\n' }] },
  });
  expect(writes).toEqual([{ body: intent.body }]);
});

test('GitLab replies and resolution review the selected thread and reject stale notes or altered drafts', async () => {
  const { service, account, origin } = await setup('threads', 'https://gitlab.example.test');
  let discussion = gitlabDiscussionFixture();
  const endpoint = `${origin}/api/v4/projects/77/merge_requests/7/discussions/${discussion.id}`;
  const writes: unknown[] = [];
  server.use(
    http.get(endpoint, () => HttpResponse.json(discussion)),
    http.post(`${endpoint}/notes`, async ({ request }) => {
      writes.push(await request.json());
      return HttpResponse.json(
        { ...discussion.notes[0], id: 11, type: 'DiscussionNote', body: 'Reply', position: null },
        { status: 201 },
      );
    }),
    http.put(endpoint, ({ request }) => {
      const resolved = new URL(request.url).searchParams.get('resolved') === 'true';
      writes.push({ resolved });
      discussion = {
        ...discussion,
        notes: discussion.notes.map((note) => ({ ...note, resolved })),
      };
      return HttpResponse.json(discussion);
    }),
  );
  const intent = {
    action: 'reply' as const,
    repository,
    number: 7,
    discussionId: discussion.id,
    body: 'Reply',
  };
  const preview = await service.previewMergeDiscussionAction(account.id, intent);
  expect(preview.discussion).toMatchObject({
    id: discussion.id,
    notes: [{ id: 10, resolved: false }],
  });
  await expect(
    service.writeMergeDiscussion(account.id, {
      intent: { ...intent, body: 'Altered' },
      revision: preview.revision,
    }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_DISCUSSION' });
  discussion.notes[0]!.body = 'Edited while reviewing';
  await expect(
    service.writeMergeDiscussion(account.id, { intent, revision: preview.revision }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_DISCUSSION' });
  expect(writes).toEqual([]);
  const fresh = await service.previewMergeDiscussionAction(account.id, intent);
  expect(
    await service.writeMergeDiscussion(account.id, { intent, revision: fresh.revision }),
  ).toMatchObject({ kind: 'replied', note: { id: 11, body: 'Reply' } });
  for (const resolved of [true, false]) {
    const resolve = {
      action: 'resolve' as const,
      repository,
      number: 7,
      discussionId: discussion.id,
      resolved,
    };
    const reviewed = await service.previewMergeDiscussionAction(account.id, resolve);
    expect(
      await service.writeMergeDiscussion(account.id, {
        intent: resolve,
        revision: reviewed.revision,
      }),
    ).toMatchObject({ kind: 'resolved', discussion: { notes: [{ resolved }] } });
    await expect(service.previewMergeDiscussionAction(account.id, resolve)).rejects.toMatchObject({
      code: 'PROVIDER_DISCUSSION_STATE',
    });
  }
  expect(writes).toEqual([{ body: 'Reply' }, { resolved: true }, { resolved: false }]);
});

test('GitLab write failures distinguish refusals from uncertain dispatch and never retry', async () => {
  const { service, account, origin } = await setup('failures');
  const intent = { action: 'comment' as const, repository, number: 7, body: 'Keep this draft' };
  const preview = await service.previewMergeDiscussionAction(account.id, intent);
  let writes = 0;
  for (const status of [403, 422, 500, 503]) {
    server.use(
      http.post(`${origin}/api/v4/projects/77/merge_requests/7/discussions`, () => {
        writes++;
        return HttpResponse.json({ message: 'discussion-secret' }, { status });
      }),
    );
    await expect(
      service.writeMergeDiscussion(account.id, { intent, revision: preview.revision }),
    ).rejects.toMatchObject({
      code: status < 500 ? 'PROVIDER_WRITE_REJECTED' : 'PROVIDER_WRITE_UNCERTAIN',
      message: expect.not.stringContaining('discussion-secret'),
    });
  }
  server.use(
    http.post(`${origin}/api/v4/projects/77/merge_requests/7/discussions`, () => {
      writes++;
      return HttpResponse.json(gitlabDiscussionFixture(), { status: 201 }); // Inline response to overview action.
    }),
  );
  await expect(
    service.writeMergeDiscussion(account.id, { intent, revision: preview.revision }),
  ).rejects.toMatchObject({ code: 'PROVIDER_WRITE_UNCERTAIN' });
  expect(writes).toBe(5);
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    service.writeMergeDiscussion(
      account.id,
      { intent, revision: preview.revision },
      cancelled.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(writes).toBe(5);
  const controller = new AbortController();
  server.use(
    http.post(`${origin}/api/v4/projects/77/merge_requests/7/discussions`, () => {
      writes++;
      controller.abort();
      return HttpResponse.json({}, { status: 201 });
    }),
  );
  await expect(
    service.writeMergeDiscussion(
      account.id,
      { intent, revision: preview.revision },
      controller.signal,
    ),
  ).rejects.toMatchObject({ code: 'PROVIDER_WRITE_UNCERTAIN' });
  expect(writes).toBe(6);
});

test('GitLab discussion actions reject foreign targets, system notes and nonresolvable threads before sending', async () => {
  const { service, account, origin } = await setup('invalid');
  const discussion = gitlabDiscussionFixture();
  const endpoint = `${origin}/api/v4/projects/77/merge_requests/7/discussions/${discussion.id}`;
  const intent = {
    action: 'resolve' as const,
    repository,
    number: 7,
    discussionId: discussion.id,
    resolved: true,
  };
  for (const value of [
    { ...discussion, id: 'a'.repeat(40) },
    { ...discussion, notes: [{ ...discussion.notes[0], project_id: 999 }] },
    { ...discussion, notes: [{ ...discussion.notes[0], system: true }] },
    { ...discussion, notes: [{ ...discussion.notes[0], resolvable: false }] },
    { ...discussion, notes: [{ ...discussion.notes[0], resolved: null }] },
    { ...discussion, individual_note: true },
  ]) {
    server.use(http.get(endpoint, () => HttpResponse.json(value)));
    await expect(service.previewMergeDiscussionAction(account.id, intent)).rejects.toMatchObject({
      code: expect.stringMatching(/^PROVIDER_(RESPONSE|DISCUSSION_STATE)$/),
    });
  }
});

test('GitLab does not report a created discussion from an asynchronous or unexpected success status', async () => {
  const { service, account, origin } = await setup('ack-status');
  const intent = { action: 'comment' as const, repository, number: 7, body: 'Comment' };
  const preview = await service.previewMergeDiscussionAction(account.id, intent);
  const discussion = gitlabDiscussionFixture();
  let writes = 0;
  for (const status of [200, 202]) {
    server.use(
      http.post(`${origin}/api/v4/projects/77/merge_requests/7/discussions`, () => {
        writes++;
        return HttpResponse.json(
          {
            ...discussion,
            notes: [
              { ...discussion.notes[0], type: 'DiscussionNote', position: null, body: 'Comment' },
            ],
          },
          { status },
        );
      }),
    );
    await expect(
      service.writeMergeDiscussion(account.id, { intent, revision: preview.revision }),
    ).rejects.toMatchObject({ code: 'PROVIDER_WRITE_UNCERTAIN' });
  }
  expect(writes).toBe(2);
});
