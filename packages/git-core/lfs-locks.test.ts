import { afterAll, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';

const hasLfs = spawnSync('git', ['lfs', 'version']).status === 0;
if (process.env.OPENKRAKEN_LFS_TEST === '1' && !hasLfs)
  throw new Error('LFS acceptance requires git-lfs on PATH');
const root = await mkdtemp(join(tmpdir(), 'openkraken-lfs-locks-'));
afterAll(() => rm(root, { recursive: true, force: true }));

test.skipIf(!hasLfs)(
  'server lock refresh enforces TLS and refuses redirected LFS configuration',
  async () => {
    const { createServer } = await import('node:https');
    let requests = 0;
    const server = createServer(
      {
        key: await readFile(new URL('../test-fixtures/tls/localhost-test.key', import.meta.url)),
        cert: await readFile(new URL('../test-fixtures/tls/localhost-test.crt', import.meta.url)),
      },
      (_request, response) => {
        requests++;
        response.writeHead(200, { 'Content-Type': 'application/vnd.git-lfs+json' });
        response.end(JSON.stringify({ locks: [] }));
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const endpoint = `https://127.0.0.1:${address.port}/lfs`;
    const path = createFixture(join(root, 'tls'));
    fixtureGit(path, ['config', 'lfs.url', endpoint]);
    fixtureGit(path, ['config', `http.${endpoint}.sslVerify`, 'false']);
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(path);
      await expect(service.lfsLocks(repo.id, 'origin')).rejects.toMatchObject({
        code: 'TLS_CERTIFICATE_INVALID',
      });
      expect(requests).toBe(0);
      if (process.platform !== 'win32') {
        const { symlink } = await import('node:fs/promises');
        const outside = join(root, 'outside-lfsconfig');
        await writeFile(outside, `[lfs]\nurl=${endpoint}\n`);
        await symlink(outside, join(path, '.lfsconfig'));
        await expect(service.lfsLocks(repo.id, 'origin')).rejects.toMatchObject({
          code: 'LFS_CONFIG',
        });
        expect(requests).toBe(0);
        expect(await readFile(outside, 'utf8')).toBe(`[lfs]\nurl=${endpoint}\n`);
      }
    } finally {
      await service.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test.skipIf(!hasLfs)(
  'server lock refresh rejects duplicate or excessive results and cancels a stalled request',
  async () => {
    const lock = { id: 'same-id', path: 'asset.bin', owner: { name: 'Owner' } };
    let locks = [lock, lock];
    let malformed = false;
    let stall = false;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const server = createServer((_request, response) => {
      if (stall) {
        started();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/vnd.git-lfs+json' });
      response.end(malformed ? '{invalid json' : JSON.stringify({ locks }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const path = createFixture(join(root, 'limits'));
    fixtureGit(path, ['config', 'lfs.url', `http://127.0.0.1:${address.port}/lfs`]);
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(path);
      await expect(service.lfsLocks(repo.id, 'origin')).rejects.toMatchObject({
        code: 'LFS_LOCK_OUTPUT',
      });
      locks = Array.from({ length: 10001 }, (_, i) => ({ ...lock, id: String(i) }));
      await expect(service.lfsLocks(repo.id, 'origin')).rejects.toMatchObject({
        code: 'LFS_LOCK_OUTPUT',
      });
      await expect(service.lfsLocks(repo.id, 'missing')).rejects.toMatchObject({
        code: 'UNKNOWN_REMOTE',
      });
      stall = true;
      const controller = new AbortController();
      const cancelled = expect(
        service.lfsLocks(repo.id, 'origin', controller.signal),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      await waiting;
      controller.abort();
      await cancelled;
      stall = false;
      locks = [lock];
      expect((await service.lfsLocks(repo.id, 'origin')).locks).toHaveLength(1);
      malformed = true;
      await expect(service.lfsLocks(repo.id, 'origin')).rejects.toThrow();
    } finally {
      await service.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test.skipIf(!hasLfs)(
  'server lock refresh follows native pages, replaces old ownership and preserves checkout work',
  async () => {
    let owner = 'First Owner';
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url!);
      const url = new URL(request.url!, 'http://fixture.test');
      response.writeHead(200, { 'Content-Type': 'application/vnd.git-lfs+json' });
      response.end(
        JSON.stringify(
          url.searchParams.has('cursor')
            ? {
                locks: [
                  {
                    id: 'second-lock',
                    path: 'other.bin',
                    owner: { name: 'Other Owner' },
                    locked_at: '2026-11-02T00:00:00Z',
                  },
                ],
              }
            : {
                locks: [
                  {
                    id: 'first-lock',
                    path: 'asset.bin',
                    owner: { name: owner },
                    locked_at: '2026-11-02T00:00:00Z',
                  },
                ],
                next_cursor: 'page-two',
              },
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const endpoint = `http://127.0.0.1:${address.port}/lfs`;
    const path = createFixture(join(root, 'refresh'));
    fixtureGit(path, ['config', 'lfs.url', endpoint]);
    await writeFile(join(path, 'draft.txt'), 'retain local work\n');
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(path);
      const head = fixtureGit(path, ['rev-parse', 'HEAD']);
      const index = fixtureGit(path, ['ls-files', '--stage']);
      const initial = await service.lfsState(repo.id);
      expect(initial.locks).toEqual([]);
      expect(paths).toEqual([]);
      const started = Date.now();
      const result = await service.lfsLocks(repo.id, 'origin');
      expect(result).toMatchObject({
        remote: 'origin',
        endpoint,
        locks: [
          { id: 'first-lock', path: 'asset.bin', owner: 'First Owner' },
          { id: 'second-lock', path: 'other.bin', owner: 'Other Owner' },
        ],
      });
      expect(Date.parse(result.checkedAt)).toBeGreaterThanOrEqual(started);
      expect(paths).toHaveLength(2);
      expect(paths.every((value) => value.startsWith('/lfs/locks?'))).toBe(true);
      owner = 'New Owner';
      expect((await service.lfsLocks(repo.id, 'origin')).locks[0]?.owner).toBe('New Owner');
      const count = paths.length;
      expect((await service.lfsState(repo.id)).locks[0]?.owner).toBe('New Owner');
      expect(paths).toHaveLength(count);
      expect(await readFile(join(path, 'draft.txt'), 'utf8')).toBe('retain local work\n');
      expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(head);
      expect(fixtureGit(path, ['ls-files', '--stage'])).toBe(index);
    } finally {
      await service.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
