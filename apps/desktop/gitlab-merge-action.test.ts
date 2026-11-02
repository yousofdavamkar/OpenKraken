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
const root = await mkdtemp(join(tmpdir(), 'openkraken-gitlab-merge-action-'));
const server = setupServer();
const repository = { owner: 'group/subgroup', name: 'project' };
const target = { repository, number: 7 };
const intent = {
  ...target,
  head: '1'.repeat(40),
  squash: true,
  removeSourceBranch: false,
  mergeMessage: 'Merge message',
  squashMessage: 'Squash message',
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
    project: {
      id: 77,
      path_with_namespace: 'group/subgroup/project',
      archived: false,
      merge_method: 'merge',
      squash_option: 'default_off',
      only_allow_merge_if_pipeline_succeeds: true,
      only_allow_merge_if_all_discussions_are_resolved: true,
    },
    merge: {
      ...gitlabMergeFixture(7),
      detailed_merge_status: 'mergeable',
      user: { can_merge: true },
      squash: false,
      squash_on_merge: false,
      should_remove_source_branch: false,
      force_remove_source_branch: false,
      merge_after: null as string | null,
      merge_when_pipeline_succeeds: false,
    },
    head: '1'.repeat(40),
    base: '4'.repeat(40),
    protected: false,
    writes: [] as unknown[],
    status: 200,
    ackOpen: false,
  };
  server.use(
    http.get(`${origin}/api/v4/user`, () => HttpResponse.json({ id: 73, username: 'contributor' })),
    http.get(`${origin}/api/v4/projects/:project`, () => HttpResponse.json(state.project)),
    http.get(`${origin}/api/v4/projects/77/merge_requests/7`, () => HttpResponse.json(state.merge)),
    http.get(`${origin}/api/v4/projects/:project/repository/branches/:branch`, ({ params }) =>
      HttpResponse.json({
        name: params.branch,
        commit: { id: params.project === '88' ? state.head : state.base },
        protected: state.protected,
        default: params.branch === 'main',
      }),
    ),
    http.put(`${origin}/api/v4/projects/77/merge_requests/7/merge`, async ({ request }) => {
      state.writes.push(await request.json());
      return HttpResponse.json(
        state.status === 200
          ? {
              ...state.merge,
              state: state.ackOpen ? 'opened' : 'merged',
              merged_at: state.ackOpen ? null : '2026-11-02T00:00:00Z',
              squash: true,
              squash_on_merge: true,
              merge_commit_sha: '5'.repeat(40),
              squash_commit_sha: '6'.repeat(40),
            }
          : { message: 'merge-secret' },
        { status: state.status },
      );
    }),
  );
  const account = (await service.connect({ provider: 'gitlab', origin, token: 'merge-secret' }))
    .accounts[0]!;
  return { service, account, origin, state };
}
test('GitLab merge reviews actual tips and project policy, then sends an explicit SHA-conditional direct merge once', async () => {
  const { service, account, state } = await setup('merge', 'https://gitlab.example.test');
  const snapshot = await service.mergeRequestMergeState(account.id, target);
  expect(snapshot).toMatchObject({
    head: state.head,
    base: state.base,
    policy: { method: 'merge', squash: 'default_off' },
    canMerge: true,
  });
  const preview = await service.previewMergeRequestMerge(account.id, intent);
  const result = await service.mergeMergeRequest(account.id, {
    intent,
    revision: preview.revision,
  });
  expect(result).toMatchObject({
    mergeRequest: { number: 7, state: 'merged' },
    mergeCommit: '5'.repeat(40),
    squashCommit: '6'.repeat(40),
  });
  expect(state.writes).toEqual([
    {
      sha: state.head,
      squash: true,
      should_remove_source_branch: false,
      auto_merge: false,
      merge_when_pipeline_succeeds: false,
      merge_commit_message: 'Merge message',
      squash_commit_message: 'Squash message',
    },
  ]);
});
test('GitLab merge refuses changed target tips, policy, review messages and retargeted branches without a write', async () => {
  const { service, account, state } = await setup('stale');
  const preview = await service.previewMergeRequestMerge(account.id, intent);
  const write = { intent, revision: preview.revision };
  state.base = '7'.repeat(40);
  await expect(service.mergeMergeRequest(account.id, write)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_MERGE',
  });
  state.base = '4'.repeat(40);
  state.project.squash_option = 'default_on';
  await expect(service.mergeMergeRequest(account.id, write)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_MERGE',
  });
  state.project.squash_option = 'default_off';
  await expect(
    service.mergeMergeRequest(account.id, {
      ...write,
      intent: { ...intent, mergeMessage: 'Changed' },
    }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_MERGE' });
  state.merge.target_branch = 'release';
  await expect(service.mergeMergeRequest(account.id, write)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_MERGE',
  });
  expect(state.writes).toHaveLength(0);
});
test('GitLab merge respects blocking state, squash rules, source deletion constraints and actual source tips', async () => {
  const { service, account, state } = await setup('blocked');
  const refuses = () =>
    expect(service.previewMergeRequestMerge(account.id, intent)).rejects.toMatchObject({
      code: 'PROVIDER_MERGE_STATE',
    });
  state.merge.draft = true;
  await refuses();
  state.merge.draft = false;
  state.merge.user.can_merge = false;
  await refuses();
  state.merge.user.can_merge = true;
  state.project.archived = true;
  await refuses();
  state.project.archived = false;
  state.merge.detailed_merge_status = 'ci_still_running';
  await refuses();
  state.merge.detailed_merge_status = 'mergeable';
  state.merge.merge_when_pipeline_succeeds = true;
  await refuses();
  state.merge.merge_when_pipeline_succeeds = false;
  state.merge.merge_after = '2999-01-01T00:00:00Z';
  await refuses();
  state.merge.merge_after = null;
  state.project.squash_option = 'never';
  await refuses();
  state.project.squash_option = 'always';
  await expect(
    service.previewMergeRequestMerge(account.id, {
      ...target,
      head: state.head,
      squash: false,
      removeSourceBranch: false,
    }),
  ).rejects.toMatchObject({ code: 'PROVIDER_MERGE_STATE' });
  state.project.squash_option = 'default_off';
  state.merge.force_remove_source_branch = true;
  await refuses();
  state.protected = true;
  await expect(
    service.previewMergeRequestMerge(account.id, { ...intent, removeSourceBranch: true }),
  ).rejects.toMatchObject({ code: 'PROVIDER_MERGE_STATE' });
  state.protected = false;
  expect(
    await service.previewMergeRequestMerge(account.id, { ...intent, removeSourceBranch: true }),
  ).toHaveProperty('revision');
  state.merge.source_branch = 'main';
  await expect(
    service.previewMergeRequestMerge(account.id, { ...intent, removeSourceBranch: true }),
  ).rejects.toMatchObject({ code: 'PROVIDER_MERGE_STATE' });
  state.merge.source_branch = 'feature';
  state.head = '8'.repeat(40);
  await expect(
    service.previewMergeRequestMerge(account.id, { ...intent, removeSourceBranch: true }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_MERGE' });
  expect(state.writes).toHaveLength(0);
});
test('GitLab fast-forward and semi-linear projects retain native strategies and do not invent missing result commits', async () => {
  const { service, account, origin, state } = await setup('strategies');
  const options = { ...target, head: state.head, squash: false, removeSourceBranch: true };
  state.project.merge_method = 'ff';
  state.project.squash_option = 'never';
  await expect(
    service.previewMergeRequestMerge(account.id, { ...options, mergeMessage: 'Cannot apply' }),
  ).rejects.toMatchObject({ code: 'PROVIDER_MERGE_STATE' });
  server.use(
    http.put(`${origin}/api/v4/projects/77/merge_requests/7/merge`, async ({ request }) => {
      state.writes.push(await request.json());
      return HttpResponse.json({
        ...state.merge,
        state: 'merged',
        merged_at: '2026-11-02T00:00:00Z',
        merge_commit_sha: null,
        squash_commit_sha: null,
      });
    }),
  );
  const preview = await service.previewMergeRequestMerge(account.id, options);
  expect(
    await service.mergeMergeRequest(account.id, { intent: options, revision: preview.revision }),
  ).toMatchObject({ mergeRequest: { state: 'merged' }, mergeCommit: null, squashCommit: null });
  expect(state.writes).toEqual([
    {
      sha: state.head,
      squash: false,
      should_remove_source_branch: true,
      auto_merge: false,
      merge_when_pipeline_succeeds: false,
    },
  ]);
  state.project.merge_method = 'rebase_merge';
  expect(await service.mergeRequestMergeState(account.id, target)).toMatchObject({
    policy: { method: 'rebase_merge' },
  });
});
test('GitLab merge distinguishes refused writes from uncertain acknowledgments and cancellation without retrying', async () => {
  const { service, account, origin, state } = await setup('outcomes');
  const preview = await service.previewMergeRequestMerge(account.id, intent);
  const write = { intent, revision: preview.revision };
  for (const status of [403, 405, 409, 422, 503, 202]) {
    state.status = status;
    await expect(service.mergeMergeRequest(account.id, write)).rejects.toMatchObject({
      code: [403, 405, 409, 422].includes(status)
        ? 'PROVIDER_WRITE_REJECTED'
        : 'PROVIDER_WRITE_UNCERTAIN',
    });
  }
  state.status = 200;
  state.ackOpen = true;
  await expect(service.mergeMergeRequest(account.id, write)).rejects.toMatchObject({
    code: 'PROVIDER_WRITE_UNCERTAIN',
  });
  const early = new AbortController();
  early.abort();
  await expect(service.mergeMergeRequest(account.id, write, early.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(state.writes).toHaveLength(7);
  const late = new AbortController();
  let lateCalls = 0;
  server.use(
    http.put(`${origin}/api/v4/projects/77/merge_requests/7/merge`, () => {
      lateCalls++;
      late.abort();
      return HttpResponse.json({ message: 'merge-secret' }, { status: 503 });
    }),
  );
  await expect(service.mergeMergeRequest(account.id, write, late.signal)).rejects.toMatchObject({
    code: 'PROVIDER_WRITE_UNCERTAIN',
  });
  expect(lateCalls).toBe(1);
});
test('GitLab merge rejects foreign or inconsistent reads and refuses unspecified account permission', async () => {
  const { service, account, origin, state } = await setup('identities');
  state.project.path_with_namespace = 'another/project';
  await expect(service.mergeRequestMergeState(account.id, target)).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
  state.project.path_with_namespace = 'group/subgroup/project';
  state.merge.iid = 8;
  await expect(service.mergeRequestMergeState(account.id, target)).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
  state.merge.iid = 7;
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests/7`, () =>
      HttpResponse.json({ ...state.merge, user: null }),
    ),
  );
  await expect(service.previewMergeRequestMerge(account.id, intent)).rejects.toMatchObject({
    code: 'PROVIDER_MERGE_STATE',
  });
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests/7`, () => HttpResponse.json(state.merge)),
    http.get(`${origin}/api/v4/projects/77/repository/branches/main`, () => {
      state.merge.title = 'Changed during review';
      return HttpResponse.json({
        name: 'main',
        commit: { id: state.base },
        protected: true,
        default: true,
      });
    }),
  );
  await expect(service.mergeRequestMergeState(account.id, target)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_MERGE',
  });
  expect(state.writes).toHaveLength(0);
});
