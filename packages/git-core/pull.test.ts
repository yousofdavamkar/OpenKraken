import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepositoryService } from './src/repository.js';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-pull-'));
afterAll(() => rm(root, { recursive: true, force: true }));
async function setup(name: string) {
  const source = createFixture(join(root, name + '-source'));
  const remote = join(root, name + '-remote.git');
  fixtureGit(source, ['clone', '--bare', '.', remote]);
  const local = join(root, name + '-local');
  fixtureGit(source, ['clone', remote, local]);
  fixtureGit(local, ['config', 'user.name', 'Fixture']);
  fixtureGit(local, ['config', 'user.email', 'fixture@example.test']);
  const service = new RepositoryService('git', { dataDir: join(root, name + '-profile') });
  const repo = await service.open(local);
  return { source, remote, local, service, repo };
}
test('ff-only pull fetches its upstream, updates files and rejects divergent history', async () => {
  const { source, remote, local, service, repo } = await setup('ff');
  try {
    await writeFile(join(source, 'new.txt'), 'remote content\n');
    fixtureGit(source, ['add', '.']);
    fixtureGit(source, ['commit', '-m', 'Remote change']);
    fixtureGit(source, ['push', remote, 'main']);
    const state = await service.workingState(repo.id);
    const result = await service.pull(repo.id, { mode: 'ff-only', revision: state.revision });
    expect(result.head.oid).toBe(fixtureGit(source, ['rev-parse', 'HEAD']));
    expect(await readFile(join(local, 'new.txt'), 'utf8')).toBe('remote content\n');
    fixtureGit(local, ['commit', '--allow-empty', '-m', 'Local divergence']);
    fixtureGit(source, ['commit', '--allow-empty', '-m', 'Remote divergence']);
    fixtureGit(source, ['push', remote, 'main']);
    const before = fixtureGit(local, ['rev-parse', 'HEAD']);
    await expect(
      service.pull(repo.id, {
        mode: 'ff-only',
        revision: (await service.workingState(repo.id)).revision,
      }),
    ).rejects.toThrow(/fast-forward/i);
    expect(fixtureGit(local, ['rev-parse', 'HEAD'])).toBe(before);
    expect(fixtureGit(local, ['status', '--porcelain'])).toBe('');
    expect(fixtureGit(local, ['rev-parse', 'origin/main'])).toBe(
      fixtureGit(source, ['rev-parse', 'HEAD']),
    );
  } finally {
    await service.dispose();
  }
});
test.each(['merge', 'rebase'] as const)(
  'pull %s integrates divergent work using the explicitly selected policy',
  async (mode) => {
    const { source, remote, local, service, repo } = await setup(mode);
    try {
      await writeFile(join(local, 'local.txt'), 'local work\n');
      fixtureGit(local, ['add', '.']);
      fixtureGit(local, ['commit', '-m', 'Local work']);
      const oldLocal = fixtureGit(local, ['rev-parse', 'HEAD']);
      await writeFile(join(source, 'remote.txt'), 'remote work\n');
      fixtureGit(source, ['add', '.']);
      fixtureGit(source, ['commit', '-m', 'Remote work']);
      fixtureGit(source, ['push', remote, 'main']);
      fixtureGit(local, ['config', 'pull.ff', 'only']);
      fixtureGit(local, ['config', 'pull.rebase', mode === 'merge' ? 'true' : 'false']);
      const remoteTip = fixtureGit(source, ['rev-parse', 'HEAD']);
      await service.pull(repo.id, {
        mode,
        revision: (await service.workingState(repo.id)).revision,
      });
      const parents = fixtureGit(local, ['show', '-s', '--format=%P', 'HEAD']).split(' ');
      expect(parents).toEqual(mode === 'merge' ? [oldLocal, remoteTip] : [remoteTip]);
      expect(await readFile(join(local, 'local.txt'), 'utf8')).toBe('local work\n');
      expect(await readFile(join(local, 'remote.txt'), 'utf8')).toBe('remote work\n');
      expect(fixtureGit(local, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
      expect(fixtureGit(local, ['status', '--porcelain'])).toBe('');
    } finally {
      await service.dispose();
    }
  },
);
test.each(['merge', 'rebase'] as const)(
  'conflicted %s pull publishes native conflict stages and remains abortable',
  async (mode) => {
    const { source, remote, local, service, repo } = await setup('conflict-' + mode);
    try {
      await writeFile(join(local, 'tracked.txt'), 'local version\n');
      fixtureGit(local, ['commit', '-am', 'Local conflict']);
      const original = fixtureGit(local, ['rev-parse', 'HEAD']);
      await writeFile(join(source, 'tracked.txt'), 'remote version\n');
      fixtureGit(source, ['commit', '-am', 'Remote conflict']);
      fixtureGit(source, ['push', remote, 'main']);
      await expect(
        service.pull(repo.id, { mode, revision: (await service.workingState(repo.id)).revision }),
      ).rejects.toThrow();
      const state = await service.workingState(repo.id);
      expect(state.status.entries.find((entry) => entry.path === 'tracked.txt')?.kind).toBe(
        'conflict',
      );
      expect(fixtureGit(local, ['ls-files', '--unmerged'])).toMatch(/ 2\ttracked.txt/);
      expect(fixtureGit(local, ['ls-files', '--unmerged'])).toMatch(/ 3\ttracked.txt/);
      // The merge backend also creates Git's rebase-merge/interactive marker.
      expect(mode === 'merge' ? ['merging'] : ['rebasing', 'rebasing-interactive']).toContain(
        (await service.snapshot(repo.id)).repository.state,
      );
      fixtureGit(local, [mode, '--abort']);
      expect(fixtureGit(local, ['rev-parse', 'HEAD'])).toBe(original);
      expect(await readFile(join(local, 'tracked.txt'), 'utf8')).toBe('local version\n');
      expect(fixtureGit(local, ['status', '--porcelain'])).toBe('');
    } finally {
      await service.dispose();
    }
  },
);
test('pull refuses dirty, stale, detached and upstream-less states before fetching', async () => {
  const { source, remote, local, service, repo } = await setup('guards');
  try {
    const initial = await service.workingState(repo.id);
    const oldRemote = fixtureGit(local, ['rev-parse', 'origin/main']);
    fixtureGit(source, ['commit', '--allow-empty', '-m', 'Not fetched yet']);
    fixtureGit(source, ['push', remote, 'main']);
    await writeFile(join(local, 'tracked.txt'), 'preserved edit\n');
    await expect(
      service.pull(repo.id, { mode: 'merge', revision: initial.revision }),
    ).rejects.toMatchObject({ code: 'PULL_DIRTY' });
    expect(await readFile(join(local, 'tracked.txt'), 'utf8')).toBe('preserved edit\n');
    fixtureGit(local, ['add', 'tracked.txt']);
    await expect(
      service.pull(repo.id, { mode: 'merge', revision: initial.revision }),
    ).rejects.toMatchObject({ code: 'STALE_PULL' });
    expect(fixtureGit(local, ['rev-parse', 'origin/main'])).toBe(oldRemote);
    fixtureGit(local, ['reset', '--hard', 'HEAD']);
    fixtureGit(local, ['branch', '--unset-upstream']);
    await expect(
      service.pull(repo.id, {
        mode: 'merge',
        revision: (await service.workingState(repo.id)).revision,
      }),
    ).rejects.toMatchObject({ code: 'PULL_UPSTREAM_REQUIRED' });
    fixtureGit(local, ['switch', '--detach']);
    await expect(
      service.pull(repo.id, {
        mode: 'merge',
        revision: (await service.workingState(repo.id)).revision,
      }),
    ).rejects.toMatchObject({ code: 'PULL_BRANCH_REQUIRED' });
    expect(fixtureGit(local, ['rev-parse', 'origin/main'])).toBe(oldRemote);
  } finally {
    await service.dispose();
  }
});
test('pull stops after fetch if the upstream configuration changes during transport', async () => {
  const { source, remote, local, service, repo } = await setup('upstream-race');
  try {
    const before = fixtureGit(local, ['rev-parse', 'HEAD']);
    fixtureGit(source, ['commit', '--allow-empty', '-m', 'Incoming commit']);
    fixtureGit(source, ['push', remote, 'main']);
    let changed = false;
    await expect(
      service.pull(
        repo.id,
        { mode: 'ff-only', revision: (await service.workingState(repo.id)).revision },
        undefined,
        () => {
          if (changed) return;
          changed = true;
          fixtureGit(local, ['config', 'branch.main.merge', 'refs/heads/another-branch']);
        },
      ),
    ).rejects.toMatchObject({ code: 'STALE_PULL' });
    expect(changed).toBe(true);
    expect(fixtureGit(local, ['rev-parse', 'HEAD'])).toBe(before);
    expect(fixtureGit(local, ['status', '--porcelain'])).toBe('');
  } finally {
    await service.dispose();
  }
});
