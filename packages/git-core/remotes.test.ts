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
    await expect(service.fetch(repo.id, 'origin')).rejects.toMatchObject({
      code: 'TLS_CERTIFICATE_INVALID',
      message: expect.stringMatching(/certificate|SSL|TLS/i),
    });
    fixtureGit(path, ['remote', 'set-url', 'origin', 'ext::echo should-not-run']);
    await expect(service.fetch(repo.id, 'origin')).rejects.toThrow(/transport.*ext.*not allowed/i);
  } finally {
    await service.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
test.skipIf(process.platform === 'win32')(
  'background fetch disables native askpass prompts',
  async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const path = createFixture(join(root, 'background-auth'));
    const marker = join(path, 'prompted');
    const askpass = join(path, 'askpass.sh');
    await writeFile(askpass, '#!/bin/sh\ntouch prompted\nprintf "fixture-credential\\n"\n', {
      mode: 0o755,
    });
    fixtureGit(path, ['remote', 'set-url', 'origin', `http://127.0.0.1:${address.port}/repo.git`]);
    fixtureGit(path, ['config', 'credential.helper', '']);
    fixtureGit(path, ['config', 'core.askPass', askpass]);
    const service = new RepositoryService('git');
    try {
      const repo = await service.open(path);
      await expect(service.fetch(repo.id, 'origin')).rejects.toThrow();
      expect(await readFile(marker, 'utf8')).toBe('');
      await rm(marker);
      await expect(service.fetch(repo.id, 'origin', undefined, true)).rejects.toMatchObject({
        code: 'AUTHENTICATION_FAILED',
      });
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await service.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  },
);
test('push publishes reviewed tips, sets upstream and uses an explicit lease for non-fast-forward updates', async () => {
  const path = createFixture(join(root, 'push-client'));
  const bare = join(root, 'push-remote.git');
  fixtureGit(path, ['clone', '--bare', '.', bare]);
  fixtureGit(path, ['remote', 'set-url', 'origin', bare]);
  const service = new RepositoryService('git');
  const repo = await service.open(path);
  const selection = {
    name: 'origin',
    source: 'refs/heads/main',
    destination: 'refs/heads/published',
  };
  let plan = await service.pushPreview(repo.id, selection);
  expect(plan.remoteOid).toBeNull();
  await service.push(repo.id, { plan, upstream: true });
  expect(fixtureGit(bare, ['rev-parse', 'published'])).toBe(plan.sourceOid);
  expect(fixtureGit(path, ['rev-parse', '--symbolic-full-name', 'main@{upstream}'])).toBe(
    'refs/remotes/origin/published',
  );
  fixtureGit(path, ['commit', '--allow-empty', '-m', 'First published commit']);
  plan = await service.pushPreview(repo.id, selection);
  await service.push(repo.id, { plan });
  const published = fixtureGit(bare, ['rev-parse', 'published']);
  fixtureGit(path, ['reset', '--soft', 'HEAD~1']);
  fixtureGit(path, ['commit', '--allow-empty', '-m', 'Rewritten published commit']);
  plan = await service.pushPreview(repo.id, selection);
  await expect(service.push(repo.id, { plan })).rejects.toThrow(/non-fast-forward|rejected/);
  expect(fixtureGit(bare, ['rev-parse', 'published'])).toBe(published);
  // Another writer changes the server after review. The explicit lease must refuse it.
  fixtureGit(bare, ['update-ref', 'refs/heads/published', `${published}~1`]);
  await expect(service.push(repo.id, { plan, force: true })).rejects.toThrow(/stale info|rejected/);
  fixtureGit(bare, ['update-ref', 'refs/heads/published', published]);
  plan = await service.pushPreview(repo.id, selection);
  await service.push(repo.id, { plan, force: true });
  expect(fixtureGit(bare, ['rev-parse', 'published'])).toBe(plan.sourceOid);
  plan = await service.pushPreview(repo.id, selection);
  fixtureGit(path, ['commit', '--allow-empty', '-m', 'Changed after review']);
  await expect(service.push(repo.id, { plan })).rejects.toMatchObject({ code: 'STALE_PUSH' });
  await service.dispose();
});
test('push reviews the push URL and publishes only the selected ref despite mirror and follow-tags settings', async () => {
  const path = createFixture(join(root, 'push-settings'));
  const fetchRemote = join(root, 'push-settings-fetch.git');
  const pushRemote = join(root, 'push-settings-push.git');
  fixtureGit(path, ['clone', '--bare', '.', fetchRemote]);
  fixtureGit(path, ['clone', '--bare', '.', pushRemote]);
  fixtureGit(fetchRemote, ['branch', 'published', 'HEAD~1']);
  fixtureGit(pushRemote, ['branch', 'published', 'HEAD']);
  fixtureGit(pushRemote, ['branch', 'server-only', 'HEAD']);
  fixtureGit(path, ['remote', 'set-url', 'origin', fetchRemote]);
  fixtureGit(path, ['remote', 'set-url', '--push', 'origin', pushRemote]);
  fixtureGit(path, ['config', 'remote.origin.mirror', 'true']);
  fixtureGit(path, ['config', 'push.followTags', 'true']);
  fixtureGit(path, ['branch', 'private-branch']);
  fixtureGit(path, ['tag', '-a', 'v', '-m', 'Do not publish implicitly']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const plan = await service.pushPreview(repo.id, {
      name: 'origin',
      source: 'refs/heads/main',
      destination: 'refs/heads/published',
    });
    expect(plan.remoteOid).toBe(fixtureGit(pushRemote, ['rev-parse', 'published']));
    expect(plan.remoteOid).not.toBe(fixtureGit(fetchRemote, ['rev-parse', 'published']));
    await service.push(repo.id, { plan });
    expect(
      fixtureGit(pushRemote, [
        'for-each-ref',
        '--format=%(refname)',
        'refs/tags/v',
        'refs/heads/private-branch',
      ]),
    ).toBe('');
    expect(fixtureGit(pushRemote, ['rev-parse', 'server-only'])).toBe(plan.sourceOid);
    const tag = await service.pushPreview(repo.id, {
      name: 'origin',
      source: 'refs/tags/v',
      destination: 'refs/tags/v',
    });
    await service.push(repo.id, { plan: tag });
    expect(fixtureGit(pushRemote, ['cat-file', '-t', 'refs/tags/v'])).toBe('tag');
  } finally {
    await service.dispose();
  }
});
test('reviewed remote deletion uses the push URL and an exact lease for branches and tags', async () => {
  const local = createFixture(join(root, 'delete-server-ref'));
  const remote = join(root, 'delete-server.git');
  const other = join(root, 'delete-fetch.git');
  fixtureGit(local, ['clone', '--bare', '.', remote]);
  fixtureGit(local, ['clone', '--bare', '.', other]);
  fixtureGit(remote, ['branch', 'obsolete']);
  fixtureGit(other, ['branch', 'obsolete']);
  fixtureGit(local, ['remote', 'set-url', 'origin', other]);
  fixtureGit(local, ['remote', 'set-url', '--push', 'origin', remote]);
  const service = new RepositoryService('git');
  const repo = await service.open(local);
  try {
    const plan = await service.deleteRemotePreview(repo.id, {
      name: 'origin',
      destination: 'refs/heads/obsolete',
    });
    expect(plan.remoteOid).toBe(fixtureGit(remote, ['rev-parse', 'obsolete']));
    fixtureGit(local, ['config', 'push.followTags', 'true']);
    await expect(service.deleteRemote(repo.id, plan)).rejects.toMatchObject({
      code: 'STALE_REMOTE_DELETE',
    });
    expect(fixtureGit(remote, ['rev-parse', 'obsolete'])).toBe(plan.remoteOid);
    fixtureGit(local, ['config', 'remote.origin.mirror', 'true']);
    const reviewed = await service.deleteRemotePreview(repo.id, {
      name: 'origin',
      destination: 'refs/heads/obsolete',
    });
    await service.deleteRemote(repo.id, reviewed);
    expect(fixtureGit(remote, ['rev-parse', 'main'])).toBe(plan.remoteOid);
    expect(fixtureGit(remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/obsolete'])).toBe(
      '',
    );
    expect(fixtureGit(other, ['rev-parse', 'obsolete'])).toBe(plan.remoteOid);
    let tag = await service.deleteRemotePreview(repo.id, {
      name: 'origin',
      destination: 'refs/tags/v0.1.0',
    });
    fixtureGit(remote, [
      'update-ref',
      'refs/tags/v0.1.0',
      fixtureGit(remote, ['rev-parse', 'HEAD~1']),
    ]);
    await expect(service.deleteRemote(repo.id, tag)).rejects.toThrow(/stale|rejected/i);
    expect(fixtureGit(remote, ['rev-parse', 'v0.1.0'])).not.toBe(tag.remoteOid);
    tag = await service.deleteRemotePreview(repo.id, {
      name: 'origin',
      destination: 'refs/tags/v0.1.0',
    });
    await service.deleteRemote(repo.id, tag);
    expect(fixtureGit(remote, ['for-each-ref', '--format=%(refname)', 'refs/tags/v0.1.0'])).toBe(
      '',
    );
    expect(fixtureGit(local, ['rev-parse', 'v0.1.0'])).toBe(plan.remoteOid);
    await expect(
      service.deleteRemotePreview(repo.id, { name: 'origin', destination: 'refs/heads/missing' }),
    ).rejects.toMatchObject({ code: 'REMOTE_REF_MISSING' });
  } finally {
    await service.dispose();
  }
});
