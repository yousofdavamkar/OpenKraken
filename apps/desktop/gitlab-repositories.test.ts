import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { providerServer } from '../../tests/provider-server.js';
import { protection } from '../../tests/provider-protection.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-gitlab-repos-'));
const server = providerServer();
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
async function setup(name: string, origin = 'https://gitlab.com') {
  const directory = join(root, name);
  const service = new ProviderService(directory, new ProviderVault(directory, protection()));
  server.use(
    http.get(`${origin}/api/v4/user`, () => HttpResponse.json({ id: 73, username: 'gitlab-user' })),
  );
  const account = (
    await service.connect({ provider: 'gitlab', origin, token: 'repository-secret' })
  ).accounts[0]!;
  return { service, account };
}
function project(id: number, path = `group/subgroup/project-${id}`) {
  return {
    id,
    path_with_namespace: path,
    path: path.split('/').at(-1),
    description: null,
    visibility: 'private',
    archived: false,
    http_url_to_repo: `https://repository-secret@attacker.test/${path}.git`,
  };
}

test('GitLab repository pages preserve nested namespaces and use canonical clone targets with bounded manual paging', async () => {
  const { service, account } = await setup('pages');
  const pages: string[] = [];
  server.use(
    http.get('https://gitlab.com/api/v4/projects', ({ request }) => {
      const url = new URL(request.url);
      expect(request.headers.get('authorization')).toBe('Bearer repository-secret');
      expect(url.searchParams.get('membership')).toBe('true');
      expect(url.searchParams.get('pagination')).toBe('offset');
      expect(url.searchParams.get('per_page')).toBe('100');
      expect(url.searchParams.get('order_by')).toBe('id');
      expect(url.searchParams.get('sort')).toBe('asc');
      pages.push(url.searchParams.get('page')!);
      const first = pages.at(-1) === '1';
      return HttpResponse.json(
        first
          ? Array.from({ length: 100 }, (_, i) => project(i + 1))
          : [
              {
                ...project(101, 'group/subgroup/deep/project'),
                visibility: 'internal',
                archived: true,
                description: 'Nested project',
              },
            ],
        { headers: { Link: '<https://attacker.test/steal>; rel="next"' } },
      );
    }),
  );
  const first = await service.repositories(account.id, 1);
  expect(first.repositories).toHaveLength(100);
  expect(first.nextPage).toBe(2);
  expect(first.limited).toBe(false);
  expect(pages).toEqual(['1']);
  const second = await service.repositories(account.id, first.nextPage!);
  expect(second).toEqual({
    repositories: [
      {
        id: '101',
        owner: 'group/subgroup/deep',
        name: 'project',
        description: 'Nested project',
        private: true,
        archived: true,
        cloneUrl: 'https://gitlab.com/group/subgroup/deep/project.git',
        visibility: 'internal',
      },
    ],
    nextPage: null,
    limited: false,
  });
  expect(pages).toEqual(['1', '2']);
  expect(JSON.stringify([first, second])).not.toContain('repository-secret');
  expect(await service.gitCredential(account.id, second.repositories[0]!.cloneUrl)).toMatchObject({
    url: 'https://gitlab.com/group/subgroup/deep/project.git',
    password: 'repository-secret',
  });
});

test('self-managed GitLab pages retain safe long paths and refuse malformed metadata, traversal and page overflow', async () => {
  const origin = 'https://gitlab.example.test';
  const { service, account } = await setup('bounds', origin);
  let data: Record<string, unknown>[] = Array.from({ length: 100 }, (_, i) => project(i + 1));
  let calls = 0;
  server.use(
    http.get(`${origin}/api/v4/projects`, () => {
      calls++;
      return HttpResponse.json(data);
    }),
  );
  expect(await service.repositories(account.id, 100)).toMatchObject({
    nextPage: null,
    limited: true,
  });
  data = [
    {
      ...project(1, `group/${'s'.repeat(150)}/${'p'.repeat(150)}`),
      description: 'd'.repeat(2000),
      visibility: 'public',
    },
  ];
  expect((await service.repositories(account.id, 1)).repositories[0]).toMatchObject({
    owner: `group/${'s'.repeat(150)}`,
    name: 'p'.repeat(150),
    description: 'd'.repeat(2000),
    private: false,
  });
  for (const path of [
    'group/../project',
    'group/./project',
    'group//project',
    '/group/project',
    'group/sub%2Fgroup/project',
    'group/sub\\group/project',
    'group/project?token=secret',
    'single',
    `${'s'.repeat(2049)}/project`,
  ]) {
    data = [project(1, path)];
    await expect(service.repositories(account.id, 1)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
    });
  }
  for (const invalid of [
    [{ ...project(1), id: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...project(1), path: 'wrong' }],
    [{ ...project(1), visibility: 'unknown' }],
    [{ ...project(1), description: 'x'.repeat(4097) }],
    Array.from({ length: 101 }, (_, i) => project(i + 1)),
  ]) {
    data = invalid;
    await expect(service.repositories(account.id, 1)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
    });
  }
  const previous = calls;
  for (const page of [0, -1, 101, 1.5])
    await expect(service.repositories(account.id, page)).rejects.toThrow();
  expect(calls).toBe(previous);
});

