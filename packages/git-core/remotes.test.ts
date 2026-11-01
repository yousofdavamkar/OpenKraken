import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepositoryService } from './src/repository.js';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-remotes-'));
afterAll(() => rm(root, { recursive: true, force: true }));
test('remote management preserves native tracking behavior and rejects stale edits and foreign locks', async () => {
  const path = createFixture(join(root, 'manage'));
  const service = new RepositoryService('git');
  const repo = await service.open(path);
  const originalTip = fixtureGit(path, ['rev-parse', 'refs/remotes/origin/main']);
  let state = await service.remotes(repo.id);
  expect(state.remotes.map((r) => r.name)).toContain('origin');
  state = await service.remote(repo.id, {
    action: 'add',
    name: 'backup',
    url: '/tmp/local remote.git',
    token: state.token,
  });
  expect(state.remotes.find((r) => r.name === 'backup')?.urls).toEqual(['/tmp/local remote.git']);
  state = await service.remote(repo.id, {
    action: 'setUrl',
    name: 'backup',
    url: 'ssh://git@example.test/repo.git',
    token: state.token,
    push: true,
  });
  expect(state.remotes.find((r) => r.name === 'backup')?.pushUrls).toEqual([
    'ssh://git@example.test/repo.git',
  ]);
  state = await service.remote(repo.id, {
    action: 'rename',
    name: 'origin',
    newName: 'upstream',
    token: state.token,
  });
  expect(fixtureGit(path, ['config', 'branch.main.remote'])).toBe('upstream');
  expect(fixtureGit(path, ['rev-parse', 'refs/remotes/upstream/main'])).toBe(originalTip);
  const stale = state.token;
  fixtureGit(path, ['remote', 'set-url', 'backup', '/tmp/new.git']);
  await expect(
    service.remote(repo.id, { action: 'remove', name: 'backup', token: stale }),
  ).rejects.toMatchObject({ code: 'STALE_REMOTES' });
  state = await service.remotes(repo.id);
  await writeFile(join(path, '.git/config.lock'), 'foreign lock');
  await expect(
    service.remote(repo.id, { action: 'remove', name: 'upstream', token: state.token }),
  ).rejects.toThrow();
  expect(await readFile(join(path, '.git/config.lock'), 'utf8')).toBe('foreign lock');
  expect(fixtureGit(path, ['rev-parse', 'refs/remotes/upstream/main'])).toBe(originalTip);
  await rm(join(path, '.git/config.lock'));
  state = await service.remote(repo.id, { action: 'remove', name: 'upstream', token: state.token });
  expect(state.remotes.map((r) => r.name)).not.toContain('upstream');
  expect(fixtureGit(path, ['for-each-ref', '--format=%(refname)', 'refs/remotes/upstream'])).toBe(
    '',
  );
  await service.dispose();
});
test('remote endpoint edits reject credentials and helper commands; configured secrets stay out of results', async () => {
  const path = createFixture(join(root, 'secrets'));
  fixtureGit(path, [
    'remote',
    'set-url',
    'origin',
    'https://username:secret@example.test/repo.git?token=private',
  ]);
  const service = new RepositoryService('git');
  const repo = await service.open(path);
  const state = await service.remotes(repo.id);
  expect(JSON.stringify(state)).not.toMatch(/username|secret|private/);
  for (const url of [
    'https://token@example.test/repo.git',
    'ssh://git:password@example.test/repo.git',
    'ext::sh -c command',
    'https://example.test/repo?token=private',
  ]) {
    await expect(
      service.remote(repo.id, { action: 'add', name: 'unsafe', url, token: state.token }),
    ).rejects.toThrow();
  }
  expect(fixtureGit(path, ['remote'])).toBe('origin');
  await expect(
    service.remote(repo.id, {
      action: 'rename',
      name: 'origin',
      newName: '-bad',
      token: state.token,
    }),
  ).rejects.toThrow();
  await service.dispose();
});
test('fetch imports and prunes remote refs and tags without changing local work', async () => {
  const source = createFixture(join(root, 'fetch-source'));
  const bare = join(root, 'fetch-remote.git');
  fixtureGit(source, ['clone', '--bare', '.', bare]);
  const path = createFixture(join(root, 'fetch-client'));
  fixtureGit(path, ['remote', 'set-url', 'origin', bare]);
  fixtureGit(source, ['branch', 'incoming']);
  fixtureGit(source, ['tag', 'remote-release']);
  fixtureGit(source, ['push', bare, 'incoming', 'refs/tags/remote-release']);
  await writeFile(join(path, 'tracked.txt'), 'local edit\n');
  const head = fixtureGit(path, ['rev-parse', 'HEAD']);
  const service = new RepositoryService('git');
  const repo = await service.open(path);
  await service.fetch(repo.id, 'origin');
  expect(fixtureGit(path, ['rev-parse', 'origin/incoming'])).toBe(
    fixtureGit(source, ['rev-parse', 'incoming']),
  );
  expect(fixtureGit(path, ['rev-parse', 'remote-release'])).toBe(
    fixtureGit(source, ['rev-parse', 'remote-release']),
  );
  expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(head);
  expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('local edit\n');
  fixtureGit(source, ['push', bare, '--delete', 'incoming']);
  await service.fetch(repo.id, 'origin');
  expect(
    fixtureGit(path, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/incoming']),
  ).toBe('');
  await expect(service.fetch(repo.id, '--all')).rejects.toThrow();
  await service.dispose();
});
test('fetch refuses untrusted TLS even with URL-specific sslVerify=false and blocks external helpers', async () => {
  const { createServer } = await import('node:https');
  const server = createServer(
    {
      key: await readFile(new URL('../test-fixtures/tls/localhost-test.key', import.meta.url)),
      cert: await readFile(new URL('../test-fixtures/tls/localhost-test.crt', import.meta.url)),
    },
    (_request, response) => {
      response.writeHead(404);
      response.end();
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const path = createFixture(join(root, 'tls'));
  const url = `https://127.0.0.1:${address.port}/repo.git`;
  const service = new RepositoryService('git');
  try {
    fixtureGit(path, ['remote', 'set-url', 'origin', url]);
    fixtureGit(path, ['config', `http.${url}.sslVerify`, 'false']);
    const repo = await service.open(path);
    await expect(service.fetch(repo.id, 'origin')).rejects.toThrow(/certificate|SSL|TLS/i);
    fixtureGit(path, ['remote', 'set-url', 'origin', 'ext::echo should-not-run']);
    await expect(service.fetch(repo.id, 'origin')).rejects.toThrow(/transport.*ext.*not allowed/i);
  } finally {
    await service.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
