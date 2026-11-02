import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { protection } from '../../tests/provider-protection.js';
import { gitlabMergeFixture } from '../../tests/gitlab-fixtures.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-gitlab-create-'));
const server = setupServer();
const repository = { owner: 'group/subgroup', name: 'project' };
const source = { owner: 'contributor/subgroup', name: 'fork' };
const intent = {
  repository,
  source,
  head: 'feature/topic',
  base: 'main',
  title: 'Add feature',
  body: '<script>literal</script>',
  draft: true,
  maintainerCanModify: true,
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
  const state = {
    head: '1'.repeat(40),
    base: '2'.repeat(40),
    sourceId: 88,
    archived: false,
    posts: [] as unknown[],
  };
  server.use(
    http.get(`${origin}/api/v4/user`, () => HttpResponse.json({ id: 73, username: 'contributor' })),
    http.get(`${origin}/api/v4/projects/:project`, ({ params }) =>
      HttpResponse.json({
        id: params.project === 'group/subgroup/project' ? 77 : state.sourceId,
        path_with_namespace: params.project,
        default_branch: 'main',
        archived: state.archived,
      }),
    ),
    http.get(`${origin}/api/v4/projects/:project/repository/branches/:branch`, ({ params }) =>
      HttpResponse.json({
        name: params.branch,
        commit: { id: params.project === '77' ? state.base : state.head },
      }),
    ),
    http.post(`${origin}/api/v4/projects/88/merge_requests`, async ({ request }) => {
      const body = await request.json();
      state.posts.push(body);
      return HttpResponse.json(
        {
          ...gitlabMergeFixture(7),
          title: 'Draft: Add feature',
          draft: true,
          source_branch: intent.head,
          target_branch: intent.base,
          description: intent.body,
          allow_collaboration: true,
          sha: state.head,
        },
        { status: 201 },
      );
    }),
  );
  const account = (await service.connect({ provider: 'gitlab', origin, token: 'creation-secret' }))
    .accounts[0]!;
  return { service, account, origin, state };
}
test('GitLab fork creation reviews both project identities and tips and sends native source-project parameters', async () => {
  const { service, account, state } = await setup('create', 'https://gitlab.example.test');
  const preview = await service.previewMergeCreation(account.id, intent);
  expect(preview).toMatchObject({
    head: state.head,
    base: state.base,
    sourceProjectId: '88',
    targetProjectId: '77',
    title: 'Draft: Add feature',
  });
  const created = await service.createMergeRequest(account.id, {
    intent,
    revision: preview.revision,
  });
  expect(created).toMatchObject({
    number: 7,
    title: 'Draft: Add feature',
    draft: true,
    url: 'https://gitlab.example.test/group/subgroup/project/-/merge_requests/7',
  });
  expect(state.posts).toEqual([
    {
      source_branch: intent.head,
      target_branch: 'main',
      target_project_id: 77,
      title: 'Draft: Add feature',
      description: intent.body,
      allow_collaboration: true,
      remove_source_branch: false,
    },
  ]);
});
test('GitLab creation refuses changed tips, replaced project IDs, changed drafts and archived targets before posting', async () => {
  const { service, account, state } = await setup('stale');
  const preview = await service.previewMergeCreation(account.id, intent);
  const write = { intent, revision: preview.revision };
  state.head = '3'.repeat(40);
  await expect(service.createMergeRequest(account.id, write)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_CREATION',
  });
  state.head = '1'.repeat(40);
  state.base = '4'.repeat(40);
  await expect(service.createMergeRequest(account.id, write)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_CREATION',
  });
  state.base = '2'.repeat(40);
  state.sourceId = 89;
  await expect(service.createMergeRequest(account.id, write)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_CREATION',
  });
  state.sourceId = 88;
  await expect(
    service.createMergeRequest(account.id, { ...write, intent: { ...intent, body: 'Changed' } }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_CREATION' });
  state.archived = true;
  await expect(service.previewMergeCreation(account.id, intent)).rejects.toMatchObject({
    code: 'PROVIDER_CREATION_STATE',
  });
  state.archived = false;
  state.head = state.base;
  await expect(service.previewMergeCreation(account.id, intent)).rejects.toMatchObject({
    code: 'PROVIDER_PULL_EMPTY',
  });
  expect(state.posts).toHaveLength(0);
});
test('GitLab creation handles same-project branches, empty asynchronous fields, rejected and uncertain acknowledgments without retries', async () => {
  const { service, account, origin, state } = await setup('outcomes');
  let status = 201;
  let mismatch = false;
  let calls = 0;
  const same = { ...intent, source: repository, draft: false };
  server.use(
    http.get(`${origin}/api/v4/projects/77/repository/branches/:branch`, ({ params }) =>
      HttpResponse.json({
        name: params.branch,
        commit: { id: params.branch === same.head ? state.head : state.base },
      }),
    ),
    http.post(`${origin}/api/v4/projects/77/merge_requests`, () => {
      calls++;
      return HttpResponse.json(
        status === 201
          ? {
              ...gitlabMergeFixture(7),
              source_project_id: 77,
              source_branch: same.head,
              target_branch: same.base,
              title: same.title,
              description: mismatch ? 'Unexpected description' : same.body,
              draft: false,
              allow_collaboration: true,
              sha: null,
              diff_refs: {},
              changes_count: '',
            }
          : { message: 'creation-secret' },
        { status },
      );
    }),
  );
  const preview = await service.previewMergeCreation(account.id, same);
  const write = { intent: same, revision: preview.revision };
  expect(await service.createMergeRequest(account.id, write)).toMatchObject({
    number: 7,
    draft: false,
  });
  mismatch = true;
  await expect(service.createMergeRequest(account.id, write)).rejects.toMatchObject({
    code: 'PROVIDER_WRITE_UNCERTAIN',
  });
  for (const code of [409, 403, 503, 202]) {
    status = code;
    await expect(service.createMergeRequest(account.id, write)).rejects.toMatchObject({
      code: [409, 403].includes(code) ? 'PROVIDER_WRITE_REJECTED' : 'PROVIDER_WRITE_UNCERTAIN',
    });
  }
  expect(calls).toBe(6);
  const controller = new AbortController();
  controller.abort();
  await expect(
    service.createMergeRequest(account.id, write, controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls).toBe(6);
  await expect(
    service.previewMergeCreation(account.id, { ...same, title: 'Draft: contradictory' }),
  ).rejects.toMatchObject({ code: 'PROVIDER_CREATION_STATE' });
});
test('GitLab templates preserve provider keys and names, bound selection to a fresh listing and return literal content', async () => {
  const { service, account, origin } = await setup('templates');
  let changed = false;
  server.use(
    http.get(`${origin}/api/v4/projects/77/templates/merge_requests`, ({ request }) => {
      expect(new URL(request.url).searchParams.get('per_page')).toBe('100');
      return HttpResponse.json([
        { key: 'Feature', name: changed ? 'Changed' : 'Feature <script>name</script>' },
      ]);
    }),
    http.get(`${origin}/api/v4/projects/77/templates/merge_requests/Feature`, () =>
      HttpResponse.json({
        name: 'Feature <script>name</script>',
        content: '# Checklist\n<script>literal template</script>',
      }),
    ),
  );
  const templates = await service.mergeTemplates(account.id, { repository });
  expect(templates).toMatchObject({
    defaultBranch: 'main',
    templates: [{ key: 'Feature', name: 'Feature <script>name</script>' }],
    limited: false,
  });
  expect(
    await service.mergeTemplate(account.id, {
      repository,
      revision: templates.revision,
      key: 'Feature',
    }),
  ).toEqual({ body: '# Checklist\n<script>literal template</script>' });
  changed = true;
  await expect(
    service.mergeTemplate(account.id, { repository, revision: templates.revision, key: 'Feature' }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_TEMPLATE' });
});
test('GitLab template bounds and malformed identities fail without exposing raw provider text', async () => {
  const { service, account, origin } = await setup('template-bounds');
  let entries: unknown[] = Array.from({ length: 100 }, (_, index) => ({
    key: `Template${index}`,
    name: `Template ${index}`,
    extra: 'ignored',
  }));
  let content = 'x'.repeat(65537);
  server.use(
    http.get(`${origin}/api/v4/projects/77/templates/merge_requests`, () =>
      HttpResponse.json(entries),
    ),
    http.get(`${origin}/api/v4/projects/77/templates/merge_requests/Template0`, () =>
      HttpResponse.json({ name: 'Template 0', content }),
    ),
  );
  const list = await service.mergeTemplates(account.id, { repository });
  expect(list.templates).toHaveLength(50);
  expect(list.limited).toBe(true);
  await expect(
    service.mergeTemplate(account.id, { repository, key: 'Template0', revision: list.revision }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  content = 'valid';
  await expect(
    service.mergeTemplate(account.id, { repository, key: 'Template99', revision: list.revision }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_TEMPLATE' });
  entries = [
    { key: 'Same', name: 'One' },
    { key: 'Same', name: 'Two' },
  ];
  await expect(service.mergeTemplates(account.id, { repository })).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
  entries = [{ key: '..', name: 'creation-secret' }];
  await expect(service.mergeTemplates(account.id, { repository })).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
});
test('GitLab creation cancellation after dispatch remains uncertain and does not repeat the write', async () => {
  const { service, account, origin } = await setup('cancel-write');
  const preview = await service.previewMergeCreation(account.id, intent);
  const controller = new AbortController();
  let calls = 0;
  server.use(
    http.post(`${origin}/api/v4/projects/88/merge_requests`, () => {
      calls++;
      controller.abort();
      return HttpResponse.json({ message: 'creation-secret' }, { status: 503 });
    }),
  );
  await expect(
    service.createMergeRequest(
      account.id,
      { intent, revision: preview.revision },
      controller.signal,
    ),
  ).rejects.toMatchObject({ code: 'PROVIDER_WRITE_UNCERTAIN' });
  expect(calls).toBe(1);
});
