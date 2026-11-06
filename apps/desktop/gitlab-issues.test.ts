import { resultSchema, requestSchema, serviceRequestSchema } from '@openkraken/ipc-contract';
import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { providerServer } from '../../tests/provider-server.js';
import { protection } from '../../tests/provider-protection.js';
import {
  gitlabIssueFixture as issue,
  gitlabIssueNoteFixture as note,
} from '../../tests/gitlab-fixtures.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-gitlab-issues-'));
const server = providerServer();
const repository = { owner: 'group/subgroup', name: 'project' };
const options = { repository, number: 7 };
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
async function setup(name: string, origin = 'https://gitlab.com') {
  const directory = join(root, name);
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  const state = { issues: [issue(7)], detail: issue(7), notes: [note()], notesReads: 0 };
  server.use(
    http.get(`${origin}/api/v4/user`, () => HttpResponse.json({ id: 73, username: 'contributor' })),
    http.get(`${origin}/api/v4/projects/:project`, ({ params }) => {
      expect(params.project).toBe('group/subgroup/project');
      return HttpResponse.json({ id: 77, path_with_namespace: 'group/subgroup/project' });
    }),
    http.get(`${origin}/api/v4/projects/77/issues`, ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get('per_page')).toBe('100');
      expect(url.searchParams.get('scope')).toBe('all');
      expect(url.searchParams.get('order_by')).toBe('created_at');
      expect(url.searchParams.get('sort')).toBe('desc');
      expect(request.headers.get('authorization')).toBe('Bearer issue-secret');
      return HttpResponse.json(state.issues);
    }),
    http.get(`${origin}/api/v4/projects/77/issues/7`, () => HttpResponse.json(state.detail)),
    http.get(`${origin}/api/v4/projects/77/issues/7/notes`, ({ request }) => {
      state.notesReads++;
      const url = new URL(request.url);
      expect(url.searchParams.get('per_page')).toBe('100');
      expect(url.searchParams.get('sort')).toBe('asc');
      expect(url.searchParams.get('order_by')).toBe('created_at');
      return HttpResponse.json(state.notes);
    }),
  );
  const account = (await providers.connect({ provider: 'gitlab', origin, token: 'issue-secret' }))
    .accounts[0]!;
  return { providers, account, origin, state };
}
test('GitLab issues preserve native confidentiality, nullable locks and type across subgroup pages', async () => {
  const { providers, account, state } = await setup('pages', 'https://gitlab.example.test');
  const result = await providers.issues(account.id, { repository, state: 'open', page: 1 });
  expect(result).toMatchObject({
    issues: [
      {
        provider: 'gitlab',
        id: '2007',
        projectId: '77',
        number: 7,
        state: 'open',
        stateReason: null,
        confidential: true,
        locked: null,
        issueType: 'incident',
        dueDate: '2026-11-10',
        weight: 3,
        labels: ['bug', 'triage'],
        assignees: ['maintainer'],
        url: 'https://gitlab.example.test/group/subgroup/project/-/issues/7',
      },
    ],
    nextPage: null,
    limited: false,
  });
  state.issues = Array.from({ length: 100 }, (_, i) => issue(i + 1));
  await expect(
    providers.issues(account.id, { repository, state: 'all', page: 1 }),
  ).resolves.toMatchObject({ nextPage: 2, limited: false });
  await expect(
    providers.issues(account.id, { repository, state: 'all', page: 100 }),
  ).resolves.toMatchObject({ nextPage: null, limited: true });
});