test('GitLab revalidates repository pages with isolated validators and never substitutes cached data for errors', async () => {
  const { service, account } = await setup('cache');
  const validators: Array<string | null> = [];
  let failure = false;
  server.use(
    http.get('https://gitlab.com/api/v4/projects', ({ request }) => {
      const page = new URL(request.url).searchParams.get('page');
      const validator = request.headers.get('if-none-match');
      validators.push(validator);
      if (failure) return HttpResponse.json({ message: 'repository-secret' }, { status: 503 });
      if (validator) return new HttpResponse(null, { status: 304 });
      return HttpResponse.json([project(page === '1' ? 1 : 2)], {
        headers: { ETag: `"page-${page}"` },
      });
    }),
  );
  const first = await service.repositories(account.id, 1);
  expect(await service.repositories(account.id, 1)).toEqual(first);
  expect((await service.repositories(account.id, 2)).repositories[0]!.id).toBe('2');
  failure = true;
  await expect(service.repositories(account.id, 1)).rejects.toMatchObject({
    code: 'PROVIDER_REQUEST',
  });
  failure = false;
  await service.connect({
    provider: 'gitlab',
    origin: account.origin,
    token: 'replacement-secret',
  });
  expect(await service.repositories(account.id, 1)).toEqual(first);
  expect(validators).toEqual([null, '"page-1"', null, '"page-1"', null]);
});

test('GitLab repository reads reject redirects, oversized bodies and cancelled work without contacting foreign URLs', async () => {
  const { service, account } = await setup('transport');
  let escaped = false;
  server.use(
    http.get('https://gitlab.com/api/v4/projects', () =>
      HttpResponse.redirect('https://attacker.test/projects'),
    ),
    http.get('https://attacker.test/projects', () => {
      escaped = true;
      return HttpResponse.json([project(1)]);
    }),
  );
  await expect(service.repositories(account.id, 1)).rejects.toMatchObject({
    code: 'PROVIDER_REQUEST',
  });
  expect(escaped).toBe(false);
  server.use(
    http.get(
      'https://gitlab.com/api/v4/projects',
      () => new HttpResponse('x'.repeat(4 * 1024 * 1024 + 1)),
    ),
  );
  await expect(service.repositories(account.id, 1)).rejects.toMatchObject({
    code: 'PROVIDER_REQUEST',
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  server.use(
    http.get('https://gitlab.com/api/v4/projects', async ({ request }) => {
      entered();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return HttpResponse.json([project(1)]);
    }),
  );
  const controller = new AbortController();
  const pending = expect(
    service.repositories(account.id, 1, controller.signal),
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  await started;
  controller.abort();
  await pending;
});

test('GitLab quota headers stop subsequent identity and repository requests during the server cooldown', async () => {
  const { service, account } = await setup('rate-limit');
  let calls = 0;
  const reset = Math.ceil(Date.now() / 1000) + 120;
  server.use(
    http.get('https://gitlab.com/api/v4/projects', () => {
      calls++;
      return HttpResponse.json(
        { message: 'repository-secret' },
        { status: 429, headers: { 'RateLimit-Remaining': '0', 'RateLimit-Reset': String(reset) } },
      );
    }),
  );
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(service.repositories(account.id, 1)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMIT',
      retryAt: reset * 1000,
    });
  expect(calls).toBe(1);
  expect(await service.pollingPolicy(account.id)).toEqual({
    minimumIntervalMs: 0,
    blockedUntil: reset * 1000,
  });
});

test('GitLab no-store and revoked access discard conditional-read bodies', async () => {
  const { service, account } = await setup('cache-policy');
  const validators: Array<string | null> = [];
  let mode: 'no-store' | 'cache' | 'denied' = 'no-store';
  server.use(
    http.get('https://gitlab.com/api/v4/projects', ({ request }) => {
      validators.push(request.headers.get('if-none-match'));
      if (mode === 'denied')
        return HttpResponse.json({ message: 'repository-secret' }, { status: 403 });
      return HttpResponse.json([project(1)], {
        headers: {
          ETag: '"project"',
          ...(mode === 'no-store' ? { 'Cache-Control': 'no-store' } : {}),
        },
      });
    }),
  );
  await service.repositories(account.id, 1);
  await service.repositories(account.id, 1);
  mode = 'cache';
  await service.repositories(account.id, 1);
  mode = 'denied';
  await expect(service.repositories(account.id, 1)).rejects.toMatchObject({
    code: 'PROVIDER_AUTH',
  });
  mode = 'cache';
  await service.repositories(account.id, 1);
  expect(validators).toEqual([null, null, null, '"project"', null]);
});
