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

test('reviewed recursive update initializes nested submodules and fetches the exact recorded commit', async () => {
  const leaf = createFixture(join(root, 'update-leaf'), 'linear', 3);
  const child = createFixture(join(root, 'update-child'), 'linear', 2);
  add(child, leaf, 'nested');
  const original = createFixture(join(root, 'update-original'), 'linear', 2);
  add(original, child, 'child[1]');
  const path = join(root, 'update-parent');
  fixtureGit(root, ['clone', original, path]);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const parentHead = fixtureGit(path, ['rev-parse', 'HEAD']);
    const preview = await service.submoduleUpdatePreview(repo.id);
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0]?.state).toBe('uninitialized');
    expect((await service.submodules(repo.id)).entries[0]?.initialized).toBe(false);
    const initialized = await service.updateSubmodules(repo.id, preview.token, true);
    expect(initialized.entries.map((entry) => [entry.path, entry.state])).toEqual([
      ['child[1]', 'clean'],
      ['child[1]/nested', 'clean'],
    ]);
    await expect(service.updateSubmodules(repo.id, preview.token, true)).rejects.toMatchObject({
      code: 'STALE_SUBMODULE_UPDATE',
    });
    fixtureGit(child, ['commit', '--allow-empty', '-m', 'New child commit']);
    const target = fixtureGit(child, ['rev-parse', 'HEAD']);
    fixtureGit(path, ['update-index', '--cacheinfo', `160000,${target},child[1]`]);
    const next = await service.submoduleUpdatePreview(repo.id);
    const updated = await service.updateSubmodules(repo.id, next.token, true);
    expect(updated.entries[0]).toMatchObject({ head: target, indexOid: target, state: 'clean' });
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(parentHead);
    expect(fixtureGit(join(path, 'child[1]'), ['rev-parse', 'HEAD'])).toBe(target);
  } finally {
    await service.dispose();
  }
});

test('submodule update rejects stale reviews and preserves active and dormant local work', async () => {
  const source = createFixture(join(root, 'guard-source'), 'linear', 3);
  const path = createFixture(join(root, 'guard-parent'), 'linear', 2);
  add(path, source, 'child');
  const child = join(path, 'child');
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const head = fixtureGit(child, ['rev-parse', 'HEAD']);
    const preview = await service.submoduleUpdatePreview(repo.id);
    fixtureGit(path, ['config', 'submodule.child.url', source + '-changed']);
    await expect(service.updateSubmodules(repo.id, preview.token, true)).rejects.toMatchObject({
      code: 'STALE_SUBMODULE_UPDATE',
    });
    fixtureGit(path, ['config', 'submodule.child.url', source]);
    await writeFile(join(child, 'draft.txt'), 'keep draft');
    await expect(service.submoduleUpdatePreview(repo.id)).rejects.toMatchObject({
      code: 'SUBMODULE_NOT_CLEAN',
    });
    await rm(join(child, 'draft.txt'));
    await writeFile(join(child, '.gitignore'), 'ignored.txt\n');
    fixtureGit(child, ['add', '.gitignore']);
    fixtureGit(child, ['commit', '-m', 'Ignore local output']);
    await writeFile(join(child, 'ignored.txt'), 'keep ignored output');
    await expect(service.submoduleUpdatePreview(repo.id)).rejects.toMatchObject({
      code: 'SUBMODULE_NOT_CLEAN',
    });
    await rm(join(child, 'ignored.txt'));
    fixtureGit(child, ['update-index', '--assume-unchanged', '.gitignore']);
    await expect(service.submoduleUpdatePreview(repo.id)).rejects.toMatchObject({
      code: 'SUBMODULE_INDEX_FLAGS',
    });
    fixtureGit(child, ['update-index', '--no-assume-unchanged', '.gitignore']);
    fixtureGit(child, ['checkout', '--detach']);
    fixtureGit(child, ['commit', '--allow-empty', '-m', 'Detached work']);
    const detached = fixtureGit(child, ['rev-parse', 'HEAD']);
    await expect(service.submoduleUpdatePreview(repo.id)).rejects.toMatchObject({
      code: 'SUBMODULE_UNREFERENCED',
    });
    fixtureGit(child, ['branch', 'saved-work']);
    await writeFile(join(child, 'staged.txt'), 'keep staged work');
    fixtureGit(child, ['add', 'staged.txt']);
    // Simulate an offline/deinitialized checkout while retaining its index and objects.
    await rename(child, join(root, 'guard-offline-child'));
    await expect(service.submoduleUpdatePreview(repo.id)).rejects.toMatchObject({
      code: 'SUBMODULE_STAGED',
    });
    const stored = join(path, '.git/modules/child');
    expect(
      fixtureGit(path, [`--git-dir=${stored}`, `--work-tree=${path}`, 'rev-parse', 'HEAD']),
    ).toBe(detached);
    expect(
      fixtureGit(path, [`--git-dir=${stored}`, `--work-tree=${path}`, 'show', ':staged.txt']),
    ).toBe('keep staged work');
    expect(head).not.toBe(detached);
  } finally {
    await service.dispose();
  }
});

