import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { protection } from '../../tests/provider-protection.js';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';
import { GitHubOAuth } from './src/github-device.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-providers-'));
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});
test('GitHub account validation stores a protected credential and returns metadata across restarts', async () => {
  const directory = join(root, 'connect');
  const vault = new ProviderVault(directory, protection());
  const providers = new ProviderService(directory, vault);
  server.use(
    http.get('https://api.github.com/user', ({ request }) => {
      expect(request.headers.get('authorization')).toBe('token fixture-pat');
      expect(request.headers.get('user-agent')).toContain('OpenKraken');
      return HttpResponse.json({ id: 123, login: 'fixture-user', name: 'Fixture User' });
    }),
  );
  expect(await providers.accounts()).toEqual({ keychainAvailable: true, accounts: [] });
  const connected = await providers.connect({
    provider: 'github',
    origin: 'https://github.com/',
    token: 'fixture-pat',
  });
  expect(connected.accounts).toEqual([
    {
      id: expect.stringMatching(/^[0-9a-f]{64}$/),
      provider: 'github',
      origin: 'https://github.com',
      providerUserId: '123',
      login: 'fixture-user',
    },
  ]);
  expect(JSON.stringify(connected)).not.toContain('fixture-pat');
  const manifest = await readFile(join(directory, 'provider-accounts.json'), 'utf8');
  expect(manifest).not.toContain('fixture-pat');
  const reopened = new ProviderService(directory, vault);
  expect(await reopened.accounts()).toEqual(connected);
  await reopened.disconnect(connected.accounts[0]!.id);
  expect((await reopened.accounts()).accounts).toEqual([]);
  expect(await readdir(join(directory, 'provider-secrets'))).toEqual([]);
});

test('enterprise identity uses the selected HTTPS API origin and stable IDs survive login changes', async () => {
  const directory = join(root, 'enterprise');
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  let login = 'before-rename';
  server.use(
    http.get('https://git.example.test/api/v3/user', ({ request }) => {
      expect(request.headers.get('x-github-api-version')).toBe('2022-11-28');
      return HttpResponse.json({ id: 432, login });
    }),
  );
  const options = {
    provider: 'github' as const,
    origin: 'https://git.example.test',
    token: 'enterprise-pat',
  };
  const before = await providers.connect(options);
  login = 'after-rename';
  const after = await providers.connect(options);
  expect(after.accounts).toHaveLength(1);
  expect(after.accounts[0]!.id).toBe(before.accounts[0]!.id);
  expect(after.accounts[0]!.login).toBe('after-rename');
});

