import { afterAll, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';

const hasLfs = spawnSync('git', ['lfs', 'version']).status === 0;
if (process.env.OPENKRAKEN_LFS_TEST === '1' && !hasLfs)
  throw new Error('LFS acceptance requires git-lfs on PATH');
const root = await mkdtemp(join(tmpdir(), 'openkraken-lfs-'));
afterAll(() => rm(root, { recursive: true, force: true }));

test.skipIf(!hasLfs)(
  'LFS inventory distinguishes full checkouts, pointers and missing local objects without downloading',
  async () => {
    const path = createFixture(join(root, 'inventory'));
    fixtureGit(path, ['lfs', 'install', '--local', '--skip-smudge']);
    fixtureGit(path, ['lfs', 'track', '*.bin']);
    const name = 'asset\n雪.bin';
    await writeFile(join(path, name), 'large file contents\n');
    fixtureGit(path, ['add', '.']);
    fixtureGit(path, ['commit', '-m', 'LFS fixture']);
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(path);
      const state = await service.lfsState(repo.id);
      expect(state).toMatchObject({
        available: true,
        version: expect.stringMatching(/^git-lfs\//),
        locks: [],
      });
      expect(state.files).toEqual([
        {
          path: name,
          oid: '372920552fbf4fa7c97393b749bf061342eb1c1d13d743aca3f499794b7ef9b2',
          size: 20,
          checkout: true,
          downloaded: true,
        },
      ]);
      const pointer = fixtureGit(path, ['show', `HEAD:${name}`]) + '\n';
      await writeFile(join(path, name), pointer);
      expect((await service.lfsState(repo.id)).files[0]).toMatchObject({
        checkout: false,
        downloaded: true,
      });
      const oid = state.files[0]!.oid;
      await rm(join(repo.commonDir, 'lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid));
      const statusBeforeInspection = fixtureGit(path, ['status', '--porcelain']);
      expect((await service.lfsState(repo.id)).files[0]).toMatchObject({
        checkout: false,
        downloaded: false,
      });
      expect(await readFile(join(path, name), 'utf8')).toBe(pointer);
      expect(fixtureGit(path, ['status', '--porcelain'])).toBe(statusBeforeInspection);
    } finally {
      await service.dispose();
    }
  },
);

test.skipIf(!hasLfs)(
  'LFS inventory shows cached lock owners without refreshing the server',
  async () => {
    const { createServer } = await import('node:http');
    const { runGit } = await import('./src/runner.js');
    const path = createFixture(join(root, 'cached-locks'));
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, { 'Content-Type': 'application/vnd.git-lfs+json' });
      response.end(
        JSON.stringify({
          locks: [
            {
              id: 'lock-1',
              path: 'asset.bin',
              owner: { name: 'Fixture Owner' },
              locked_at: '2026-11-02T00:00:00Z',
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    fixtureGit(path, ['config', 'lfs.url', `http://127.0.0.1:${address.port}/lfs`]);
    const service = new RepositoryService('git');
    try {
      await runGit('git', ['lfs', 'locks', '--json'], { cwd: path });
      expect(requests).toBe(1);
      const repo = await service.open(path);
      const state = await service.lfsState(repo.id);
      expect(state.lockError).toBeUndefined();
      expect(state.locks).toEqual([
        {
          id: 'lock-1',
          path: 'asset.bin',
          owner: 'Fixture Owner',
          lockedAt: '2026-11-02T00:00:00Z',
        },
      ]);
      expect(requests).toBe(1);
    } finally {
      await service.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'missing Git LFS is reported while the repository remains readable',
  async () => {
    const path = createFixture(join(root, 'without-lfs'));
    const git = join(root, 'git-without-lfs');
    await writeFile(
      git,
      '#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = lfs ]; then\n    printf "git: \'lfs\' is not a git command. See \'git --help\'.\\n" >&2\n    exit 1\n  fi\ndone\nexec git "$@"\n',
      { mode: 0o755 },
    );
    const service = new RepositoryService(git);
    try {
      const repo = await service.open(path);
      expect(await service.lfsState(repo.id)).toEqual({ available: false, files: [], locks: [] });
      expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
    } finally {
      await service.dispose();
    }
  },
);
