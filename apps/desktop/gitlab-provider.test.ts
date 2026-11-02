import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { protection } from '../../tests/provider-protection.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-gitlab-'));
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});

test('GitLab validates and protects a PAT independently of GitHub on the same host', async () => {
  const directory = join(root, 'identity');
  const vault = new ProviderVault(directory, protection());
  const service = new ProviderService(directory, vault);
  let username = 'gitlab-user';
  server.use(
    http.get('https://git.example.test/api/v4/user', ({ request }) => {
      expect(request.headers.get('authorization')).toBe('Bearer gitlab-secret');
      expect(request.headers.get('x-github-api-version')).toBeNull();
      return HttpResponse.json({ id: 123, username });
    }),
    http.get('https://git.example.test/api/v3/user', () =>
      HttpResponse.json({ id: 123, login: 'github-user' }),
    ),
  );
  const first = await service.connect({
    provider: 'gitlab',
    origin: 'https://git.example.test',
    token: 'gitlab-secret',
  });
  const account = first.accounts[0]!;
  expect(account).toMatchObject({ provider: 'gitlab', providerUserId: '123', login: username });
  const both = await service.connect({
    provider: 'github',
    origin: account.origin,
    token: 'github-secret',
  });
  expect(both.accounts).toHaveLength(2);
  expect(both.accounts[1]!.id).not.toBe(account.id);
  username = 'renamed-user';
  const reopened = new ProviderService(directory, vault);
  expect((await reopened.verify(account.id)).accounts[0]).toMatchObject({
    id: account.id,
    login: username,
  });
  expect(
    await reopened.gitCredential(account.id, 'https://git.example.test/team/project.git'),
  ).toEqual({
    url: 'https://git.example.test/team/project.git',
    username,
    password: 'gitlab-secret',
  });
  await expect(
    reopened.pullRequest(account.id, { repository: { owner: 'team', name: 'project' }, number: 1 }),
  ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
  expect(await readFile(join(directory, 'provider-accounts.json'), 'utf8')).not.toContain('secret');
  const secrets = await readdir(join(directory, 'provider-secrets'));
  for (const file of secrets)
    expect(
      (await readFile(join(directory, 'provider-secrets', file))).includes(
        Buffer.from('gitlab-secret'),
      ),
    ).toBe(false);
  await reopened.disconnect(account.id);
  expect((await reopened.accounts()).accounts.map((item) => item.provider)).toEqual(['github']);
});

test('GitLab rejects unsafe responses and honours server cooldowns without leaking secrets or retrying', async () => {
  const directory = join(root, 'failures');
  const service = new ProviderService(directory, new ProviderVault(directory, protection()));
  const options = {
    provider: 'gitlab' as const,
    origin: 'https://gitlab.com',
    token: 'secret-echo',
  };
  let calls = 0;
  server.use(
    http.get('https://gitlab.com/api/v4/user', () => {
      calls++;
      return HttpResponse.json({ message: options.token }, { status: 401 });
    }),
  );
  await expect(service.connect(options)).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
  expect(calls).toBe(1);
  server.use(
    http.get('https://gitlab.com/api/v4/user', () =>
      HttpResponse.redirect('https://other.test/user'),
    ),
  );
  await expect(service.connect(options)).rejects.toMatchObject({ code: 'PROVIDER_REQUEST' });
  server.use(http.get('https://gitlab.com/api/v4/user', () => new HttpResponse('x'.repeat(32769))));
  await expect(service.connect(options)).rejects.toMatchObject({ code: 'PROVIDER_REQUEST' });
  server.use(
    http.get('https://gitlab.com/api/v4/user', () => {
      calls++;
      return HttpResponse.json(
        { message: options.token },
        { status: 429, headers: { 'Retry-After': '60' } },
      );
    }),
  );
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(service.connect(options)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMIT',
      retryAt: expect.any(Number),
    });
  expect(calls).toBe(2);
  expect((await service.accounts()).accounts).toEqual([]);
});