test('GitLab issue details and notes retain literal descriptions, activity and internal visibility', async () => {
  const { providers, account, state } = await setup('details');
  state.detail = { ...issue(7), state: 'closed' };
  await expect(providers.issue(account.id, options)).resolves.toMatchObject({
    provider: 'gitlab',
    id: '2007',
    state: 'closed',
    stateReason: null,
    body: 'Literal <script>issue</script>',
    locked: null,
  });
  state.notes = [note(), { ...note(2), system: true }];
  await expect(providers.issueComments(account.id, { ...options, page: 1 })).resolves.toEqual({
    comments: [
      {
        id: '1',
        author: 'reviewer',
        body: 'Literal <script>note</script>',
        createdAt: '2026-10-01T12:00:00Z',
        updatedAt: '2026-10-02T12:00:00Z',
        provider: 'gitlab',
        system: false,
        internal: true,
        confidential: true,
        noteType: 'DiscussionNote',
      },
      {
        id: '2',
        author: 'reviewer',
        body: 'Literal <script>note</script>',
        createdAt: '2026-10-01T12:00:00Z',
        updatedAt: '2026-10-02T12:00:00Z',
        provider: 'gitlab',
        system: true,
        internal: true,
        confidential: true,
        noteType: 'DiscussionNote',
      },
    ],
    nextPage: null,
    limited: false,
  });
});

