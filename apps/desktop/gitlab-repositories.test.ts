import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { protection } from '../../tests/provider-protection.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-gitlab-repos-'));
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
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
