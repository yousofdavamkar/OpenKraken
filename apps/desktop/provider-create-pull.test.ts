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
const root = await mkdtemp(join(tmpdir(), 'openkraken-create-pr-'));
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});
const repository = { owner: 'team', name: 'project' };
const source = { owner: 'contributor', name: 'fork' };
const options = { repository, source, head: 'feature/nested', base: 'main' };
const revision = { head: '1'.repeat(40), base: '2'.repeat(40) };
async function setup(name: string, origin = 'https://github.com') {
  const directory = join(root, name),
    api = origin === 'https://github.com' ? 'https://api.github.com' : `${origin}/api/v3`;
  server.use(http.get(`${api}/user`, () => HttpResponse.json({ id: 321, login: 'reviewer' })));
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  const account = (await providers.connect({ provider: 'github', origin, token: 'create-secret' }))
    .accounts[0]!;
  return { providers, account, api };
}
test('creating a PR previews remote branches, rejects changed tips and sends the confirmed draft once', async () => {
  const { providers, account, api } = await setup('create', 'https://git.example.test');
  let head = revision.head;
  const posts: unknown[] = [];
  server.use(
    http.get(`${api}/repos/contributor/fork/branches/:branch`, ({ params }) => {
      expect(params.branch).toBe('feature/nested');
      return HttpResponse.json({ name: options.head, commit: { sha: head } });
    }),
    http.get(`${api}/repos/team/project/branches/main`, () =>
      HttpResponse.json({ name: 'main', commit: { sha: revision.base } }),
    ),
    http.post(`${api}/repos/team/project/pulls`, async ({ request }) => {
      expect(request.headers.get('x-github-api-version')).toBe('2022-11-28');
      const body = await request.json();
      posts.push(body);
      const pull = githubPullFixture(45);
      return HttpResponse.json(
        {
          ...pull,
          title: 'A useful change',
          draft: true,
          head: {
            ...pull.head,
            ref: options.head,
            repo: { owner: { login: source.owner }, name: source.name },
          },
          base: {
            ...pull.base,
            repo: { owner: { login: repository.owner }, name: repository.name },
          },
        },
        { status: 201 },
      );
    }),
  );
  expect(await providers.previewPull(account.id, options)).toEqual(revision);
  expect(posts).toEqual([]);
  const create = {
    ...options,
    revision,
    title: 'A useful change',
    body: '## Summary\nChange details',
    draft: true,
    maintainerCanModify: false,
  };
  head = '9'.repeat(40);
  await expect(providers.createPull(account.id, create)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_PULL',
  });
  expect(posts).toEqual([]);
  head = revision.head;
  expect(await providers.createPull(account.id, create)).toMatchObject({
    number: 45,
    title: 'A useful change',
    draft: true,
    url: 'https://git.example.test/team/project/pull/45',
  });
  expect(posts).toEqual([
    {
      title: create.title,
      body: create.body,
      head: 'contributor:feature/nested',
      head_repo: 'fork',
      base: 'main',
      draft: true,
      maintainer_can_modify: false,
    },
  ]);
});

