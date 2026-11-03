import { afterAll, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
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
const root = await mkdtemp(join(tmpdir(), 'openkraken-lfs-transfer-'));
afterAll(() => rm(root, { recursive: true, force: true }));

test.skipIf(!hasLfs)(
  'reviewed LFS pull downloads recorded objects, preserves edits and consumes the review',
  async () => {
    const content = Buffer.from('large file contents\n');
    const oid = createHash('sha256').update(content).digest('hex');
    let requests = 0;
    let endpoint = '';
    const batches: { operation: string; objects: { oid: string; size: number }[] }[] = [];
    const server = createServer(async (request, response) => {
      requests++;
      if (request.url === '/lfs/objects/batch') {
        const chunks = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        batches.push(body);
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
    const path = createFixture(join(root, 'pull'));
    fixtureGit(path, ['lfs', 'install', '--local', '--skip-smudge']);
    fixtureGit(path, ['lfs', 'track', '*.bin']);
    for (const name of ['asset.bin', 'edited.bin']) await writeFile(join(path, name), content);
    await writeFile(join(path, 'excluded.bin'), 'excluded LFS content\n');
    fixtureGit(path, ['add', '.']);
    fixtureGit(path, ['commit', '-m', 'LFS fixture']);
    fixtureGit(path, ['config', 'lfs.fetchexclude', 'excluded.bin']);
    const excludedPointer = fixtureGit(path, ['show', 'HEAD:excluded.bin']) + '\n';
    await writeFile(join(path, 'excluded.bin'), excludedPointer);
    fixtureGit(path, ['config', 'lfs.url', endpoint]);
    const pointer = fixtureGit(path, ['show', 'HEAD:asset.bin']) + '\n';
    await writeFile(join(path, 'asset.bin'), pointer);
    await writeFile(join(path, 'edited.bin'), 'keep my local draft\n');
    await rm(join(path, '.git/lfs/objects'), { recursive: true });
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(path);
      const head = fixtureGit(path, ['rev-parse', 'HEAD']);
      const index = fixtureGit(path, ['ls-files', '--stage']);
      const review = await service.lfsPullPreview(repo.id, 'origin');
      expect(review).toMatchObject({
        remote: 'origin',
        endpoint,
        files: expect.arrayContaining([
          expect.objectContaining({ path: 'asset.bin', oid, downloaded: false }),
        ]),
      });
      expect(review.filters).toContain('FetchExclude=excluded.bin');
      expect(requests).toBe(0);
      const result = await service.lfsPull(repo.id, review.token);
      expect(result.files.find((file) => file.path === 'asset.bin')).toMatchObject({
        checkout: true,
        downloaded: true,
      });
      expect(await readFile(join(path, 'asset.bin'))).toEqual(content);
      expect(await readFile(join(path, 'edited.bin'), 'utf8')).toBe('keep my local draft\n');
      expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(head);
      expect(fixtureGit(path, ['ls-files', '--stage'])).toBe(index);
      await expect(service.lfsPull(repo.id, review.token)).rejects.toMatchObject({
        code: 'STALE_LFS_PULL',
      });
      expect(batches[0]).toMatchObject({
        operation: 'download',
        objects: [{ oid, size: content.length }],
      });
      expect(await readFile(join(path, 'excluded.bin'), 'utf8')).toBe(excludedPointer);
      expect(result.files.find((file) => file.path === 'excluded.bin')?.downloaded).toBe(false);
      expect(requests).toBeGreaterThanOrEqual(2);
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
  'LFS reviews bind local edits and effective configuration and reject external programs and redirected paths',
  async () => {
    const path = createFixture(join(root, 'guards'));
    fixtureGit(path, ['lfs', 'install', '--local', '--skip-smudge']);
    fixtureGit(path, ['lfs', 'track', '*.bin']);
    await writeFile(join(path, 'asset.bin'), 'original object\n');
    fixtureGit(path, ['add', '.']);
    fixtureGit(path, ['commit', '-m', 'LFS fixture']);
    fixtureGit(path, ['config', 'lfs.url', 'https://lfs.example.test/api']);
    fixtureGit(path, ['remote', 'add', 'backup=x', 'https://backup.example.test/repo.git']);
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(path);
      fixtureGit(path, ['config', '--unset', 'lfs.url']);
      expect((await service.lfsPullPreview(repo.id, 'backup=x')).endpoint).toBe(
        'https://backup.example.test/repo.git/info/lfs',
      );
      fixtureGit(path, ['config', 'lfs.url', 'https://lfs.example.test/api']);
      const selected = await service.lfsPullPreview(repo.id, 'backup=x');
      expect(selected.endpoint).toBe('https://lfs.example.test/api');
      await writeFile(join(path, 'asset.bin'), 'keep a newer draft\n');
      await expect(service.lfsPull(repo.id, selected.token)).rejects.toMatchObject({
        code: 'STALE_LFS_PULL',
      });
      const configured = await service.lfsPullPreview(repo.id, 'origin');
      fixtureGit(path, ['config', 'lfs.url', 'https://changed.example.test/api']);
      await expect(service.lfsPull(repo.id, configured.token)).rejects.toMatchObject({
        code: 'STALE_LFS_PULL',
      });
      fixtureGit(path, ['config', 'lfs.standalonetransferagent', 'custom-program']);
      await expect(service.lfsPullPreview(repo.id, 'origin')).rejects.toMatchObject({
        code: 'LFS_CUSTOM_TRANSFER',
      });
      fixtureGit(path, ['config', '--unset', 'lfs.standalonetransferagent']);
      fixtureGit(path, ['config', 'lfs.extension.fixture.smudge', 'custom-program']);
      await expect(service.lfsPullPreview(repo.id, 'origin')).rejects.toMatchObject({
        code: 'LFS_CUSTOM_TRANSFER',
      });
      fixtureGit(path, ['config', '--remove-section', 'lfs.extension.fixture']);
      await writeFile(
        join(path, '.git/MERGE_HEAD'),
        fixtureGit(path, ['rev-parse', 'HEAD']) + '\n',
      );
      await expect(service.lfsPullPreview(repo.id, 'origin')).rejects.toMatchObject({
        code: 'LFS_OPERATION',
      });
      await rm(join(path, '.git/MERGE_HEAD'));
      const blob = fixtureGit(path, ['rev-parse', 'HEAD:asset.bin']);
      fixtureGit(path, ['update-index', '--force-remove', 'asset.bin']);
      fixtureGit(
        path,
        ['update-index', '--index-info'],
        `100644 ${blob} 2\tasset.bin\n100644 ${blob} 3\tasset.bin\n`,
      );
      await expect(service.lfsPullPreview(repo.id, 'origin')).rejects.toMatchObject({
        code: 'LFS_OPERATION',
      });
      fixtureGit(path, ['reset', 'HEAD', '--', 'asset.bin']);
      if (process.platform !== 'win32') {
        const { symlink } = await import('node:fs/promises');
        await symlink(join(path, 'asset.bin'), join(path, '.lfsconfig'));
        await expect(service.lfsPullPreview(repo.id, 'origin')).rejects.toMatchObject({
          code: 'LFS_CONFIG',
        });
        await rm(join(path, '.lfsconfig'));
        const outside = join(root, 'outside-lfs-file');
        await writeFile(outside, 'do not replace\n');
        await rm(join(path, 'asset.bin'));
        await symlink(outside, join(path, 'asset.bin'));
        await expect(service.lfsPullPreview(repo.id, 'origin')).rejects.toMatchObject({
          code: 'LFS_PATH',
        });
        expect(await readFile(outside, 'utf8')).toBe('do not replace\n');
      }
    } finally {
      await service.dispose();
    }
  },
);

test.skipIf(!hasLfs)(
  'LFS downloads enforce TLS even when URL-specific verification is disabled',
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
        response.writeHead(404);
        response.end();
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const endpoint = `https://127.0.0.1:${address.port}/lfs`;
    const path = createFixture(join(root, 'tls'));
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 10\n`;
    await writeFile(join(path, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    await writeFile(join(path, 'asset.bin'), pointer);
    fixtureGit(path, ['add', '.']);
    fixtureGit(path, ['commit', '-m', 'LFS fixture']);
    fixtureGit(path, ['config', 'lfs.url', endpoint]);
    fixtureGit(path, ['config', `http.${endpoint}.sslVerify`, 'false']);
    fixtureGit(path, ['config', 'lfs.transfer.maxretries', '1']);
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(path);
      const preview = await service.lfsPullPreview(repo.id, 'origin');
      await expect(service.lfsPull(repo.id, preview.token)).rejects.toMatchObject({
        code: 'TLS_CERTIFICATE_INVALID',
      });
      expect(requests).toBe(0);
      expect(await readFile(join(path, 'asset.bin'), 'utf8')).toBe(pointer);
      await expect(service.lfsPull(repo.id, preview.token)).rejects.toMatchObject({
        code: 'STALE_LFS_PULL',
      });
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
  'LFS rejects corrupt downloaded content, preserves the pointer and allows a newly reviewed retry',
  async () => {
    const content = Buffer.from('verified LFS object\n');
    const oid = createHash('sha256').update(content).digest('hex');
    let corrupt = true;
    let endpoint = '';
    const server = createServer((request, response) => {
      if (request.url === '/lfs/objects/batch') {
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
        response.writeHead(200, { 'Content-Length': content.length });
        response.end(corrupt ? Buffer.alloc(content.length, 120) : content);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    endpoint = `http://127.0.0.1:${address.port}/lfs`;
    const path = createFixture(join(root, 'corrupt'));
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`;
    await writeFile(join(path, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    await writeFile(join(path, 'asset.bin'), pointer);
    fixtureGit(path, ['add', '.']);
    fixtureGit(path, ['commit', '-m', 'LFS fixture']);
    fixtureGit(path, ['config', 'lfs.url', endpoint]);
    fixtureGit(path, ['config', 'lfs.transfer.maxretries', '1']);
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(path);
      const preview = await service.lfsPullPreview(repo.id, 'origin');
      await expect(service.lfsPull(repo.id, preview.token)).rejects.toThrow(
        /expected OID|does not match|hash/i,
      );
      expect(await readFile(join(path, 'asset.bin'), 'utf8')).toBe(pointer);
      expect((await service.lfsState(repo.id)).files[0]?.downloaded).toBe(false);
      await expect(service.lfsPull(repo.id, preview.token)).rejects.toMatchObject({
        code: 'STALE_LFS_PULL',
      });
      corrupt = false;
      const retry = await service.lfsPullPreview(repo.id, 'origin');
      await service.lfsPull(repo.id, retry.token);
      expect(await readFile(join(path, 'asset.bin'))).toEqual(content);
    } finally {
      await service.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
