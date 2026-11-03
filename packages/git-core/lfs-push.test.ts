import { afterAll, expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { lfsRemote } from '../test-fixtures/src/lfs-remote.js';
import { RepositoryService } from './src/repository.js';
import { AskpassBroker } from './src/askpass.js';

const hasLfs = spawnSync('git', ['lfs', 'version']).status === 0;
if (process.env.OPENKRAKEN_LFS_TEST === '1' && !hasLfs)
  throw new Error('LFS acceptance requires git-lfs on PATH');
const root = await mkdtemp(join(tmpdir(), 'openkraken-lfs-push-'));
afterAll(() => rm(root, { recursive: true, force: true }));

test.skipIf(!hasLfs).each(['rejected', 'cancelled', 'tls', 'missing-object'] as const)(
  'LFS %s failure prevents publishing a reviewed Git ref and preserves local content',
  async (failure) => {
    const remote = await lfsRemote({ tls: failure === 'tls' });
    const local = createFixture(join(root, failure + '-client'));
    const bare = join(root, failure + '-remote.git');
    fixtureGit(local, ['clone', '--bare', '.', bare]);
    fixtureGit(local, ['remote', 'set-url', 'origin', bare]);
    fixtureGit(local, ['lfs', 'install', '--local']);
    fixtureGit(local, ['lfs', 'track', '*.bin']);
    fixtureGit(local, ['config', 'lfs.url', remote.url]);
    // Exercise a native retry without waiting through the default eight backoffs.
    fixtureGit(local, ['config', 'lfs.transfer.maxretries', '1']);
    fixtureGit(local, ['config', 'lfs.transfer.maxretrydelay', '0']);
    if (failure === 'tls') fixtureGit(local, ['config', `http.${remote.url}.sslVerify`, 'false']);
    const content = Buffer.from('Keep local LFS content\n');
    await writeFile(join(local, 'asset.bin'), content);
    fixtureGit(local, ['add', '.']);
    fixtureGit(local, ['commit', '-m', 'Local LFS content']);
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(local);
      const plan = await service.pushPreview(repo.id, {
        name: 'origin',
        source: 'refs/heads/main',
        destination: 'refs/heads/main',
      });
      if (failure === 'rejected') remote.setUploadMode('reject');
      if (failure === 'cancelled') remote.setUploadMode('stall');
      if (failure === 'missing-object')
        await rm(join(local, '.git/lfs/objects'), { recursive: true });
      const controller = new AbortController();
      const pending = service.push(repo.id, { plan }, controller.signal);
      if (failure === 'cancelled') {
        const stopped = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
        await remote.uploadStarted;
        controller.abort();
        await stopped;
      } else if (failure === 'tls') {
        await expect(pending).rejects.toMatchObject({ code: 'TLS_CERTIFICATE_INVALID' });
        expect(remote.events).toEqual([]);
      } else await expect(pending).rejects.toThrow();
      expect(fixtureGit(bare, ['rev-parse', 'main'])).toBe(plan.remoteOid);
      expect(fixtureGit(local, ['rev-parse', 'HEAD'])).toBe(plan.sourceOid);
      expect(await readFile(join(local, 'asset.bin'))).toEqual(content);
      if (failure === 'missing-object') expect(remote.events).not.toContain('upload');
      if (failure === 'rejected') {
        expect(remote.events.filter((event) => event === 'upload').length).toBeGreaterThan(1);
        expect(remote.uploads.size).toBe(0);
      }
    } finally {
      await service.dispose();
      await remote.close();
    }
  },
);

test.skipIf(!hasLfs)(
  'reviewed push uploads authenticated LFS objects before publishing the selected Git ref',
  async () => {
    const remote = await lfsRemote({ authenticated: true });
    const local = createFixture(join(root, 'client'));
    const bare = join(root, 'remote.git');
    fixtureGit(local, ['clone', '--bare', '.', bare]);
    fixtureGit(local, ['remote', 'set-url', 'origin', bare]);
    fixtureGit(local, ['lfs', 'install', '--local']);
    fixtureGit(local, ['lfs', 'track', '*.bin']);
    fixtureGit(local, ['config', 'lfs.url', remote.url]);
    fixtureGit(local, ['config', 'credential.helper', '']);
    const content = Buffer.from('LFS object uploaded by reviewed push\n');
    const oid = createHash('sha256').update(content).digest('hex');
    await writeFile(join(local, 'asset.bin'), content);
    fixtureGit(local, ['add', '.']);
    fixtureGit(local, ['commit', '-m', 'Publish LFS pointer']);
    fixtureGit(local, ['checkout', '-b', 'private']);
    const privateContent = Buffer.from('Unselected LFS object must stay local\n');
    const privateOid = createHash('sha256').update(privateContent).digest('hex');
    await writeFile(join(local, 'private.bin'), privateContent);
    fixtureGit(local, ['add', '.']);
    fixtureGit(local, ['commit', '-m', 'Private LFS pointer']);
    fixtureGit(local, ['checkout', 'main']);
    const id = randomUUID();
    const prompts: string[] = [];
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
            event.kind === 'username' ? remote.credentials.username : remote.credentials.password,
          );
        }
      },
    );
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(local);
      const scope = await broker.open(id, 'Push LFS fixture');
      const plan = await service.pushPreview(repo.id, {
        name: 'origin',
        source: 'refs/heads/main',
        destination: 'refs/heads/published',
      });
      expect(remote.events).toEqual([]);
      await service.push(repo.id, { plan }, undefined, undefined, scope.environment);
      scope.close();
      expect(prompts).toContain('username');
      expect(prompts).toContain('secret');
      expect(remote.uploads.get(oid)).toEqual(content);
      expect(remote.uploads.has(privateOid)).toBe(false);
      expect(remote.uploads.size).toBe(1);
      expect(fixtureGit(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads/private'])).toBe(
        '',
      );
      expect(remote.events).toContain('verify-locks');
      expect(remote.events.indexOf('batch')).toBeLessThan(remote.events.indexOf('upload'));
      expect(fixtureGit(bare, ['rev-parse', 'published'])).toBe(plan.sourceOid);
      expect(fixtureGit(bare, ['show', 'published:asset.bin'])).toContain(`oid sha256:${oid}`);
      expect(await readFile(join(local, 'asset.bin'))).toEqual(content);
    } finally {
      await broker.close();
      await service.dispose();
      await remote.close();
    }
  },
);