test('templates are discovered from the default commit, ignore links and decode a selected pinned UTF-8 blob', async () => {
  const { providers, account, api } = await setup('templates');
  const sha = (char: string) => char.repeat(40);
  const body = '## Summary\nExplain the change.\n';
  server.use(
    http.get(`${api}/repos/team/project`, () => HttpResponse.json({ default_branch: 'main' })),
    http.get(`${api}/repos/team/project/branches/main`, () =>
      HttpResponse.json({ name: 'main', commit: { sha: revision.base } }),
    ),
    http.get(`${api}/repos/team/project/git/commits/${revision.base}`, () =>
      HttpResponse.json({ sha: revision.base, tree: { sha: sha('3') } }),
    ),
    http.get(`${api}/repos/team/project/git/trees/:sha`, ({ params }) => {
      const tree =
        params.sha === sha('3')
          ? [
              { path: '.github', type: 'tree', mode: '040000', sha: sha('4') },
              {
                path: 'PULL_REQUEST_TEMPLATE.md',
                type: 'blob',
                mode: '120000',
                sha: sha('5'),
                size: 12,
              },
              { path: 'README.md', type: 'blob', mode: '100644', sha: sha('5'), size: 10 },
            ]
          : params.sha === sha('4')
            ? [
                {
                  path: 'pull_request_template.md',
                  type: 'blob',
                  mode: '100644',
                  sha: sha('6'),
                  size: Buffer.byteLength(body),
                },
                { path: 'PULL_REQUEST_TEMPLATE', type: 'tree', mode: '040000', sha: sha('7') },
              ]
            : [{ path: 'bug.md', type: 'blob', mode: '100644', sha: sha('8'), size: 8 }];
      return HttpResponse.json({ sha: params.sha, tree, truncated: false });
    }),
    http.get(`${api}/repos/team/project/git/blobs/${sha('6')}`, () =>
      HttpResponse.json({
        sha: sha('6'),
        size: Buffer.byteLength(body),
        encoding: 'base64',
        content: Buffer.from(body).toString('base64'),
      }),
    ),
  );
  expect(await providers.pullTemplates(account.id, { repository })).toEqual({
    defaultBranch: 'main',
    revision: revision.base,
    limited: false,
    templates: [
      { path: '.github/pull_request_template.md', sha: sha('6'), size: Buffer.byteLength(body) },
      { path: '.github/PULL_REQUEST_TEMPLATE/bug.md', sha: sha('8'), size: 8 },
    ],
  });
  expect(
    await providers.pullTemplate(account.id, {
      repository,
      revision: revision.base,
      path: '.github/pull_request_template.md',
    }),
  ).toEqual({ body });
  await expect(
    providers.pullTemplate(account.id, {
      repository,
      revision: revision.base,
      path: 'PULL_REQUEST_TEMPLATE.md',
    }),
  ).rejects.toMatchObject({ code: 'PROVIDER_TEMPLATE' });
  await expect(
    providers.pullTemplate(account.id, { repository, revision: revision.base, path: 'README.md' }),
  ).rejects.toThrow();
});

test.each(['server', 'acknowledgment', 'cancel', 'rejected'] as const)(
  'PR creation handles %s without repeating its POST',
  async (mode) => {
    const { providers, account, api } = await setup(mode);
    const controller = new AbortController();
    let posts = 0;
    server.use(
      http.get(`${api}/repos/team/project/branches/:branch`, ({ params }) =>
        HttpResponse.json({
          name: params.branch,
          commit: { sha: params.branch === 'main' ? revision.base : revision.head },
        }),
      ),
      http.post(`${api}/repos/team/project/pulls`, async ({ request }) => {
        const body = await request.json();
        expect(body).toEqual({
          head: 'feature/nested',
          base: 'main',
          title: 'Change',
          body: '',
          draft: false,
          maintainer_can_modify: true,
        });
        posts++;
        if (mode === 'cancel') controller.abort();
        return HttpResponse.json(
          { message: 'create-secret', ...githubPullFixture(), head: { sha: '9'.repeat(40) } },
          { status: mode === 'server' ? 500 : mode === 'rejected' ? 422 : 201 },
        );
      }),
    );
    await expect(
      providers.createPull(
        account.id,
        {
          ...options,
          source: repository,
          revision,
          title: 'Change',
          body: '',
          draft: false,
          maintainerCanModify: true,
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      code: mode === 'rejected' ? 'PROVIDER_PULL_REJECTED' : 'PROVIDER_WRITE_UNCERTAIN',
    });
    expect(posts).toBe(1);
  },
);

test('creation refuses a changed base, equal branch tips and cancellation during preview before any POST', async () => {
  const { providers, account, api } = await setup('guards');
  const controller = new AbortController();
  let base = '8'.repeat(40),
    cancel = false,
    posts = 0;
  server.use(
    http.get(`${api}/repos/contributor/fork/branches/:branch`, () => {
      if (cancel) controller.abort();
      return HttpResponse.json({ name: options.head, commit: { sha: revision.head } });
    }),
    http.get(`${api}/repos/team/project/branches/main`, () =>
      HttpResponse.json({ name: 'main', commit: { sha: base } }),
    ),
    http.post(`${api}/repos/team/project/pulls`, () => {
      posts++;
      return HttpResponse.json({});
    }),
  );
  const input = {
    ...options,
    revision,
    title: 'Change',
    body: '',
    draft: false,
    maintainerCanModify: false,
  };
  await expect(providers.createPull(account.id, input)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_PULL',
  });
  base = revision.head;
  await expect(providers.previewPull(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_PULL_EMPTY',
  });
  base = revision.base;
  cancel = true;
  await expect(providers.createPull(account.id, input, controller.signal)).rejects.toMatchObject({
    code: 'CANCELLED',
  });
  expect(posts).toBe(0);
});

