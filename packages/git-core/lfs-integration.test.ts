import { afterAll, expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { AskpassBroker } from './src/askpass.js';
import { RepositoryService } from './src/repository.js';
import { authenticatedRemote } from '../test-fixtures/src/authenticated-remote.js';

const hasLfs = spawnSync('git', ['lfs', 'version']).status === 0;
if (process.env.OPENKRAKEN_LFS_TEST === '1' && !hasLfs)
  throw new Error('LFS acceptance requires git-lfs on PATH');
const root = await mkdtemp(join(tmpdir(), 'openkraken-lfs-integration-'));
afterAll(() => rm(root, { recursive: true, force: true }));

test.skipIf(!hasLfs)(
  'saved-account pull keeps LFS authentication scoped and does not use configured credential stores',
  async () => {
    const content = Buffer.from('separate LFS host content\n');
    const oid = createHash('sha256').update(content).digest('hex');
    let endpoint = '';
    const authorization: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      authorization.push(request.headers.authorization);
      if (!request.headers.authorization) {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="separate LFS"' });
        response.end();
      } else if (request.url === '/lfs/objects/batch') {
        response.writeHead(200, { 'Content-Type': 'application/vnd.git-lfs+json' });
        response.end(
          JSON.stringify({
            transfer: 'basic',
            objects: [
              { oid, size: content.length, actions: { download: { href: `${endpoint}/object` } } },
            ],
          }),
        );
      } else {
        response.writeHead(200, { 'Content-Length': content.length });
        response.end(content);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    endpoint = `http://127.0.0.1:${address.port}/lfs`;
    const source = createFixture(join(root, 'provider-source'));
    const local = join(root, 'provider-local');
    fixtureGit(source, ['clone', '.', local]);
    await writeFile(join(source, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    await writeFile(
      join(source, 'asset.bin'),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`,
    );
    fixtureGit(source, ['add', '.']);
    fixtureGit(source, ['commit', '-m', 'Incoming provider LFS pointer']);
    const bare = join(root, 'provider-remote.git');
    fixtureGit(source, ['clone', '--bare', '.', bare]);
    const remote = await authenticatedRemote(bare, {
      basePath: '/team/project.git',
      password: 'fixture-provider-token',
    });
    fixtureGit(local, ['remote', 'set-url', 'origin', remote.url]);
    fixtureGit(local, ['lfs', 'install', '--local']);
    fixtureGit(local, ['config', 'lfs.url', endpoint]);
    const credentialFile = join(root, 'credential-store');
    await writeFile(
      credentialFile,
      endpoint.replace('http://', 'http://stored:stored-secret@') + '\n',
    );
    fixtureGit(local, ['config', 'credential.helper', `store --file="${credentialFile}"`]);
    const broker = new AskpassBroker(
      resolve(
        'apps/desktop/dist/helpers',
        process.platform === 'win32' ? 'openkraken-askpass.exe' : 'openkraken-askpass',
      ),
      () => {
        throw new Error('Saved credentials must not prompt');
      },
    );
    const service = new RepositoryService('git', { dataDir: join(root, 'provider-profile') });
    try {
      const repo = await service.open(local);
      const before = await service.workingState(repo.id);
      const options = { mode: 'ff-only' as const, revision: before.revision };
      const preview = await service.providerPullPreview(repo.id, options);
      const scope = await broker.open(randomUUID(), 'Pull upstream', undefined, {
        url: remote.url,
        ...remote.credentials,
      });
      await expect(
        service.pull(
          repo.id,
          options,
          undefined,
          undefined,
          { ...scope.environment, GIT_SSL_CAINFO: remote.certificate },
          { ...preview.target, username: remote.credentials.username },
        ),
      ).rejects.toThrow();
      scope.close();
      expect(remote.authenticated()).toBeGreaterThan(0);
      expect(authorization.length).toBeGreaterThan(0);
      expect(authorization.every((header) => header === undefined)).toBe(true);
      expect(fixtureGit(local, ['rev-parse', 'HEAD'])).toBe(before.head.oid);
      expect(await readFile(credentialFile, 'utf8')).toBe(
        endpoint.replace('http://', 'http://stored:stored-secret@') + '\n',
      );
    } finally {
      await broker.close();
      await service.dispose();
      await remote.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test.skipIf(!hasLfs).each(['ff-only', 'merge', 'rebase'] as const)(
  'ordinary %s pull authenticates LFS filters and checks out incoming objects',
  async (mode) => {
    const content = Buffer.from('incoming large object\n');
    const oid = createHash('sha256').update(content).digest('hex');
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`;
    let endpoint = '';
    let downloads = 0;
    const server = createServer((request, response) => {
      if (
        request.headers.authorization !==
        `Basic ${Buffer.from('fixture:fixture-secret').toString('base64')}`
      ) {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="LFS fixture"' });
        response.end();
      } else if (request.url === '/lfs/objects/batch') {
        response.writeHead(200, { 'Content-Type': 'application/vnd.git-lfs+json' });
        response.end(
          JSON.stringify({
            transfer: 'basic',
            objects: [
              { oid, size: content.length, actions: { download: { href: `${endpoint}/object` } } },
            ],
          }),
        );
      } else if (request.url === '/lfs/object') {
        downloads++;
        response.writeHead(200, { 'Content-Length': content.length });
        response.end(content);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    endpoint = `http://127.0.0.1:${address.port}/lfs`;
    const source = createFixture(join(root, mode + '-source'));
    const remote = join(root, mode + '-remote.git');
    fixtureGit(source, ['clone', '--bare', '.', remote]);
    const local = join(root, mode + '-local');
    fixtureGit(source, ['clone', remote, local]);
    fixtureGit(local, ['lfs', 'install', '--local']);
    fixtureGit(local, ['config', 'user.name', 'Fixture']);
    fixtureGit(local, ['config', 'user.email', 'fixture@example.test']);
    if (mode !== 'ff-only') {
      await writeFile(join(local, 'local.txt'), 'retained local work\n');
      fixtureGit(local, ['add', '.']);
      fixtureGit(local, ['commit', '-m', 'Local divergence']);
    }
    fixtureGit(local, ['config', 'credential.helper', '']);
    fixtureGit(local, ['config', 'lfs.url', endpoint]);
    await writeFile(join(source, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    await writeFile(join(source, 'asset.bin'), pointer);
    fixtureGit(source, ['add', '.']);
    fixtureGit(source, ['commit', '-m', 'Incoming LFS pointer']);
    fixtureGit(source, ['push', remote, 'main']);
    const prompts: string[] = [];
    const id = randomUUID();
    const broker = new AskpassBroker(
      resolve(
        'apps/desktop/dist/helpers',
        process.platform === 'win32' ? 'openkraken-askpass.exe' : 'openkraken-askpass',
      ),
      (event) => {
        if (event.type === 'authenticationPrompt') {
          prompts.push(event.kind);
          broker.answer(
            id,
            event.promptId,
            event.kind === 'username' ? 'fixture' : 'fixture-secret',
          );
        }
      },
    );
    const service = new RepositoryService('git', { dataDir: join(root, mode + '-profile') });
    try {
      const repo = await service.open(local);
      const before = await service.workingState(repo.id);
      const scope = await broker.open(id, 'Pull upstream');
      const result = await service.pull(
        repo.id,
        { mode, revision: before.revision },
        undefined,
        undefined,
        scope.environment,
      );
      scope.close();
      const remoteTip = fixtureGit(source, ['rev-parse', 'HEAD']);
      if (mode === 'ff-only') expect(result.head.oid).toBe(remoteTip);
      else {
        expect(fixtureGit(local, ['show', '-s', '--format=%P', 'HEAD']).split(' ')).toEqual(
          mode === 'merge' ? [before.head.oid, remoteTip] : [remoteTip],
        );
        expect(await readFile(join(local, 'local.txt'), 'utf8')).toBe('retained local work\n');
      }
      expect(await readFile(join(local, 'asset.bin'))).toEqual(content);
      expect(fixtureGit(local, ['show', 'HEAD:asset.bin']) + '\n').toBe(pointer);
      expect(result.status.entries).toEqual([]);
      expect(prompts).toContain('username');
      expect(prompts).toContain('secret');
      expect(downloads).toBe(1);
      expect((await service.lfsState(repo.id)).files).toContainEqual(
        expect.objectContaining({ path: 'asset.bin', oid, checkout: true, downloaded: true }),
      );
      await service.undo(repo.id);
      expect(fixtureGit(local, ['rev-parse', 'HEAD'])).toBe(before.head.oid);
      await expect(readFile(join(local, 'asset.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
      await service.undo(repo.id, true);
      expect(await readFile(join(local, 'asset.bin'))).toEqual(content);
      expect(downloads).toBe(1);
    } finally {
      await broker.close();
      await service.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test.skipIf(!hasLfs)(
  'ordinary pull refuses untrusted LFS TLS even with URL-specific verification disabled',
  async () => {
    const { createServer } = await import('node:https');
    const content = Buffer.from('untrusted object\n');
    const oid = createHash('sha256').update(content).digest('hex');
    let endpoint = '';
    let requests = 0;
    const server = createServer(
      {
        key: await readFile(new URL('../test-fixtures/tls/localhost-test.key', import.meta.url)),
        cert: await readFile(new URL('../test-fixtures/tls/localhost-test.crt', import.meta.url)),
      },
      (request, response) => {
        requests++;
        if (request.url === '/lfs/objects/batch') {
          response.writeHead(200, { 'Content-Type': 'application/vnd.git-lfs+json' });
          response.end(
            JSON.stringify({
              transfer: 'basic',
              objects: [
                {
                  oid,
                  size: content.length,
                  actions: { download: { href: `${endpoint}/object` } },
                },
              ],
            }),
          );
        } else {
          response.writeHead(200, { 'Content-Length': content.length });
          response.end(content);
        }
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    endpoint = `https://127.0.0.1:${address.port}/lfs`;
    const source = createFixture(join(root, 'tls-source'));
    const remote = join(root, 'tls-remote.git');
    fixtureGit(source, ['clone', '--bare', '.', remote]);
    const local = join(root, 'tls-local');
    fixtureGit(source, ['clone', remote, local]);
    fixtureGit(local, ['lfs', 'install', '--local']);
    fixtureGit(local, ['config', 'lfs.url', endpoint]);
    fixtureGit(local, ['config', `http.${endpoint}.sslVerify`, 'false']);
    await writeFile(join(source, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    await writeFile(
      join(source, 'asset.bin'),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`,
    );
    fixtureGit(source, ['add', '.']);
    fixtureGit(source, ['commit', '-m', 'Incoming LFS pointer']);
    fixtureGit(source, ['push', remote, 'main']);
    const service = new RepositoryService('git', { dataDir: join(root, 'tls-profile') });
    try {
      const repo = await service.open(local);
      const before = await service.workingState(repo.id);
      await expect(
        service.pull(repo.id, { mode: 'ff-only', revision: before.revision }),
      ).rejects.toMatchObject({ code: 'TLS_CERTIFICATE_INVALID' });
      expect(requests).toBe(0);
      expect(fixtureGit(local, ['rev-parse', 'HEAD'])).toBe(before.head.oid);
      expect(fixtureGit(local, ['rev-parse', 'origin/main'])).toBe(
        fixtureGit(source, ['rev-parse', 'HEAD']),
      );
    } finally {
      await service.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
