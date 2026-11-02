import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { protection } from '../../tests/provider-protection.js';
import {
  gitlabIssueFixture as issue,
  gitlabIssueNoteFixture as note,
} from '../../tests/gitlab-fixtures.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-gitlab-issue-actions-'));
const server = setupServer();
const repository = { owner: 'group/subgroup', name: 'project' };
const create = {
  action: 'create' as const,
  repository,
  title: 'New issue',
  body: 'Literal <script>description</script>',
  confidential: true,
};
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});
async function setup(name: string, origin = 'https://gitlab.com') {
  const directory = join(root, name);
  const service = new ProviderService(directory, new ProviderVault(directory, protection()));
  const state: {
    issue: Omit<ReturnType<typeof issue>, 'discussion_locked'> & {
      discussion_locked: boolean | null;
    };
    archived: boolean;
    writes: unknown[];
  } = { issue: issue(7), archived: false, writes: [] };
  server.use(
    http.get(`${origin}/api/v4/user`, () => HttpResponse.json({ id: 73, username: 'contributor' })),
    http.get(`${origin}/api/v4/projects/:project`, () =>
      HttpResponse.json({
        id: 77,
        path_with_namespace: 'group/subgroup/project',
        archived: state.archived,
        issues_enabled: true,
        issues_access_level: 'enabled',
      }),
    ),
    http.get(`${origin}/api/v4/projects/77/issues/7`, () => HttpResponse.json(state.issue)),
    http.post(`${origin}/api/v4/projects/77/issues`, async ({ request }) => {
      state.writes.push(await request.json());
      return HttpResponse.json(
        {
          ...issue(8),
          issue_type: 'issue',
          title: create.title,
          description: create.body,
          confidential: create.confidential,
        },
        { status: 201 },
      );
    }),
  );
  const account = (
    await service.connect({ provider: 'gitlab', origin, token: 'issue-action-secret' })
  ).accounts[0]!;
  return { service, account, origin, state };
}
test('GitLab issue creation reviews project policy and exact draft before sending explicit confidentiality', async () => {
  const { service, account, state } = await setup('create', 'https://gitlab.example.test');
  const preview = await service.previewGitLabIssueAction(account.id, create);
  expect(preview).toMatchObject({
    issue: null,
    project: { id: '77', archived: false, issuesEnabled: true, issuesAccessLevel: 'enabled' },
  });
  const result = await service.writeGitLabIssue(account.id, {
    intent: create,
    revision: preview.revision,
  });
  expect(result).toMatchObject({
    kind: 'created',
    issue: {
      number: 8,
      title: create.title,
      body: create.body,
      confidential: true,
      issueType: 'issue',
      url: 'https://gitlab.example.test/group/subgroup/project/-/issues/8',
    },
  });
  expect(state.writes).toEqual([
    { title: create.title, description: create.body, confidential: true, issue_type: 'issue' },
  ]);
  await expect(
    service.writeGitLabIssue(account.id, {
      intent: { ...create, confidential: false },
      revision: preview.revision,
    }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_ISSUE' });
  state.archived = true;
  await expect(
    service.writeGitLabIssue(account.id, { intent: create, revision: preview.revision }),
  ).rejects.toMatchObject({ code: 'PROVIDER_ISSUE_STATE' });
  expect(state.writes).toHaveLength(1);
});

test('GitLab comments and close/reopen send native parameters after fresh exact-snapshot reviews', async () => {
  const { service, account, state, origin } = await setup('comment-state');
  server.use(
    http.post(`${origin}/api/v4/projects/77/issues/7/notes`, async ({ request }) => {
      const body = await request.json();
      state.writes.push(body);
      return HttpResponse.json(
        { ...note(), body: 'Exact comment', internal: true, confidential: true },
        { status: 201 },
      );
    }),
    http.put(`${origin}/api/v4/projects/77/issues/7`, async ({ request }) => {
      const body = (await request.json()) as { state_event: string };
      state.writes.push(body);
      state.issue = { ...state.issue, state: body.state_event === 'close' ? 'closed' : 'opened' };
      return HttpResponse.json(state.issue);
    }),
  );
  const comment = {
    action: 'comment' as const,
    repository,
    number: 7,
    body: 'Exact comment',
    internal: true,
  };
  const reviewed = await service.previewGitLabIssueAction(account.id, comment);
  state.issue.title = 'Changed without a timestamp update';
  await expect(
    service.writeGitLabIssue(account.id, { intent: comment, revision: reviewed.revision }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_ISSUE' });
  expect(state.writes).toHaveLength(0);
  const preview = await service.previewGitLabIssueAction(account.id, comment);
  await expect(
    service.writeGitLabIssue(account.id, { intent: comment, revision: preview.revision }),
  ).resolves.toMatchObject({
    kind: 'commented',
    comment: { body: 'Exact comment', internal: true },
  });
  for (const state of ['closed', 'open'] as const) {
    const intent = { action: 'state' as const, repository, number: 7, state };
    const preview = await service.previewGitLabIssueAction(account.id, intent);
    await expect(
      service.writeGitLabIssue(account.id, { intent, revision: preview.revision }),
    ).resolves.toMatchObject({ kind: 'updated', issue: { number: 7, state } });
  }
  expect(state.writes).toEqual([
    { body: 'Exact comment', internal: true },
    { state_event: 'close' },
    { state_event: 'reopen' },
  ]);
});

test('GitLab reviews bind account identity, reject slash commands and disabled projects, and allow server-authorized locked comments', async () => {
  const { service, account, state, origin } = await setup('policy');
  const reviewed = await service.previewGitLabIssueAction(account.id, create);
  server.use(
    http.get(`${origin}/api/v4/user`, () => HttpResponse.json({ id: 74, username: 'other-user' })),
  );
  const other = (
    await service.connect({ provider: 'gitlab', origin, token: 'other-token' })
  ).accounts.find((account) => account.providerUserId === '74')!;
  await expect(
    service.writeGitLabIssue(other.id, { intent: create, revision: reviewed.revision }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_ISSUE' });
  server.use(
    http.get(`${origin}/api/v4/user`, () => HttpResponse.json({ id: 73, username: 'contributor' })),
  );
  for (const body of ['/close', 'Text\r\n /confidential', 'Text\n/assign @someone']) {
    await expect(
      service.previewGitLabIssueAction(account.id, { ...create, body }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ISSUE_COMMAND' });
    await expect(
      service.previewGitLabIssueAction(account.id, {
        action: 'comment',
        repository,
        number: 7,
        body,
        internal: false,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ISSUE_COMMAND' });
  }
  await expect(
    service.previewGitLabIssueAction(account.id, {
      ...create,
      body: 'Literal \\/close and /home/user/file',
    }),
  ).resolves.toBeDefined();
  await expect(
    service.previewGitLabIssueAction(account.id, {
      action: 'state',
      repository,
      number: 7,
      state: 'open',
    }),
  ).rejects.toMatchObject({ code: 'PROVIDER_ISSUE_STATE' });
  state.issue.discussion_locked = true;
  await expect(
    service.previewGitLabIssueAction(account.id, {
      action: 'comment',
      repository,
      number: 7,
      body: 'Member comment',
      internal: false,
    }),
  ).resolves.toMatchObject({ issue: { locked: true } });
  server.use(
    http.get(`${origin}/api/v4/projects/:project`, () =>
      HttpResponse.json({
        id: 77,
        path_with_namespace: 'group/subgroup/project',
        archived: false,
        issues_access_level: 'disabled',
      }),
    ),
  );
  await expect(service.previewGitLabIssueAction(account.id, create)).rejects.toMatchObject({
    code: 'PROVIDER_ISSUE_STATE',
  });
  expect(state.writes).toHaveLength(0);
});

test('GitLab write acknowledgments must match native identities, text, state and visibility; failures never retry writes', async () => {
  const { service, account, origin } = await setup('ack');
  const preview = await service.previewGitLabIssueAction(account.id, create);
  let calls = 0;
  for (const extra of [
    { project_id: 88 },
    { title: 'Different' },
    { description: 'Different' },
    { confidential: false },
    { issue_type: 'incident' },
    { state: 'closed' },
  ]) {
    server.use(
      http.post(`${origin}/api/v4/projects/77/issues`, () => {
        calls++;
        return HttpResponse.json(
          {
            ...issue(8),
            title: create.title,
            description: create.body,
            issue_type: 'issue',
            ...extra,
          },
          { status: 201 },
        );
      }),
    );
    const before = calls;
    await expect(
      service.writeGitLabIssue(account.id, { intent: create, revision: preview.revision }),
    ).rejects.toMatchObject({ code: 'PROVIDER_WRITE_UNCERTAIN' });
    expect(calls).toBe(before + 1);
  }
  for (const status of [400, 403, 422, 202, 503]) {
    server.use(
      http.post(`${origin}/api/v4/projects/77/issues`, () => {
        calls++;
        return HttpResponse.json({ message: 'issue-action-secret' }, { status });
      }),
    );
    const before = calls;
    await expect(
      service.writeGitLabIssue(account.id, { intent: create, revision: preview.revision }),
    ).rejects.toMatchObject({
      code: status < 500 && status !== 202 ? 'PROVIDER_WRITE_REJECTED' : 'PROVIDER_WRITE_UNCERTAIN',
    });
    expect(calls).toBe(before + 1);
  }
  const intent = {
    action: 'comment' as const,
    repository,
    number: 7,
    body: 'Comment',
    internal: false,
  };
  const review = await service.previewGitLabIssueAction(account.id, intent);
  for (const extra of [
    { noteable_id: 2008 },
    { noteable_iid: 8 },
    { project_id: 88 },
    { body: 'Different' },
    { system: true },
    { internal: true },
    { internal: undefined, confidential: undefined },
  ]) {
    server.use(
      http.post(`${origin}/api/v4/projects/77/issues/7/notes`, () =>
        HttpResponse.json(
          { ...note(), body: 'Comment', internal: false, confidential: false, ...extra },
          { status: 201 },
        ),
      ),
    );
    await expect(
      service.writeGitLabIssue(account.id, { intent, revision: review.revision }),
    ).rejects.toMatchObject({ code: 'PROVIDER_WRITE_UNCERTAIN' });
  }
});

test('GitLab issue cancellation distinguishes pre-dispatch cancellation from an uncertain submitted write', async () => {
  const { service, account, origin, state } = await setup('cancel');
  const preview = await service.previewGitLabIssueAction(account.id, create);
  const early = new AbortController();
  early.abort();
  await expect(
    service.writeGitLabIssue(
      account.id,
      { intent: create, revision: preview.revision },
      early.signal,
    ),
  ).rejects.toBeDefined();
  expect(state.writes).toHaveLength(0);
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let posts = 0;
  server.use(
    http.post(`${origin}/api/v4/projects/77/issues`, async ({ request }) => {
      posts++;
      began();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return HttpResponse.json({});
    }),
  );
  const controller = new AbortController();
  const pending = service.writeGitLabIssue(
    account.id,
    { intent: create, revision: preview.revision },
    controller.signal,
  );
  await started;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_WRITE_UNCERTAIN' });
  expect(posts).toBe(1);
});