test.each(['large', 'encoding', 'utf8', 'mismatch'] as const)(
  'template reads reject %s blobs',
  async (mode) => {
    const { providers, account, api } = await setup(`template-${mode}`);
    const sha = '3'.repeat(40),
      blob = '4'.repeat(40);
    server.use(
      http.get(`${api}/repos/team/project/git/commits/${revision.base}`, () =>
        HttpResponse.json({ sha: revision.base, tree: { sha } }),
      ),
      http.get(`${api}/repos/team/project/git/trees/${sha}`, () =>
        HttpResponse.json({
          sha,
          truncated: false,
          tree: [
            {
              path: 'pull_request_template.md',
              type: 'blob',
              mode: '100644',
              sha: blob,
              size: mode === 'large' ? 65537 : 1,
            },
          ],
        }),
      ),
      http.get(`${api}/repos/team/project/git/blobs/${blob}`, () =>
        HttpResponse.json({
          sha: mode === 'mismatch' ? sha : blob,
          encoding: mode === 'encoding' ? 'none' : 'base64',
          size: 1,
          content: mode === 'utf8' ? '/w==' : 'eA==',
        }),
      ),
    );
    await expect(
      providers.pullTemplate(account.id, {
        repository,
        revision: revision.base,
        path: 'pull_request_template.md',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_TEMPLATE' });
  },
);

test('template discovery reports its cap and refuses malformed tree paths', async () => {
  const { providers, account, api } = await setup('template-limits');
  const treeSha = '3'.repeat(40),
    folderSha = '4'.repeat(40);
  let malformed = false;
  server.use(
    http.get(`${api}/repos/team/project`, () => HttpResponse.json({ default_branch: 'main' })),
    http.get(`${api}/repos/team/project/branches/main`, () =>
      HttpResponse.json({ name: 'main', commit: { sha: revision.base } }),
    ),
    http.get(`${api}/repos/team/project/git/commits/${revision.base}`, () =>
      HttpResponse.json({ sha: revision.base, tree: { sha: treeSha } }),
    ),
    http.get(`${api}/repos/team/project/git/trees/${treeSha}`, () =>
      HttpResponse.json({
        sha: treeSha,
        truncated: false,
        tree: [
          {
            path: malformed ? '../PULL_REQUEST_TEMPLATE' : 'PULL_REQUEST_TEMPLATE',
            mode: '040000',
            type: 'tree',
            sha: folderSha,
          },
        ],
      }),
    ),
    http.get(`${api}/repos/team/project/git/trees/${folderSha}`, () =>
      HttpResponse.json({
        sha: folderSha,
        truncated: false,
        tree: Array.from({ length: 60 }, (_, i) => ({
          path: `template-${i}.md`,
          mode: '100644',
          type: 'blob',
          sha: '5'.repeat(40),
          size: 1,
        })),
      }),
    ),
  );
  const result = await providers.pullTemplates(account.id, { repository });
  expect(result.templates).toHaveLength(50);
  expect(result.limited).toBe(true);
  malformed = true;
  await expect(providers.pullTemplates(account.id, { repository })).rejects.toMatchObject({
    code: 'PROVIDER_TEMPLATE',
  });
});
