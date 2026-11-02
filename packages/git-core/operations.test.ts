import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepositoryService } from './src/repository.js';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-operations-'));
afterAll(() => rm(root, { recursive: true, force: true }));
async function divergent(name: string) {
  const path = createFixture(join(root, name));
  fixtureGit(path, ['config', 'user.name', 'Fixture']);
  fixtureGit(path, ['config', 'user.email', 'fixture@example.test']);
  fixtureGit(path, ['switch', '-c', 'incoming']);
  await writeFile(join(path, 'tracked.txt'), 'incoming version\n');
  fixtureGit(path, ['commit', '-am', 'Incoming conflict']);
  fixtureGit(path, ['switch', 'main']);
  await writeFile(join(path, 'tracked.txt'), 'local version\n');
  fixtureGit(path, ['commit', '-am', 'Local conflict']);
  const first = fixtureGit(path, ['rev-parse', 'HEAD']);
  await writeFile(join(path, 'second.txt'), 'second local commit\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Second local commit']);
  const original = fixtureGit(path, ['rev-parse', 'HEAD']);
  const service = new RepositoryService('git', { dataDir: join(root, name + '-profile') });
  const repo = await service.open(path);
  return { path, service, repo, first, original };
}
test('operation inspection reads native rebase progress and detects edited conflict resolutions', async () => {
  const { path, service, repo, first, original } = await divergent('inspect-rebase');
  try {
    expect((await service.operationState(repo.id)).kind).toBe('none');
    expect(() => fixtureGit(path, ['rebase', '--merge', 'incoming'])).toThrow();
    const state = await service.operationState(repo.id);
    expect(state).toMatchObject({
      kind: 'rebase',
      originalHead: original,
      branchRef: 'refs/heads/main',
      currentCommit: first,
      progress: { current: 1, total: 2 },
      actions: ['continue', 'skip', 'abort'],
    });
    expect(state.message).toContain('Local conflict');
    await writeFile(join(path, 'tracked.txt'), 'manually resolved work\n');
    expect((await service.operationState(repo.id)).token).not.toBe(state.token);
    fixtureGit(path, ['rebase', '--abort']);
    expect((await service.operationState(repo.id)).kind).toBe('none');
  } finally {
    await service.dispose();
  }
});