test('submodule initialization requires local transport opt-in and consumes failed update tokens', async () => {
  const source = createFixture(join(root, 'local-source'), 'linear', 2);
  const original = createFixture(join(root, 'local-original'), 'linear', 2);
  add(original, source, 'child');
  const path = join(root, 'local-parent');
  fixtureGit(root, ['clone', original, path]);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const preview = await service.submoduleUpdatePreview(repo.id);
    await expect(service.updateSubmodules(repo.id, preview.token, false)).rejects.toThrow(
      /transport.*file.*not allowed/,
    );
    expect((await service.submodules(repo.id)).entries[0]?.initialized).toBe(false);
    await expect(service.updateSubmodules(repo.id, preview.token, true)).rejects.toMatchObject({
      code: 'STALE_SUBMODULE_UPDATE',
    });
    const reviewed = await service.submoduleUpdatePreview(repo.id);
    expect((await service.updateSubmodules(repo.id, reviewed.token, true)).entries[0]?.state).toBe(
      'clean',
    );
  } finally {
    await service.dispose();
  }
});

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

test('recursive initialization enforces TLS verification and refuses external-helper URL rewrites', async () => {
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
  const path = createFixture(join(root, 'tls-parent'), 'linear', 2);
  const url = `https://127.0.0.1:${address.port}/repo.git`;
  const service = new RepositoryService('git');
  const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  try {
    fixtureGit(path, ['config', '--file', '.gitmodules', 'submodule.child.path', 'child']);
    fixtureGit(path, ['config', '--file', '.gitmodules', 'submodule.child.url', url]);
    fixtureGit(path, ['add', '.gitmodules']);
    fixtureGit(path, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${fixtureGit(path, ['rev-parse', 'HEAD'])},child`,
    ]);
    fixtureGit(path, ['config', `http.${url}.sslVerify`, 'false']);
    const repo = await service.open(path);
    const review = await service.submoduleUpdatePreview(repo.id);
    await expect(service.updateSubmodules(repo.id, review.token, false)).rejects.toMatchObject({
      code: 'TLS_CERTIFICATE_INVALID',
    });
    expect(requests).toBe(0);
    fixtureGit(path, ['config', 'submodule.child.url', 'https://rewrite.invalid/repo.git']);
    const globalConfig = join(root, 'submodule-global-config');
    fixtureGit(path, [
      'config',
      '--file',
      globalConfig,
      'url.ext::echo forbidden.insteadOf',
      'https://rewrite.invalid/repo.git',
    ]);
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    const rewritten = await service.submoduleUpdatePreview(repo.id);
    expect(rewritten.sources.some((source) => source.setting.includes('insteadof'))).toBe(true);
    await expect(service.updateSubmodules(repo.id, rewritten.token, true)).rejects.toThrow(
      /transport.*ext.*not allowed/i,
    );
  } finally {
    if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    await service.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
