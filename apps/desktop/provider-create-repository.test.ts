import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { providerServer } from '../../tests/provider-server.js';
import { protection } from '../../tests/provider-protection.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';

const server = providerServer();
const hosts = [
  { provider: 'github', origin: 'https://github.com', api: 'https://api.github.com' },
  {
    provider: 'github',
    origin: 'https://code.example.test',
    api: 'https://code.example.test/api/v3',
  },
  {
    provider: 'gitlab',
    origin: 'https://gitlab.example.test',
    api: 'https://gitlab.example.test/api/v4',
  },
] as const;

test.each(hosts)(
  'creates a personal repository on $origin and checks the returned identity',
  async ({ provider, origin, api }) => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-create-repo-'));
    const service = new ProviderService(root, new ProviderVault(root, protection()));
    const github = provider === 'github';
    let login = 'sam';
    let scenario = 'ok';
    let posts = 0;
    const options = {
      owner: login,
      name: 'sample',
      description: 'Fixture',
      visibility: 'private',
      readme: true,
    } as const;
    server.use(
      http.get(api + '/user', () =>
        HttpResponse.json({ id: 17, [github ? 'login' : 'username']: login }),
      ),
      http.post(api + (github ? '/user/repos' : '/projects'), async ({ request }) => {
        posts++;
        expect(await request.json()).toEqual(
          github
            ? { name: 'sample', description: 'Fixture', private: true, auto_init: true }
            : {
                name: 'sample',
                path: 'sample',
                description: 'Fixture',
                visibility: 'private',
                initialize_with_readme: true,
              },
        );
        if (scenario === 'rejected') return HttpResponse.json({}, { status: 422 });
        if (scenario === 'lost') return HttpResponse.error();
        const owner = scenario === 'wrong owner' ? 'another' : login;
        return HttpResponse.json(
          github
            ? {
                id: 41,
                owner: { login: owner, id: 17 },
                name: 'sample',
                description: 'Fixture',
                private: scenario !== 'wrong visibility',
                archived: false,
              }
            : {
                id: 41,
                path_with_namespace: owner + '/sample',
                path: 'sample',
                description: 'Fixture',
                visibility: scenario === 'wrong visibility' ? 'public' : 'private',
                archived: false,
              },
          { status: 201 },
        );
      }),
    );
    try {
      const {
        accounts: [account],
      } = await service.connect({ provider, origin, token: 'fixture-token' });
      expect(await service.createRepository(account!.id, options)).toMatchObject({
        id: '41',
        owner: 'sam',
        name: 'sample',
        private: true,
        cloneUrl: origin + '/sam/sample.git',
      });
      for (scenario of ['wrong owner', 'wrong visibility', 'lost', 'rejected']) {
        await expect(service.createRepository(account!.id, options)).rejects.toMatchObject({
          code: scenario === 'rejected' ? 'PROVIDER_WRITE_REJECTED' : 'PROVIDER_WRITE_UNCERTAIN',
        });
      }
      login = 'renamed';
      await expect(service.createRepository(account!.id, options)).rejects.toMatchObject({
        code: 'PROVIDER_ACCOUNT',
      });
      expect(posts).toBe(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