test('GitLab issue and note reads reject foreign identities, duplicates, changed visibility and oversized metadata', async () => {
  const { providers, account, origin, state } = await setup('guards');
  for (const extra of [
    { project_id: 88 },
    { iid: 8 },
    { description: 'x'.repeat(262145) },
    { confidential: 'yes' },
    { due_date: '2026-02-30' },
  ]) {
    server.use(
      http.get(`${origin}/api/v4/projects/77/issues/7`, () =>
        HttpResponse.json({ ...issue(7), ...extra }),
      ),
    );
    await expect(providers.issue(account.id, options)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
    });
    await expect(
      providers.issueComments(account.id, { ...options, page: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  }
  expect(state.notesReads).toBe(0);
  server.use(
    http.get(`${origin}/api/v4/projects/77/issues/7`, () => HttpResponse.json(state.detail)),
  );
  for (const extra of [
    { project_id: 88 },
    { noteable_id: 9999 },
    { noteable_iid: 8 },
    { noteable_type: 'MergeRequest' },
    { body: 'x'.repeat(262145) },
    { internal: 'yes' },
  ]) {
    server.use(
      http.get(`${origin}/api/v4/projects/77/issues/7/notes`, () =>
        HttpResponse.json([{ ...note(), ...extra }]),
      ),
    );
    await expect(
      providers.issueComments(account.id, { ...options, page: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  }
  for (const entries of [[note(), note()], Array.from({ length: 101 }, (_, i) => note(i + 1))]) {
    server.use(
      http.get(`${origin}/api/v4/projects/77/issues/7/notes`, () => HttpResponse.json(entries)),
    );
    await expect(
      providers.issueComments(account.id, { ...options, page: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  }
  server.use(
    http.get(`${origin}/api/v4/projects/77/issues/7/notes`, () => {
      state.detail.confidential = false;
      return HttpResponse.json([note()]);
    }),
  );
  await expect(providers.issueComments(account.id, { ...options, page: 1 })).rejects.toMatchObject({
    code: 'STALE_PROVIDER_ISSUE',
  });
});

test('GitLab issue filters and raw-page limits remain explicit and optional note metadata stays unknown', async () => {
  const { providers, account, origin, state } = await setup('limits');
  for (const entries of [
    [issue(7), issue(7)],
    [issue(7), { ...issue(8), iid: 7 }],
    [{ ...issue(7), project_id: 88 }],
    Array.from({ length: 101 }, (_, i) => issue(i + 1)),
    [{ ...issue(7), labels: Array.from({ length: 101 }, () => 'bug') }],
  ]) {
    server.use(http.get(`${origin}/api/v4/projects/77/issues`, () => HttpResponse.json(entries)));
    await expect(
      providers.issues(account.id, { repository, state: 'all', page: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  }
  server.use(
    http.get(`${origin}/api/v4/projects/77/issues`, ({ request }) => {
      expect(new URL(request.url).searchParams.get('state')).toBe('closed');
      return HttpResponse.json(state.issues);
    }),
  );
  await expect(
    providers.issues(account.id, { repository, state: 'closed', page: 1 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  state.issues = [{ ...issue(7), state: 'closed' }];
  await expect(
    providers.issues(account.id, { repository, state: 'closed', page: 1 }),
  ).resolves.toMatchObject({ issues: [{ state: 'closed' }] });
  server.use(
    http.get(`${origin}/api/v4/projects/77/issues/7/notes`, () =>
      HttpResponse.json([
        {
          ...note(),
          author: null,
          noteable_iid: null,
          internal: undefined,
          confidential: undefined,
          type: undefined,
        },
      ]),
    ),
  );
  await expect(providers.issueComments(account.id, { ...options, page: 1 })).resolves.toMatchObject(
    { comments: [{ author: null, internal: null, confidential: null, noteType: null }] },
  );
  server.use(
    http.get(`${origin}/api/v4/projects/77/issues/7/notes`, () =>
      HttpResponse.json(Array.from({ length: 100 }, (_, i) => note(i + 1))),
    ),
  );
  await expect(providers.issueComments(account.id, { ...options, page: 1 })).resolves.toMatchObject(
    { nextPage: 2, limited: false },
  );
  await expect(
    providers.issueComments(account.id, { ...options, page: 100 }),
  ).resolves.toMatchObject({ nextPage: null, limited: true });
});

test('GitLab issue reads cancel obsolete requests and never forward provider errors or write through the GitHub adapter', async () => {
  const { providers, account, origin } = await setup('cancel');
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  server.use(
    http.get(`${origin}/api/v4/projects/77/issues`, async ({ request }) => {
      started();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return HttpResponse.json([]);
    }),
  );
  const controller = new AbortController();
  const pending = providers.issues(
    account.id,
    { repository, state: 'open', page: 1 },
    controller.signal,
  );
  await began;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  server.use(
    http.get(`${origin}/api/v4/projects/77/issues/7`, () =>
      HttpResponse.json({ message: 'issue-secret' }, { status: 403 }),
    ),
  );
  await expect(providers.issue(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_AUTH',
  });
  await expect(providers.issue(account.id, options)).rejects.not.toThrow('issue-secret');
  await expect(
    providers.writeIssue(account.id, { action: 'create', repository, title: 'Test', body: 'Body' }),
  ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
});

test('GitLab issue IPC keeps native metadata strict and nested issue URLs distinct from GitHub URLs', async () => {
  const { providers, account } = await setup('ipc');
  const issue = await providers.issue(account.id, options);
  expect(resultSchema.safeParse({ kind: 'providerIssue', issue }).success).toBe(true);
  for (const url of [
    'https://gitlab.com/group/subgroup/project/-/issues/7?token=secret',
    'http://gitlab.com/group/subgroup/project/-/issues/7',
    'https://gitlab.com/group/%2fproject/-/issues/7',
    'https://gitlab.com/group/project/issues/7',
  ])
    expect(
      resultSchema.safeParse({ kind: 'providerIssue', issue: { ...issue, url } }).success,
    ).toBe(false);
  expect(
    resultSchema.safeParse({ kind: 'providerIssue', issue: { ...issue, token: 'secret' } }).success,
  ).toBe(false);
  const request = {
    id: '00000000-0000-4000-8000-000000000000',
    method: 'providerIssueComments',
    accountId: account.id,
    options: { ...options, page: 1 },
  };
  expect(requestSchema.safeParse(request).success).toBe(true);
  expect(serviceRequestSchema.safeParse(request).success).toBe(false);
  for (const extra of [{ page: 101 }, { endpoint: 'https://attacker.test' }, { number: 0 }])
    expect(
      requestSchema.safeParse({ ...request, options: { ...request.options, ...extra } }).success,
    ).toBe(false);
});
