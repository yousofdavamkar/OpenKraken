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
test('resolved rebase continues through native Git and stale reviews leave edits untouched', async () => {
  const { path, service, repo } = await divergent('continue-rebase');
  try {
    expect(() => fixtureGit(path, ['rebase', '--merge', 'incoming'])).toThrow();
    const paused = await service.operationState(repo.id);
    await expect(
      service.operationAction(repo.id, { action: 'continue', token: paused.token }),
    ).rejects.toMatchObject({ code: 'UNRESOLVED_CONFLICTS' });
    await writeFile(join(path, 'tracked.txt'), 'resolved version\n');
    await expect(
      service.operationAction(repo.id, { action: 'abort', token: paused.token }),
    ).rejects.toMatchObject({ code: 'STALE_OPERATION' });
    expect(fixtureGit(path, ['status', '--porcelain'])).toContain('UU tracked.txt');
    fixtureGit(path, ['add', 'tracked.txt']);
    const reviewed = await service.operationState(repo.id);
    await service.operationAction(repo.id, { action: 'continue', token: reviewed.token });
    expect((await service.operationState(repo.id)).kind).toBe('none');
    expect(fixtureGit(path, ['show', 'HEAD:tracked.txt'])).toBe('resolved version');
    expect(fixtureGit(path, ['log', '-2', '--format=%s'])).toBe(
      'Second local commit\nLocal conflict',
    );
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await service.dispose();
  }
});
for (const action of ['skip', 'abort'] as const)
  test(`native rebase ${action} preserves the intended branch and publishes the resulting index`, async () => {
    const { path, service, repo, original } = await divergent(`rebase-${action}`);
    try {
      expect(() => fixtureGit(path, ['rebase', '--merge', 'incoming'])).toThrow();
      const state = await service.operationState(repo.id);
      await service.operationAction(repo.id, { action, token: state.token });
      expect((await service.operationState(repo.id)).kind).toBe('none');
      expect(fixtureGit(path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
      expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
      if (action === 'abort') expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
      else {
        expect(fixtureGit(path, ['show', 'HEAD:tracked.txt'])).toBe('incoming version');
        expect(fixtureGit(path, ['log', '-2', '--format=%s'])).toBe(
          'Second local commit\nIncoming conflict',
        );
      }
    } finally {
      await service.dispose();
    }
  });
for (const action of ['continue', 'abort'] as const)
  test(`native merge ${action} uses the reviewed operation`, async () => {
    const { path, service, repo, original } = await divergent(`merge-${action}`);
    try {
      expect(() => fixtureGit(path, ['merge', 'incoming'])).toThrow();
      expect((await service.operationState(repo.id)).kind).toBe('merge');
      if (action === 'continue') {
        await writeFile(join(path, 'tracked.txt'), 'merge resolution\n');
        fixtureGit(path, ['add', 'tracked.txt']);
      }
      const state = await service.operationState(repo.id);
      await service.operationAction(repo.id, { action, token: state.token });
      expect((await service.operationState(repo.id)).kind).toBe('none');
      expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
      if (action === 'abort') expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
      else
        expect(fixtureGit(path, ['rev-list', '--parents', '-1', 'HEAD']).split(' ')).toHaveLength(
          3,
        );
    } finally {
      await service.dispose();
    }
  });
for (const mode of ['ff', 'no-ff', 'squash'] as const)
  test(`start merge ${mode} integrates a reviewed commit with native Git semantics`, async () => {
    const path = createFixture(join(root, `start-merge-${mode}`));
    fixtureGit(path, ['switch', '-c', 'incoming']);
    await writeFile(join(path, 'incoming.txt'), 'new file\n');
    fixtureGit(path, ['add', '.']);
    fixtureGit(path, ['commit', '-m', 'Incoming change']);
    const target = fixtureGit(path, ['rev-parse', 'HEAD']);
    fixtureGit(path, ['switch', 'main']);
    const original = fixtureGit(path, ['rev-parse', 'HEAD']);
    const service = new RepositoryService('git', { dataDir: join(root, `merge-${mode}-profile`) });
    try {
      const repo = await service.open(path);
      const state = await service.workingState(repo.id);
      await service.startOperation(repo.id, {
        kind: 'merge',
        mode,
        target,
        revision: state.revision,
      });
      expect(fixtureGit(path, ['show', ':incoming.txt'])).toBe('new file');
      if (mode === 'ff') expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(target);
      if (mode === 'no-ff')
        expect(fixtureGit(path, ['rev-list', '--parents', '-1', 'HEAD']).split(' ')).toHaveLength(
          3,
        );
      if (mode === 'squash') {
        expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
        expect(fixtureGit(path, ['diff', '--cached', '--name-only'])).toBe('incoming.txt');
      }
    } finally {
      await service.dispose();
    }
  });
test('starting rebase publishes conflict stages and can be aborted through the service', async () => {
  const { path, service, repo, original } = await divergent('start-rebase-conflict');
  try {
    const target = fixtureGit(path, ['rev-parse', 'incoming']);
    const state = await service.workingState(repo.id);
    await expect(
      service.startOperation(repo.id, { kind: 'rebase', target, revision: state.revision }),
    ).rejects.toMatchObject({ code: 'GIT_FAILED' });
    const paused = await service.operationState(repo.id);
    expect(paused).toMatchObject({ kind: 'rebase', conflicts: 1 });
    expect(fixtureGit(path, ['ls-files', '--unmerged'])).toContain('tracked.txt');
    await service.operationAction(repo.id, { action: 'abort', token: paused.token });
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
  } finally {
    await service.dispose();
  }
});
test('starting integration refuses changed HEAD, dirty tracked files and an existing operation', async () => {
  const { path, service, repo, original } = await divergent('start-guards');
  try {
    const target = fixtureGit(path, ['rev-parse', 'incoming']);
    const state = await service.workingState(repo.id);
    const options = { kind: 'merge', mode: 'ff', target, revision: state.revision } as const;
    await writeFile(join(path, 'tracked.txt'), 'keep these edits\n');
    await expect(service.startOperation(repo.id, options)).rejects.toMatchObject({
      code: 'OPERATION_DIRTY',
    });
    fixtureGit(path, ['commit', '-am', 'Another writer']);
    await expect(service.startOperation(repo.id, options)).rejects.toMatchObject({
      code: 'STALE_OPERATION',
    });
    fixtureGit(path, ['reset', '--hard', original]);
    expect(() => fixtureGit(path, ['merge', 'incoming'])).toThrow();
    await expect(service.startOperation(repo.id, options)).rejects.toMatchObject({
      code: 'OPERATION_IN_PROGRESS',
    });
    expect((await service.operationState(repo.id)).kind).toBe('merge');
  } finally {
    await service.dispose();
  }
});
