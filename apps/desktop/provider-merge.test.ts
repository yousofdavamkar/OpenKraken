import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';
import { protection } from '../../tests/provider-protection.js';
import { githubPullFixture } from '../../packages/test-fixtures/src/provider.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-pr-merge-'));
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});
const repository = { owner: 'team', name: 'project' };
const revision = {
  head: '1'.repeat(40),
  base: '2'.repeat(40),
  headRef: 'feature',
  baseRef: 'main',
};
const settings = {
  archived: false,
  allow_merge_commit: true,
  allow_squash_merge: true,
  allow_rebase_merge: true,
  permissions: { push: true },
};
async function setup(name: string, origin = 'https://github.com') {
  const directory = join(root, name),
    api = origin === 'https://github.com' ? 'https://api.github.com' : `${origin}/api/v3`;
  server.use(http.get(`${api}/user`, () => HttpResponse.json({ id: 321, login: 'reviewer' })));
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  const account = (await providers.connect({ provider: 'github', origin, token: 'merge-secret' }))
    .accounts[0]!;
  return { providers, account, api };
}
test('PR merge preview exposes allowed methods and each confirmed merge sends the reviewed head SHA', async () => {
  const { providers, account, api } = await setup('merge', 'https://git.example.test');
  const writes: unknown[] = [];
  server.use(
    http.get(`${api}/repos/team/project`, () => HttpResponse.json(settings)),
    http.get(`${api}/repos/team/project/pulls/1`, () => HttpResponse.json(githubPullFixture())),
    http.put(`${api}/repos/team/project/pulls/1/merge`, async ({ request }) => {
      expect(request.headers.get('x-github-api-version')).toBe('2022-11-28');
      writes.push(await request.json());
      return HttpResponse.json({
        merged: true,
        sha: '3'.repeat(40),
        message: 'Do not expose merge-secret',
      });
    }),
  );
  expect(await providers.previewMerge(account.id, { repository, number: 1 })).toMatchObject({
    pullRequest: { number: 1 },
    methods: ['merge', 'squash', 'rebase'],
    canPush: true,
    archived: false,
  });
  expect(writes).toEqual([]);
  for (const method of ['merge', 'squash', 'rebase'] as const) {
    const message =
      method === 'rebase' ? {} : { commitTitle: 'Reviewed change', commitMessage: 'Extra context' };
    expect(
      await providers.mergePull(account.id, {
        repository,
        number: 1,
        revision,
        method,
        ...message,
      }),
    ).toEqual({ sha: '3'.repeat(40) });
    expect(writes.at(-1)).toEqual({
      sha: revision.head,
      merge_method: method,
      ...(method === 'rebase'
        ? {}
        : { commit_title: 'Reviewed change', commit_message: 'Extra context' }),
    });
  }
  expect(writes).toHaveLength(3);
});

test.each([
  ['head', 'STALE_PROVIDER_PULL'],
  ['base', 'STALE_PROVIDER_PULL'],
  ['retarget', 'STALE_PROVIDER_PULL'],
  ['closed', 'PROVIDER_PULL_CLOSED'],
  ['draft', 'PROVIDER_PULL_DRAFT'],
  ['conflict', 'PROVIDER_MERGE_NOT_READY'],
  ['unknown', 'PROVIDER_MERGE_NOT_READY'],
  ['archived', 'PROVIDER_MERGE_ACCESS'],
  ['permission', 'PROVIDER_MERGE_ACCESS'],
  ['method', 'PROVIDER_MERGE_METHOD'],
] as const)('merge refuses changed %s state before writing', async (mode, code) => {
  const { providers, account, api } = await setup(`guard-${mode}`);
  const pull = githubPullFixture();
  let writes = 0;
  server.use(
    http.get(`${api}/repos/team/project`, () =>
      HttpResponse.json({
        ...settings,
        archived: mode === 'archived',
        permissions: { push: mode !== 'permission' },
        allow_squash_merge: mode !== 'method',
      }),
    ),
    http.get(`${api}/repos/team/project/pulls/1`, () =>
      HttpResponse.json({
        ...pull,
        head: { ...pull.head, sha: mode === 'head' ? '9'.repeat(40) : revision.head },
        base: {
          ...pull.base,
          sha: mode === 'base' ? '9'.repeat(40) : revision.base,
          ref: mode === 'retarget' ? 'release' : revision.baseRef,
        },
        state: mode === 'closed' ? 'closed' : 'open',
        draft: mode === 'draft',
        mergeable: mode === 'conflict' ? false : mode === 'unknown' ? null : true,
      }),
    ),
    http.put(`${api}/repos/team/project/pulls/1/merge`, () => {
      writes++;
      return HttpResponse.json({});
    }),
  );
  await expect(
    providers.mergePull(account.id, { repository, number: 1, revision, method: 'squash' }),
  ).rejects.toMatchObject({ code });
  expect(writes).toBe(0);
});

test.each(['server', 'acknowledgment', 'cancel', 'protection', 'head-race', 'false'] as const)(
  'merge %s outcome never retries a PUT',
  async (mode) => {
    const { providers, account, api } = await setup(`write-${mode}`);
    const controller = new AbortController();
    let writes = 0;
    server.use(
      http.get(`${api}/repos/team/project`, () => HttpResponse.json(settings)),
      http.get(`${api}/repos/team/project/pulls/1`, () => HttpResponse.json(githubPullFixture())),
      http.put(`${api}/repos/team/project/pulls/1/merge`, async ({ request }) => {
        expect(await request.json()).toEqual({ sha: revision.head, merge_method: 'merge' });
        writes++;
        if (mode === 'cancel') controller.abort();
        return HttpResponse.json(
          { merged: mode !== 'false', sha: 'bad', message: 'merge-secret' },
          {
            status:
              mode === 'server'
                ? 500
                : mode === 'protection'
                  ? 405
                  : mode === 'head-race'
                    ? 409
                    : 200,
          },
        );
      }),
    );
    await expect(
      providers.mergePull(
        account.id,
        { repository, number: 1, revision, method: 'merge' },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      code: ['false', 'protection', 'head-race'].includes(mode)
        ? 'PROVIDER_MERGE_REJECTED'
        : 'PROVIDER_WRITE_UNCERTAIN',
    });
    expect(writes).toBe(1);
  },
);

test('preview validates settings, keeps unknown permissions explicit and cancellation prevents a merge', async () => {
  const { providers, account, api } = await setup('preview');
  let malformed = false,
    cancel = false,
    writes = 0;
  const controller = new AbortController();
  server.use(
    http.get(`${api}/repos/team/project`, () =>
      HttpResponse.json({
        ...settings,
        permissions: undefined,
        allow_rebase_merge: malformed ? 'yes' : false,
      }),
    ),
    http.get(`${api}/repos/team/project/pulls/1`, () => {
      if (cancel) controller.abort();
      return HttpResponse.json(githubPullFixture());
    }),
    http.put(`${api}/repos/team/project/pulls/1/merge`, () => {
      writes++;
      return HttpResponse.json({});
    }),
  );
  expect(await providers.previewMerge(account.id, { repository, number: 1 })).toMatchObject({
    methods: ['merge', 'squash'],
    canPush: null,
  });
  malformed = true;
  await expect(providers.previewMerge(account.id, { repository, number: 1 })).rejects.toMatchObject(
    { code: 'PROVIDER_RESPONSE' },
  );
  malformed = false;
  cancel = true;
  await expect(
    providers.mergePull(
      account.id,
      { repository, number: 1, revision, method: 'merge' },
      controller.signal,
    ),
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(writes).toBe(0);
});
