import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';
import { githubIssueFixture } from '../../packages/test-fixtures/src/provider.js';
import { protection } from '../../tests/provider-protection.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-issue-actions-'));
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
  server.use(http.get(`${api}/user`, () => HttpResponse.json({ id: 321, login: 'writer' })));
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  const account = (await providers.connect({ provider: 'github', origin, token: 'actions-secret' }))
    .accounts[0]!;
  const issue = { ...githubIssueFixture(), url: `${api}/repos/team/project/issues/1` };
  return { providers, account, api, issue };
}
test('creating an issue sends only the reviewed title and body once to the selected Enterprise repository', async () => {
  const { providers, account, api, issue } = await setup('create', 'https://git.example.test');
  const writes: unknown[] = [];
  server.use(
    http.post(`${api}/repos/team/project/issues`, async ({ request }) => {
      expect(request.headers.get('authorization')).toBe('token actions-secret');
      writes.push(await request.json());
      return HttpResponse.json(
        { ...issue, title: 'New issue', body: 'Exact description' },
        { status: 201 },
      );
    }),
  );
  expect(
    await providers.writeIssue(account.id, {
      action: 'create',
      repository,
      title: 'New issue',
      body: 'Exact description',
    }),
  ).toMatchObject({
    kind: 'created',
    issue: {
      number: 1,
      title: 'New issue',
      body: 'Exact description',
      url: 'https://git.example.test/team/project/issues/1',
    },
  });
  expect(writes).toEqual([{ title: 'New issue', body: 'Exact description' }]);
});

test('reviewed comments and close/reopen actions target only the selected issue', async () => {
  const { providers, account, api, issue } = await setup('actions');
  const writes: unknown[] = [];
  let current = issue;
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, () => HttpResponse.json(current)),
    http.post(`${api}/repos/team/project/issues/1/comments`, async ({ request }) => {
      writes.push(await request.json());
      return HttpResponse.json(
        {
          id: 42,
          user: { login: 'writer' },
          body: 'Reviewed comment',
          created_at: '2026-10-04T00:00:00Z',
          updated_at: '2026-10-04T00:00:00Z',
          issue_url: issue.url,
        },
        { status: 201 },
      );
    }),
    http.patch(`${api}/repos/team/project/issues/1`, async ({ request }) => {
      const body = (await request.json()) as { state: string; state_reason: string };
      writes.push(body);
      return HttpResponse.json({ ...current, state: body.state, state_reason: body.state_reason });
    }),
  );
  const preview = await providers.previewIssueAction(account.id, { repository, number: 1 });
  expect(preview.issue).toMatchObject({ number: 1, title: issue.title });
  expect(writes).toEqual([]);
  expect(
    await providers.writeIssue(account.id, {
      action: 'comment',
      repository,
      number: 1,
      revision: preview.revision,
      body: 'Reviewed comment',
    }),
  ).toMatchObject({ kind: 'commented', comment: { id: '42', body: 'Reviewed comment' } });
  expect(
    await providers.writeIssue(account.id, {
      action: 'state',
      repository,
      number: 1,
      revision: preview.revision,
      state: 'closed',
      reason: 'not_planned',
    }),
  ).toMatchObject({ kind: 'updated', issue: { state: 'closed', stateReason: 'not_planned' } });
  current = { ...issue, state: 'closed' };
  const closed = await providers.previewIssueAction(account.id, { repository, number: 1 });
  expect(
    await providers.writeIssue(account.id, {
      action: 'state',
      repository,
      number: 1,
      revision: closed.revision,
      state: 'open',
      reason: 'reopened',
    }),
  ).toMatchObject({ kind: 'updated', issue: { state: 'open', stateReason: 'reopened' } });
  expect(writes).toEqual([
    { body: 'Reviewed comment' },
    { state: 'closed', state_reason: 'not_planned' },
    { state: 'open', state_reason: 'reopened' },
  ]);
});

