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
