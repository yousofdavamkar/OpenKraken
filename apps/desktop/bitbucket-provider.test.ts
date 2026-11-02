import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { protection } from '../../tests/provider-protection.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-bitbucket-'));
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});

test('Bitbucket refuses changed workspace identity, unsafe paths, duplicate rows and foreign pagination', async () => {
  const directory = join(root, 'invalid');
  const service = new ProviderService(directory, new ProviderVault(directory, protection()));
  const repository = {
    uuid: '{30000000-0000-4000-8000-000000000001}',
    full_name: 'fixture-team/project',
    workspace: { uuid: workspace.id, slug: workspace.slug },
    scm: 'git',
    is_private: true,
  };
  let data: unknown;
  server.use(
    http.get('https://api.bitbucket.org/2.0/user', () =>
      HttpResponse.json({ uuid: userId, display_name: 'Person' }),
    ),
    http.get(
      'https://api.bitbucket.org/2.0/repositories/fixture-team',
      () =>
        new HttpResponse(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }),
    ),
  );
  const account = (await service.connect(options)).accounts[0]!;
  for (const invalid of [
    { values: [{ ...repository, workspace: { ...repository.workspace, uuid: userId } }] },
    { values: [{ ...repository, full_name: 'fixture-team/../evil' }] },
    { values: [{ ...repository, full_name: 'other/project' }] },
    { values: [repository, repository] },
    { values: Array.from({ length: 101 }, () => repository) },
    { values: [repository], page: 2 },
    { values: [repository], next: 'https://attacker.test/steal?page=2' },
    { values: [repository], next: 'https://api.bitbucket.org/2.0/user?page=2' },
    {
      values: [repository],
      next: 'https://api.bitbucket.org/2.0/repositories/fixture-team?page=1',
    },
  ]) {
    data = invalid;
    await expect(
      service.bitbucketRepositories(account.id, { workspace, page: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  }
});

test('Bitbucket revalidates cached pages and clears private cached data after permission failures', async () => {
  const directory = join(root, 'cache');
  const service = new ProviderService(directory, new ProviderVault(directory, protection()));
  let status = 200;
  let conditional: string | null = null;
  server.use(
    http.get('https://api.bitbucket.org/2.0/user', () =>
      HttpResponse.json({ uuid: userId, display_name: 'Person' }),
    ),
    http.get('https://api.bitbucket.org/2.0/user/workspaces', ({ request }) => {
      conditional = request.headers.get('if-none-match');
      return status === 200
        ? HttpResponse.json(
            { values: [{ workspace: { uuid: workspace.id, slug: workspace.slug } }] },
            { headers: { ETag: '"workspace-1"' } },
          )
        : new HttpResponse(null, { status });
    }),
  );
  const account = (await service.connect(options)).accounts[0]!;
  const first = await service.bitbucketWorkspaces(account.id, 1);
  status = 304;
  expect(await service.bitbucketWorkspaces(account.id, 1)).toEqual(first);
  expect(conditional).toBe('"workspace-1"');
  status = 403;
  await expect(service.bitbucketWorkspaces(account.id, 1)).rejects.toMatchObject({
    code: 'PROVIDER_AUTH',
  });
  status = 304;
  await expect(service.bitbucketWorkspaces(account.id, 1)).rejects.toMatchObject({
    code: 'PROVIDER_REQUEST',
  });
  expect(conditional).toBeNull();
});

test('Bitbucket bounds responses, cancels reads, refuses redirects and honors cooldown without leaking provider text', async () => {
  const directory = join(root, 'transport');
  const service = new ProviderService(directory, new ProviderVault(directory, protection()));
  let calls = 0;
  let mode = 'auth';
  let dispatched!: () => void;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  server.use(
    http.get('https://api.bitbucket.org/2.0/user', async ({ request }) => {
      calls++;
      if (mode === 'redirect') return HttpResponse.redirect('https://attacker.test/user');
      if (mode === 'large') return new HttpResponse('x'.repeat(32769));
      if (mode === 'cancel') {
        dispatched();
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return HttpResponse.json({ uuid: userId, display_name: 'Person' });
      }
      return HttpResponse.json(
        { error: { message: options.token } },
        mode === 'rate' ? { status: 429, headers: { 'Retry-After': '60' } } : { status: 401 },
      );
    }),
  );
  for (const [next, code] of [
    ['auth', 'PROVIDER_AUTH'],
    ['redirect', 'PROVIDER_REQUEST'],
    ['large', 'PROVIDER_REQUEST'],
  ]) {
    mode = next!;
    await expect(service.connect(options)).rejects.toMatchObject({
      code,
      message: expect.not.stringContaining(options.token),
    });
  }
  mode = 'cancel';
  const controller = new AbortController();
  const cancelled = expect(service.connect(options, controller.signal)).rejects.toMatchObject({
    code: 'CANCELLED',
  });
  await started;
  controller.abort();
  await cancelled;
  mode = 'rate';
  for (let i = 0; i < 2; i++)
    await expect(service.connect(options)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMIT',
      retryAt: expect.any(Number),
    });
  expect(calls).toBe(5);
  expect((await service.accounts()).accounts).toEqual([]);
});
const options = {
  provider: 'bitbucket' as const,
  origin: 'https://bitbucket.org',
  token: 'bitbucket-secret',
};
const userId = '{10000000-0000-4000-8000-000000000001}';
const workspace = { id: '{20000000-0000-4000-8000-000000000001}', slug: 'fixture-team' };

test('Bitbucket protects a scoped API token, binds its UUID identity and supplies a static Git username', async () => {
  const directory = join(root, 'identity');
  const vault = new ProviderVault(directory, protection());
  const service = new ProviderService(directory, vault);
  let uuid = userId;
  let display_name = 'Fixture Person';
  let calls = 0;
  server.use(
    http.get('https://api.bitbucket.org/2.0/user', ({ request }) => {
      calls++;
      expect(request.headers.get('authorization')).toBe('Bearer bitbucket-secret');
      expect(request.headers.get('x-github-api-version')).toBeNull();
      return HttpResponse.json({ uuid, display_name });
    }),
  );
  const account = (await service.connect(options)).accounts[0]!;
  expect(account).toMatchObject({
    provider: 'bitbucket',
    providerUserId: userId,
    login: 'Fixture Person',
  });
  expect(await readFile(join(directory, 'provider-accounts.json'), 'utf8')).not.toContain(
    options.token,
  );
  const reopened = new ProviderService(directory, vault);
  display_name = 'Renamed Person';
  expect((await reopened.verify(account.id)).accounts[0]).toMatchObject({
    id: account.id,
    login: display_name,
  });
  expect(
    await reopened.gitCredential(account.id, 'https://bitbucket.org/team/project.git'),
  ).toEqual({
    url: 'https://bitbucket.org/team/project.git',
    username: 'x-bitbucket-api-token-auth',
    password: options.token,
  });
  await expect(
    reopened.gitCredential(account.id, 'https://other.test/team/project.git'),
  ).rejects.toMatchObject({ code: 'PROVIDER_CLONE_URL' });
  await expect(
    reopened.gitCredential(account.id, 'https://bitbucket.org/team/sub/project.git'),
  ).rejects.toMatchObject({ code: 'PROVIDER_CLONE_URL' });
  await expect(service.connect({ ...options, origin: 'https://other.test' })).rejects.toBeDefined();
  expect(calls).toBe(4);
  uuid = '{10000000-0000-4000-8000-000000000002}';
  await expect(reopened.verify(account.id)).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT' });
  await reopened.disconnect(account.id);
  expect((await reopened.accounts()).accounts).toEqual([]);
});

test('Bitbucket browses current workspace access and bounded repository pages using canonical clone URLs', async () => {
  const directory = join(root, 'repositories');
  const service = new ProviderService(directory, new ProviderVault(directory, protection()));
  server.use(
    http.get('https://api.bitbucket.org/2.0/user', () =>
      HttpResponse.json({ uuid: userId, display_name: 'Person' }),
    ),
    http.get('https://api.bitbucket.org/2.0/user/workspaces', ({ request }) => {
      expect(new URL(request.url).searchParams.get('pagelen')).toBe('100');
      return HttpResponse.json({
        page: 1,
        values: [{ administrator: false, workspace: { uuid: workspace.id, slug: workspace.slug } }],
      });
    }),
    http.get('https://api.bitbucket.org/2.0/repositories/fixture-team', ({ request }) => {
      const url = new URL(request.url);
      const page = Number(url.searchParams.get('page'));
      expect(url.searchParams.get('sort')).toBe('name');
      return HttpResponse.json({
        page,
        values: [
          {
            uuid: '{30000000-0000-4000-8000-000000000001}',
            full_name: 'fixture-team/project',
            slug: 'project',
            workspace: { uuid: workspace.id, slug: workspace.slug },
            scm: 'git',
            is_private: true,
            description: 'Project',
            links: { clone: [{ href: 'https://attacker.test/ignored.git' }] },
          },
        ],
        ...(page < 100
          ? {
              next: `https://api.bitbucket.org/2.0/repositories/fixture-team?page=${page + 1}&pagelen=100&sort=name`,
            }
          : { next: 'https://api.bitbucket.org/2.0/repositories/fixture-team?page=101' }),
      });
    }),
  );
  const account = (await service.connect(options)).accounts[0]!;
  expect(await service.bitbucketWorkspaces(account.id, 1)).toEqual({
    workspaces: [workspace],
    nextPage: null,
    limited: false,
  });
  const page = await service.bitbucketRepositories(account.id, { workspace, page: 1 });
  expect(page).toEqual({
    repositories: [
      {
        id: '{30000000-0000-4000-8000-000000000001}',
        owner: 'fixture-team',
        name: 'project',
        description: 'Project',
        private: true,
        visibility: 'private',
        archived: false,
        cloneUrl: 'https://bitbucket.org/fixture-team/project.git',
      },
    ],
    nextPage: 2,
    limited: false,
  });
  expect(await service.bitbucketRepositories(account.id, { workspace, page: 100 })).toMatchObject({
    nextPage: null,
    limited: true,
  });
  await expect(service.repositories(account.id, 1)).rejects.toMatchObject({
    code: 'PROVIDER_UNSUPPORTED',
  });
  await expect(
    service.issues(account.id, {
      repository: { owner: 'fixture-team', name: 'project' },
      state: 'open',
      page: 1,
    }),
  ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
});
