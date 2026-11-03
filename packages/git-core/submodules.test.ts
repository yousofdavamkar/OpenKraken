import { afterAll, expect, test } from 'vitest';
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-submodules-'));
afterAll(() => rm(root, { recursive: true, force: true }));
function add(parent: string, source: string, path: string) {
  fixtureGit(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--', source, path]);
  fixtureGit(parent, ['commit', '-am', 'Register submodule']);
}

test('submodule discovery refuses ambiguous or redirected configuration and bounds inventory size', async () => {
  const source = createFixture(join(root, 'config-source'), 'linear', 2);
  const path = createFixture(join(root, 'config-parent'), 'linear', 2);
  add(path, source, 'child');
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    fixtureGit(path, ['config', '--file', '.gitmodules', 'submodule.duplicate.path', 'child']);
    await expect(service.submodules(repo.id)).rejects.toMatchObject({ code: 'SUBMODULE_CONFIG' });
    fixtureGit(path, [
      'config',
      '--file',
      '.gitmodules',
      '--remove-section',
      'submodule.duplicate',
    ]);
    const saved = join(root, 'redirected.gitmodules');
    await rename(join(path, '.gitmodules'), saved);
    await symlink(saved, join(path, '.gitmodules'));
    await expect(service.submodules(repo.id)).rejects.toMatchObject({ code: 'SUBMODULE_CONFIG' });
    await rm(join(path, '.gitmodules'));
    await rename(saved, join(path, '.gitmodules'));
    const oid = fixtureGit(source, ['rev-parse', 'HEAD']);
    fixtureGit(
      path,
      ['update-index', '--index-info'],
      Array.from({ length: 256 }, (_, index) => `160000 ${oid}\tmissing-${index}\n`).join(''),
    );
    await expect(service.submodules(repo.id)).rejects.toMatchObject({ code: 'SUBMODULE_LIMIT' });
  } finally {
    await service.dispose();
  }
});

test('submodule discovery preserves Unicode and newline paths, refuses symlink folders and ignores config-only paths', async () => {
  const source = createFixture(join(root, 'paths-source'), 'linear', 3);
  const path = createFixture(join(root, 'paths-parent'), 'linear', 2);
  const relative = 'modules/é\nchild';
  fixtureGit(path, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--name',
    'unicode-child',
    '--',
    source,
    relative,
  ]);
  fixtureGit(path, ['commit', '-am', 'Submodule with unusual path']);
  fixtureGit(path, ['config', '--file', '.gitmodules', 'submodule.outside.path', '../outside']);
  fixtureGit(path, ['config', '--file', '.gitmodules', 'submodule.outside.url', source]);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const state = await service.submodules(repo.id);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({
      path: relative,
      name: 'unicode-child',
      url: source,
      state: 'clean',
    });
    expect((await service.openSubmodule(repo.id, state.entries[0]!.id, state.revision)).path).toBe(
      join(path, relative),
    );
    const saved = join(root, 'saved-unicode-checkout');
    await rename(join(path, relative), saved);
    await symlink(saved, join(path, relative));
    const changed = await service.submodules(repo.id);
    expect(changed.entries[0]).toMatchObject({ state: 'unavailable', available: false });
    await expect(
      service.openSubmodule(repo.id, state.entries[0]!.id, state.revision),
    ).rejects.toMatchObject({ code: 'STALE_SUBMODULES' });
    await expect(
      service.openSubmodule(repo.id, state.entries[0]!.id, changed.revision),
    ).rejects.toMatchObject({ code: 'SUBMODULE_UNAVAILABLE' });
  } finally {
    await service.dispose();
  }
});

test('submodule inspection retains conflict stages, revalidates Git directory identity and supports cancellation', async () => {
  const source = createFixture(join(root, 'identity-source'), 'linear', 3);
  const path = createFixture(join(root, 'identity-parent'), 'linear', 2);
  add(path, source, 'child');
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const initial = await service.submodules(repo.id);
    const child = initial.entries[0]!;
    await expect(
      service.openSubmodule(repo.id, 'a'.repeat(64), initial.revision),
    ).rejects.toMatchObject({ code: 'SUBMODULE_NOT_FOUND' });
    const pointer = await readFile(join(path, 'child/.git'));
    await writeFile(join(path, 'child/.git'), `gitdir: ${repo.gitDir}\n`);
    expect((await service.submodules(repo.id)).entries[0]?.state).toBe('unavailable');
    await expect(service.openSubmodule(repo.id, child.id, initial.revision)).rejects.toMatchObject({
      code: 'STALE_SUBMODULES',
    });
    await writeFile(join(path, 'child/.git'), pointer);
    const old = fixtureGit(source, ['rev-parse', 'HEAD~1']);
    fixtureGit(
      path,
      ['update-index', '--index-info'],
      `0 ${'0'.repeat(40)}\tchild\n160000 ${old} 1\tchild\n160000 ${child.indexOid} 2\tchild\n160000 ${old} 3\tchild\n`,
    );
    expect((await service.submodules(repo.id)).entries[0]).toMatchObject({
      state: 'conflict',
      initialized: true,
      available: true,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(service.submodules(repo.id, controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    const bare = join(root, 'submodule-bare.git');
    fixtureGit(path, ['clone', '--bare', '.', bare]);
    await expect(service.submodules((await service.open(bare)).id)).rejects.toMatchObject({
      code: 'BARE_REPOSITORY',
    });
  } finally {
    await service.dispose();
  }
});

test('submodules expose recursive checkout state and open only a reviewed initialized entry', async () => {
  const leaf = createFixture(join(root, 'leaf'), 'linear', 3);
  const child = createFixture(join(root, 'child'), 'linear', 2);
  add(child, leaf, 'nested');
  const path = createFixture(join(root, 'parent'), 'linear', 2);
  add(path, child, 'modules/child');
  add(path, leaf, 'offline');
  fixtureGit(path, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'update',
    '--init',
    '--recursive',
  ]);
  fixtureGit(path, ['submodule', 'deinit', '--', 'offline']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const initial = await service.submodules(repo.id);
    expect(initial.entries.map((entry) => [entry.path, entry.state])).toEqual([
      ['modules/child', 'clean'],
      ['modules/child/nested', 'clean'],
      ['offline', 'uninitialized'],
    ]);
    const nested = initial.entries.find((entry) => entry.path === 'modules/child/nested')!;
    expect(nested.depth).toBe(1);
    expect((await service.openSubmodule(repo.id, nested.id, initial.revision)).path).toBe(
      join(path, nested.path),
    );
    const offline = initial.entries.find((entry) => entry.path === 'offline')!;
    await expect(
      service.openSubmodule(repo.id, offline.id, initial.revision),
    ).rejects.toMatchObject({ code: 'SUBMODULE_UNAVAILABLE' });
    await writeFile(join(path, nested.path, 'draft.txt'), 'nested draft');
    const dirty = await service.submodules(repo.id);
    expect(dirty.entries.find((entry) => entry.id === nested.id)).toMatchObject({
      state: 'modified',
      changedFiles: 1,
    });
    await expect(service.openSubmodule(repo.id, nested.id, initial.revision)).rejects.toMatchObject(
      { code: 'STALE_SUBMODULES' },
    );
    await rm(join(path, nested.path, 'draft.txt'));
    fixtureGit(join(path, nested.path), ['checkout', '--detach', 'HEAD~1']);
    expect(
      (await service.submodules(repo.id)).entries.find((entry) => entry.id === nested.id),
    ).toMatchObject({ state: 'out-of-date', outOfDate: true });
  } finally {
    await service.dispose();
  }
});