test.each(['body', 'title', 'labels', 'comments', 'state', 'locked'])(
  'issue actions reject changed %s before writing, including edits within the same timestamp',
  async (field) => {
    const { providers, account, api, issue } = await setup(`stale-${field}`);
    let current: unknown = issue;
    let writes = 0;
    server.use(
      http.get(
        `${api}/repos/team/project/issues/1`,
        () =>
          new HttpResponse(JSON.stringify(current), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
      http.post(`${api}/repos/team/project/issues/1/comments`, () => {
        writes++;
        return HttpResponse.json({});
      }),
      http.patch(`${api}/repos/team/project/issues/1`, () => {
        writes++;
        return HttpResponse.json({});
      }),
    );
    const preview = await providers.previewIssueAction(account.id, { repository, number: 1 });
    const changes = {
      body: 'New description',
      title: 'Changed title',
      labels: ['different'],
      comments: 2,
      state: 'closed',
      locked: true,
    };
    current = { ...issue, [field]: changes[field as keyof typeof changes] };
    await expect(
      providers.writeIssue(account.id, {
        action: 'comment',
        repository,
        number: 1,
        revision: preview.revision,
        body: 'Draft',
      }),
    ).rejects.toMatchObject({ code: 'STALE_PROVIDER_ISSUE' });
    await expect(
      providers.writeIssue(account.id, {
        action: 'state',
        repository,
        number: 1,
        revision: preview.revision,
        state: 'closed',
        reason: 'completed',
      }),
    ).rejects.toMatchObject({ code: 'STALE_PROVIDER_ISSUE' });
    expect(writes).toBe(0);
  },
);
test('locked comments and unchanged issue states are refused before dispatch', async () => {
  const { providers, account, api, issue } = await setup('guards');
  let writes = 0;
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, () =>
      HttpResponse.json({ ...issue, locked: true }),
    ),
    http.post(`${api}/repos/team/project/issues/1/comments`, () => {
      writes++;
      return HttpResponse.json({});
    }),
    http.patch(`${api}/repos/team/project/issues/1`, () => {
      writes++;
      return HttpResponse.json({});
    }),
  );
  const preview = await providers.previewIssueAction(account.id, { repository, number: 1 });
  await expect(
    providers.writeIssue(account.id, {
      action: 'comment',
      repository,
      number: 1,
      revision: preview.revision,
      body: 'Draft',
    }),
  ).rejects.toMatchObject({ code: 'PROVIDER_ISSUE_LOCKED' });
  await expect(
    providers.writeIssue(account.id, {
      action: 'state',
      repository,
      number: 1,
      revision: preview.revision,
      state: 'open',
      reason: 'reopened',
    }),
  ).rejects.toMatchObject({ code: 'PROVIDER_ISSUE_STATE' });
  expect(writes).toBe(0);
});
test.each(['create', 'comment', 'state'] as const)(
  'uncertain %s acknowledgments are never retried and explicit rejections stay distinct',
  async (action) => {
    const { providers, account, api, issue } = await setup(`outcomes-${action}`);
    server.use(http.get(`${api}/repos/team/project/issues/1`, () => HttpResponse.json(issue)));
    const preview = await providers.previewIssueAction(account.id, { repository, number: 1 });
    const options =
      action === 'create'
        ? { action, repository, title: 'New issue', body: 'Text' }
        : action === 'comment'
          ? { action, repository, number: 1, revision: preview.revision, body: 'Text' }
          : {
              action,
              repository,
              number: 1,
              revision: preview.revision,
              state: 'closed' as const,
              reason: 'completed' as const,
            };
    for (const mode of ['server', 'malformed', 'foreign', 'mismatch', 'reject', 'cancel']) {
      let writes = 0;
      const controller = new AbortController();
      const handler = () => {
        writes++;
        if (mode === 'cancel') controller.abort();
        if (mode === 'server' || mode === 'reject')
          return HttpResponse.json(
            { message: 'actions-secret' },
            { status: mode === 'server' ? 500 : 422 },
          );
        if (mode === 'malformed') return HttpResponse.json({ id: 'bad' });
        const url = mode === 'foreign' ? `${api}/repos/other/secret/issues/1` : issue.url;
        return HttpResponse.json(
          action === 'comment'
            ? {
                id: 42,
                user: null,
                body: mode === 'mismatch' ? 'Other text' : 'Text',
                created_at: '2026-10-04T00:00:00Z',
                updated_at: '2026-10-04T00:00:00Z',
                issue_url: url,
              }
            : {
                ...issue,
                url,
                title: action === 'create' ? 'New issue' : issue.title,
                body: 'Text',
                state: action === 'state' && mode !== 'mismatch' ? 'closed' : 'open',
                state_reason: 'completed',
                ...(mode === 'mismatch' && action === 'create' ? { title: 'Other title' } : {}),
              },
        );
      };
      server.use(
        action === 'create'
          ? http.post(`${api}/repos/team/project/issues`, handler)
          : action === 'comment'
            ? http.post(`${api}/repos/team/project/issues/1/comments`, handler)
            : http.patch(`${api}/repos/team/project/issues/1`, handler),
      );
      await expect(
        providers.writeIssue(account.id, options, controller.signal),
      ).rejects.toMatchObject({
        code: mode === 'reject' ? 'PROVIDER_ISSUE_REJECTED' : 'PROVIDER_WRITE_UNCERTAIN',
      });
      expect(writes).toBe(1);
    }
  },
);
test('cancelling an issue preflight sends no write and PRs cannot be action targets', async () => {
  const { providers, account, api, issue } = await setup('cancel');
  server.use(http.get(`${api}/repos/team/project/issues/1`, () => HttpResponse.json(issue)));
  const preview = await providers.previewIssueAction(account.id, { repository, number: 1 });
  let started!: () => void,
    writes = 0;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, async ({ request }) => {
      started();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return HttpResponse.json(issue);
    }),
    http.post(`${api}/repos/team/project/issues/1/comments`, () => {
      writes++;
      return HttpResponse.json({});
    }),
  );
  const controller = new AbortController();
  const options = {
    action: 'comment' as const,
    repository,
    number: 1,
    revision: preview.revision,
    body: 'Draft',
  };
  const pending = providers.writeIssue(account.id, options, controller.signal);
  await began;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  server.use(
    http.get(`${api}/repos/team/project/issues/1`, () =>
      HttpResponse.json({ ...issue, pull_request: {} }),
    ),
  );
  await expect(providers.writeIssue(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_ISSUE_IS_PULL',
  });
  expect(writes).toBe(0);
});