test('failed authentication and insecure origins never save tokens or expose provider error bodies', async () => {
  const directory = join(root, 'errors');
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  let calls = 0;
  server.use(
    http.all('*', () => {
      calls++;
      return HttpResponse.json({ message: 'echoed-fixture-secret' }, { status: 401 });
    }),
  );
  const options = {
    provider: 'github' as const,
    origin: 'https://github.com',
    token: 'echoed-fixture-secret',
  };
  await expect(providers.connect(options)).rejects.toMatchObject({
    code: 'PROVIDER_AUTH',
    message: 'The provider rejected this token. Check its validity and permissions.',
  });
  for (const origin of [
    'http://github.com',
    'https://user:password@github.com',
    'https://github.com/path',
    'https://github.com?token=secret',
  ])
    await expect(providers.connect({ ...options, origin })).rejects.toThrow();
  expect(calls).toBe(1);
  expect((await providers.accounts()).accounts).toEqual([]);
  await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('redirected, oversized and cancelled provider responses never create accounts', async () => {
  const directory = join(root, 'network');
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  const options = {
    provider: 'github' as const,
    origin: 'https://github.com',
    token: 'fixture-pat',
  };
  let escaped = false;
  server.use(
    http.get('https://api.github.com/user', () => HttpResponse.redirect('https://other.test/user')),
    http.get('https://other.test/user', () => {
      escaped = true;
      return HttpResponse.json({ id: 1, login: 'escaped' });
    }),
  );
  await expect(providers.connect(options)).rejects.toThrow();
  expect(escaped).toBe(false);
  server.use(
    http.get(
      'https://api.github.com/user',
      () => new HttpResponse('x'.repeat(4 * 1024 * 1024 + 1)),
    ),
  );
  await expect(providers.connect(options)).rejects.toThrow();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  server.use(
    http.get('https://api.github.com/user', async ({ request }) => {
      entered();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return HttpResponse.json({ id: 1, login: 'cancelled' });
    }),
  );
  const controller = new AbortController();
  const pending = expect(providers.connect(options, controller.signal)).rejects.toMatchObject({
    code: 'CANCELLED',
  });
  await started;
  controller.abort();
  await pending;
  expect((await providers.accounts()).accounts).toEqual([]);
  await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('imprecise provider user IDs cannot bind a credential to the wrong account', async () => {
  const directory = join(root, 'invalid-identity');
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  server.use(
    http.get('https://api.github.com/user', () =>
      HttpResponse.json({ id: Number.MAX_SAFE_INTEGER + 1, login: 'fixture-user' }),
    ),
  );
  await expect(
    providers.connect({ provider: 'github', origin: 'https://github.com', token: 'fixture-pat' }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  expect((await providers.accounts()).accounts).toEqual([]);
});

test('device sign-in protects refresh tokens and revalidates the same identity after rotation', async () => {
  const directory = join(root, 'device');
  const vault = new ProviderVault(directory, protection());
  let now = 100000,
    refreshes = 0;
  const oauth = new GitHubOAuth(undefined, () => now);
  const providers = new ProviderService(directory, vault, undefined, oauth, () => now);
  server.use(
    http.post('https://github.com/login/device/code', () =>
      HttpResponse.json({
        device_code: 'private-device',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      }),
    ),
    http.post('https://github.com/login/oauth/access_token', async ({ request }) => {
      const params = new URLSearchParams(await request.text());
      const refreshing = params.get('grant_type') === 'refresh_token';
      if (refreshing) {
        expect(params.get('refresh_token')).toBe(refreshes ? 'second-refresh' : 'first-refresh');
        refreshes++;
      }
      return HttpResponse.json({
        access_token: refreshing ? 'second-access' : 'first-access',
        token_type: 'bearer',
        scope: 'repo',
        expires_in: 120,
        refresh_token: refreshing ? 'second-refresh' : 'first-refresh',
        refresh_token_expires_in: 600,
      });
    }),
    http.get('https://api.github.com/user', ({ request }) => {
      expect(request.headers.get('authorization')).toBe(
        refreshes ? 'token second-access' : 'token first-access',
      );
      return HttpResponse.json({ id: 543, login: refreshes ? 'renamed-user' : 'fixture-user' });
    }),
  );
  const opened = await providers.deviceStart({
    clientId: 'fixture-client',
    privateRepositories: true,
  });
  now += 5000;
  const completed = await providers.devicePoll(opened.id);
  expect(completed.kind).toBe('providerAccounts');
  const account = (await providers.accounts()).accounts[0]!;
  expect(account).toMatchObject({ authentication: 'device', expiresAt: 225000 });
  for (const secret of ['private-device', 'first-access', 'first-refresh']) {
    expect(JSON.stringify(completed)).not.toContain(secret);
    expect(await readFile(join(directory, 'provider-accounts.json'), 'utf8')).not.toContain(secret);
  }
  const restarted = new ProviderService(directory, vault, undefined, oauth, () => now);
  now += 121000;
  server.use(
    http.get('https://api.github.com/user/repos', ({ request }) => {
      expect(request.headers.get('authorization')).toBe('token second-access');
      return HttpResponse.json([]);
    }),
  );
  expect(await restarted.repositories(account.id, 1)).toEqual({
    repositories: [],
    nextPage: null,
    limited: false,
  });
  const checked = await restarted.verify(account.id);
  expect(refreshes).toBe(1);
  expect(checked.accounts[0]).toMatchObject({
    id: account.id,
    login: 'renamed-user',
    expiresAt: 346000,
  });
  await restarted.verify(account.id);
  expect(refreshes).toBe(1);
  now += 121000;
  server.use(
    http.get('https://api.github.com/user', () =>
      HttpResponse.json({ id: 999, login: 'another-user' }),
    ),
  );
  await expect(restarted.verify(account.id)).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT' });
  expect((await restarted.accounts()).accounts).toEqual(checked.accounts);
});

test('connected accounts list bounded repository pages with canonical clone URLs and no credentials', async () => {
  const directory = join(root, 'repositories');
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  const pages: string[] = [];
  server.use(
    http.get('https://api.github.com/user', () =>
      HttpResponse.json({ id: 123, login: 'fixture-user' }),
    ),
    http.get('https://api.github.com/user/repos', ({ request }) => {
      const url = new URL(request.url);
      expect(request.headers.get('authorization')).toBe('token repository-secret');
      expect(url.searchParams.get('per_page')).toBe('100');
      expect(url.searchParams.get('sort')).toBe('full_name');
      expect(url.searchParams.get('direction')).toBe('asc');
      const page = url.searchParams.get('page')!;
      pages.push(page);
      return HttpResponse.json(
        Array.from({ length: page === '1' ? 100 : 1 }, (_, index) => ({
          id: (page === '1' ? 1 : 101) + index,
          name: `repo-${index}`,
          owner: { login: 'fixture-org' },
          private: index === 0,
          archived: false,
          description: index === 0 ? 'Fixture repository' : null,
          clone_url: 'https://repository-secret@attacker.test/untrusted.git',
        })),
      );
    }),
  );
  const account = (
    await providers.connect({
      provider: 'github',
      origin: 'https://github.com',
      token: 'repository-secret',
    })
  ).accounts[0]!;
  const first = await providers.repositories(account.id, 1);
  expect(first.repositories).toHaveLength(100);
  expect(first.nextPage).toBe(2);
  expect(first.limited).toBe(false);
  expect(first.repositories[0]).toEqual({
    id: '1',
    owner: 'fixture-org',
    name: 'repo-0',
    private: true,
    archived: false,
    description: 'Fixture repository',
    cloneUrl: 'https://github.com/fixture-org/repo-0.git',
  });
  const second = await providers.repositories(account.id, first.nextPage!);
  expect(second.repositories).toHaveLength(1);
  expect(second.nextPage).toBeNull();
  expect(pages).toEqual(['1', '2']);
  expect(JSON.stringify([first, second])).not.toContain('repository-secret');
  await providers.disconnect(account.id);
  await expect(providers.repositories(account.id, 1)).rejects.toMatchObject({
    code: 'PROVIDER_ACCOUNT',
  });
});

test('Enterprise repository pages reject malformed metadata and never follow provider pagination URLs', async () => {
  const directory = join(root, 'enterprise-repositories');
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  let invalid: 'owner' | 'id' | 'oversized' | undefined;
  let calls = 0;
  server.use(
    http.get('https://git.example.test/api/v3/user', () =>
      HttpResponse.json({ id: 123, login: 'fixture-user' }),
    ),
    http.get('https://git.example.test/api/v3/user/repos', ({ request }) => {
      calls++;
      expect(request.headers.get('x-github-api-version')).toBe('2022-11-28');
      expect(new URL(request.url).searchParams.get('page')).toBe('100');
      const data = Array.from({ length: invalid === 'oversized' ? 101 : 100 }, (_, index) => ({
        id: invalid === 'id' ? Number.MAX_SAFE_INTEGER + 1 : index + 1,
        name: 'project',
        owner: { login: invalid === 'owner' ? '../elsewhere' : 'team' },
        description: null,
        private: false,
        archived: true,
      }));
      return HttpResponse.json(data, {
        headers: { link: '<https://attacker.test/steal>; rel="next"' },
      });
    }),
  );
  const account = (
    await providers.connect({
      provider: 'github',
      origin: 'https://git.example.test',
      token: 'enterprise-secret',
    })
  ).accounts[0]!;
  const result = await providers.repositories(account.id, 100);
  expect(result).toMatchObject({ nextPage: null, limited: true });
  expect(result.repositories[0]!.cloneUrl).toBe('https://git.example.test/team/project.git');
  for (const value of ['owner', 'id', 'oversized'] as const) {
    invalid = value;
    await expect(providers.repositories(account.id, 100)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
    });
  }
  for (const page of [0, -1, 101, 1.5])
    await expect(providers.repositories(account.id, page)).rejects.toThrow();
  expect(calls).toBe(4);
});

test('native clone credentials are bound to the connected provider origin and a canonical repository URL', async () => {
  const directory = join(root, 'clone-credential');
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  let validations = 0;
  server.use(
    http.get('https://api.github.com/user', () => {
      validations++;
      return HttpResponse.json({ id: 123, login: 'fixture-user' });
    }),
  );
  const account = (
    await providers.connect({
      provider: 'github',
      origin: 'https://github.com',
      token: 'fixture-clone-token',
    })
  ).accounts[0]!;
  expect(await providers.gitCredential(account.id, 'https://github.com/team/project.git')).toEqual({
    url: 'https://github.com/team/project.git',
    username: 'fixture-user',
    password: 'fixture-clone-token',
  });
  const checked = validations;
  for (const url of [
    'https://github.com.evil.test/team/project.git',
    'http://github.com/team/project.git',
    'https://user@github.com/team/project.git',
    'https://github.com/team/../project.git',
    'https://github.com/team/project.git?token=x',
    'https://github.com/team/project',
  ])
    await expect(providers.gitCredential(account.id, url)).rejects.toMatchObject({
      code: 'PROVIDER_CLONE_URL',
    });
  expect(validations).toBe(checked);
  const controller = new AbortController();
  controller.abort();
  await expect(
    providers.gitCredential(account.id, 'https://github.com/team/project.git', controller.signal),
  ).rejects.toThrow();
});

test('saved accounts browse repository-scoped pull requests and validated details without following API links', async () => {
  const directory = join(root, 'pull-requests');
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  const repository = { owner: 'team', name: 'project' };
  const pr = (number: number) => ({
    number,
    title: `Pull ${number}`,
    state: 'open',
    draft: true,
    user: { login: 'contributor' },
    created_at: '2026-10-01T12:00:00Z',
    updated_at: '2026-10-02T12:00:00Z',
    merged_at: null,
    head: { ref: 'feature', label: 'fork:feature', sha: '1'.repeat(40) },
    base: { ref: 'main', label: 'team:main', sha: '2'.repeat(40) },
    html_url: 'https://secret@attacker.test',
    body: '<script>untrusted</script>\nDescription',
    merged: false,
    mergeable: null,
    mergeable_state: 'unknown',
    comments: 2,
    review_comments: 1,
    commits: 3,
    changed_files: 4,
    additions: 10,
    deletions: 5,
  });
  let detailInvalid = false;
  const pages: string[] = [];
  server.use(
    http.get('https://api.github.com/user', () =>
      HttpResponse.json({ id: 123, login: 'fixture-user' }),
    ),
    http.get('https://api.github.com/repos/team/project/pulls', ({ request }) => {
      const url = new URL(request.url);
      expect(request.headers.get('authorization')).toBe('token pr-secret');
      expect(url.searchParams.get('state')).toBe('open');
      expect(url.searchParams.get('sort')).toBe('created');
      expect(url.searchParams.get('direction')).toBe('desc');
      expect(url.searchParams.get('per_page')).toBe('100');
      const page = url.searchParams.get('page')!;
      pages.push(page);
      return HttpResponse.json(
        Array.from({ length: page === '1' ? 100 : 1 }, (_, index) =>
          pr(page === '1' ? index + 1 : 101),
        ),
        { headers: { link: '<https://attacker.test/steal>; rel="next"' } },
      );
    }),
    http.get('https://api.github.com/repos/team/project/pulls/101', () =>
      HttpResponse.json({ ...pr(detailInvalid ? 102 : 101), user: null }),
    ),
  );
  const account = (
    await providers.connect({
      provider: 'github',
      origin: 'https://github.com',
      token: 'pr-secret',
    })
  ).accounts[0]!;
  const first = await providers.pullRequests(account.id, { repository, state: 'open', page: 1 });
  expect(first.pullRequests).toHaveLength(100);
  expect(first.nextPage).toBe(2);
  expect(first.pullRequests[0]).toMatchObject({
    number: 1,
    title: 'Pull 1',
    draft: true,
    url: 'https://github.com/team/project/pull/1',
  });
  expect(first.pullRequests[0]).not.toHaveProperty('body');
  expect(
    (await providers.pullRequests(account.id, { repository, state: 'open', page: 2 })).nextPage,
  ).toBeNull();
  const detail = await providers.pullRequest(account.id, { repository, number: 101 });
  expect(detail).toMatchObject({
    number: 101,
    author: null,
    body: '<script>untrusted</script>\nDescription',
    mergeable: null,
    changedFiles: 4,
    head: { sha: '1'.repeat(40), ref: 'feature' },
  });
  expect(JSON.stringify([first, detail])).not.toContain('pr-secret');
  expect(JSON.stringify([first, detail])).not.toContain('attacker.test');
  expect(pages).toEqual(['1', '2']);
  detailInvalid = true;
  await expect(
    providers.pullRequest(account.id, { repository, number: 101 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  await providers.disconnect(account.id);
  await expect(
    providers.pullRequests(account.id, { repository, state: 'open', page: 1 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT' });
});

test('Enterprise PR pages enforce bounds and malformed responses fail without exposing diagnostics', async () => {
  const directory = join(root, 'enterprise-pulls');
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  const repository = { owner: 'team', name: 'project' };
  let invalid: 'number' | 'title' | 'state' | 'date' | 'count' | 'denied' | undefined;
  let calls = 0;
  server.use(
    http.get('https://git.example.test/api/v3/user', () =>
      HttpResponse.json({ id: 123, login: 'fixture-user' }),
    ),
    http.get('https://git.example.test/api/v3/repos/team/project/pulls', ({ request }) => {
      calls++;
      const url = new URL(request.url);
      expect(request.headers.get('x-github-api-version')).toBe('2022-11-28');
      expect(url.searchParams.get('state')).toBe('closed');
      expect(url.searchParams.get('page')).toBe('100');
      if (invalid === 'denied')
        return HttpResponse.json({ message: 'Never expose enterprise-secret' }, { status: 403 });
      return HttpResponse.json(
        Array.from({ length: invalid === 'count' ? 101 : 100 }, (_, i) => ({
          number: invalid === 'number' ? Number.MAX_SAFE_INTEGER + 1 : i + 1,
          title: invalid === 'title' ? 'x'.repeat(4097) : 'PR',
          state: invalid === 'state' ? 'unknown' : 'closed',
          draft: false,
          user: null,
          created_at: invalid === 'date' ? 'invalid' : '2026-10-01T00:00:00Z',
          updated_at: '2026-10-02T00:00:00Z',
          merged_at: '2026-10-02T00:00:00Z',
        })),
        { headers: { link: '<https://attacker.test/next>; rel="next"' } },
      );
    }),
  );
  const account = (
    await providers.connect({
      provider: 'github',
      origin: 'https://git.example.test',
      token: 'enterprise-secret',
    })
  ).accounts[0]!;
  const options = { repository, state: 'closed' as const, page: 100 };
  const page = await providers.pullRequests(account.id, options);
  expect(page).toMatchObject({ limited: true, nextPage: null });
  expect(page.pullRequests[0]!.url).toBe('https://git.example.test/team/project/pull/1');
  for (const value of ['number', 'title', 'state', 'date', 'count'] as const) {
    invalid = value;
    await expect(providers.pullRequests(account.id, options)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
    });
  }
  invalid = 'denied';
  await expect(providers.pullRequests(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_FORBIDDEN',
    message: 'The provider denied access. Check account permissions or rate limits.',
  });
  for (const page of [0, 101, 1.5])
    await expect(providers.pullRequests(account.id, { ...options, page })).rejects.toThrow();
  expect(calls).toBe(7);
});

test('cancelling PR browsing aborts the provider request and releases the account queue', async () => {
  const directory = join(root, 'cancel-pulls');
  const providers = new ProviderService(directory, new ProviderVault(directory, protection()));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let aborted = false;
  server.use(
    http.get('https://api.github.com/user', () =>
      HttpResponse.json({ id: 123, login: 'fixture-user' }),
    ),
    http.get('https://api.github.com/repos/team/project/pulls', async ({ request }) => {
      entered();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      return HttpResponse.json([]);
    }),
  );
  const account = (
    await providers.connect({
      provider: 'github',
      origin: 'https://github.com',
      token: 'pr-secret',
    })
  ).accounts[0]!;
  const controller = new AbortController();
  const pending = providers.pullRequests(
    account.id,
    { repository: { owner: 'team', name: 'project' }, state: 'open', page: 1 },
    controller.signal,
  );
  await started;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  await providers.idle();
  expect(aborted).toBe(true);
  expect((await providers.accounts()).accounts).toHaveLength(1);
});
