import { afterAll, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepositoryService } from './src/repository.js';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-conflicts-'));
afterAll(() => rm(root, { recursive: true, force: true }));
async function conflict(name: string) {
  const path = createFixture(join(root, name));
  fixtureGit(path, ['switch', '-c', 'incoming']);
  await writeFile(join(path, 'tracked.txt'), 'theirs\n');
  fixtureGit(path, ['commit', '-am', 'Theirs']);
  fixtureGit(path, ['switch', 'main']);
  await writeFile(join(path, 'tracked.txt'), 'ours\n');
  fixtureGit(path, ['commit', '-am', 'Ours']);
  expect(() => fixtureGit(path, ['merge', 'incoming'])).toThrow();
  const service = new RepositoryService('git', { dataDir: join(root, `${name}-profile`) });
  const repo = await service.open(path);
  return { path, service, repo };
}
test('conflict previews expose three native stages and saving output stages it with Undo', async () => {
  const { path, service, repo } = await conflict('editable');
  try {
    const pathBytes = Buffer.from('tracked.txt').toString('base64');
    const preview = await service.conflictPreview(repo.id, pathBytes);
    expect(preview).toMatchObject({
      base: { text: 'base\n' },
      ours: { text: 'ours\n' },
      theirs: { text: 'theirs\n' },
      editable: true,
    });
    const original = await readFile(join(path, 'tracked.txt'));
    const stages = fixtureGit(path, ['ls-files', '--unmerged']);
    await service.resolveConflict(repo.id, {
      pathBytes,
      token: preview.token,
      choice: 'output',
      text: 'resolved output\n',
    });
    expect(fixtureGit(path, ['ls-files', '--unmerged'])).toBe('');
    expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('resolved output');
    expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('resolved output\n');
    await service.undo(repo.id);
    expect(fixtureGit(path, ['ls-files', '--unmerged'])).toBe(stages);
    expect(await readFile(join(path, 'tracked.txt'))).toEqual(original);
    await service.undo(repo.id, true);
    expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('resolved output');
  } finally {
    await service.dispose();
  }
});
test('whole-side conflict resolution preserves binary bytes and stale resolutions cannot overwrite edits', async () => {
  const path = createFixture(join(root, 'binary'));
  fixtureGit(path, ['switch', '-c', 'incoming']);
  const theirs = Buffer.from([0, 3, 255, 11]);
  await writeFile(join(path, 'tracked.txt'), theirs);
  fixtureGit(path, ['commit', '-am', 'Theirs binary']);
  fixtureGit(path, ['switch', 'main']);
  await writeFile(join(path, 'tracked.txt'), Buffer.from([0, 2, 254, 12]));
  fixtureGit(path, ['commit', '-am', 'Ours binary']);
  expect(() => fixtureGit(path, ['merge', 'incoming'])).toThrow();
  const service = new RepositoryService('git', { dataDir: join(root, 'binary-profile') });
  try {
    const repo = await service.open(path),
      pathBytes = Buffer.from('tracked.txt').toString('base64');
    const preview = await service.conflictPreview(repo.id, pathBytes);
    expect(preview).toMatchObject({
      editable: false,
      ours: { binary: true },
      theirs: { binary: true },
    });
    await writeFile(join(path, 'tracked.txt'), 'newer manual edits\n');
    await expect(
      service.resolveConflict(repo.id, { pathBytes, token: preview.token, choice: 'theirs' }),
    ).rejects.toMatchObject({ code: 'STALE_CONFLICT' });
    const current = await service.conflictPreview(repo.id, pathBytes);
    await service.resolveConflict(repo.id, { pathBytes, token: current.token, choice: 'theirs' });
    expect(await readFile(join(path, 'tracked.txt'))).toEqual(theirs);
    expect(fixtureGit(path, ['ls-files', '--unmerged'])).toBe('');
    await service.undo(repo.id);
    expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('newer manual edits\n');
    expect(fixtureGit(path, ['ls-files', '--unmerged'])).not.toBe('');
  } finally {
    await service.dispose();
  }
});
for (const kind of ['add/add', 'delete/modify', 'rename/modify'] as const)
  test(`${kind} conflict resolves from native stages and can restore them`, async () => {
    const name = kind.replace('/', '-');
    const path = createFixture(join(root, name));
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}\n`);
    await writeFile(join(path, 'tracked.txt'), lines.join(''));
    fixtureGit(path, ['commit', '-am', 'Common text']);
    fixtureGit(path, ['switch', '-c', 'incoming']);
    const conflicted = kind === 'add/add' ? 'added file.txt' : 'tracked.txt';
    await writeFile(join(path, conflicted), ['theirs\n', ...lines.slice(1)].join(''));
    fixtureGit(path, ['add', '.']);
    fixtureGit(path, ['commit', '-m', 'Theirs']);
    fixtureGit(path, ['switch', 'main']);
    if (kind === 'delete/modify') fixtureGit(path, ['rm', 'tracked.txt']);
    else {
      if (kind === 'rename/modify') fixtureGit(path, ['mv', 'tracked.txt', 'renamed.txt']);
      await writeFile(
        join(path, kind === 'rename/modify' ? 'renamed.txt' : conflicted),
        ['ours\n', ...lines.slice(1)].join(''),
      );
      fixtureGit(path, ['add', '.']);
    }
    fixtureGit(path, ['commit', '-m', 'Ours']);
    expect(() => fixtureGit(path, ['merge', 'incoming'])).toThrow();
    const service = new RepositoryService('git', { dataDir: join(root, `${name}-profile`) });
    try {
      const repo = await service.open(path);
      const filename = kind === 'rename/modify' ? 'renamed.txt' : conflicted;
      const pathBytes = Buffer.from(filename).toString('base64');
      const preview = await service.conflictPreview(repo.id, pathBytes);
      if (kind === 'add/add') expect(preview.base).toBeUndefined();
      if (kind === 'delete/modify') expect(preview.ours).toBeUndefined();
      const stages = fixtureGit(path, ['ls-files', '--unmerged']);
      await service.resolveConflict(repo.id, { pathBytes, token: preview.token, choice: 'ours' });
      expect(fixtureGit(path, ['ls-files', '--unmerged'])).toBe('');
      if (kind === 'delete/modify')
        await expect(readFile(join(path, filename))).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(fixtureGit(path, ['show', `:${filename}`])).toContain('ours');
      await service.undo(repo.id);
      expect(fixtureGit(path, ['ls-files', '--unmerged'])).toBe(stages);
    } finally {
      await service.dispose();
    }
  });
test('submodule conflict resolves only the gitlink and preserves submodule working files', async () => {
  const child = createFixture(join(root, 'child'));
  const base = fixtureGit(child, ['rev-parse', 'HEAD']);
  fixtureGit(child, ['switch', '-c', 'incoming']);
  fixtureGit(child, ['commit', '--allow-empty', '-m', 'Theirs child']);
  const theirs = fixtureGit(child, ['rev-parse', 'HEAD']);
  fixtureGit(child, ['switch', 'main']);
  fixtureGit(child, ['commit', '--allow-empty', '-m', 'Ours child']);
  const ours = fixtureGit(child, ['rev-parse', 'HEAD']);
  const path = createFixture(join(root, 'submodule'));
  fixtureGit(path, ['-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'module']);
  fixtureGit(join(path, 'module'), ['checkout', base]);
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Common submodule']);
  fixtureGit(path, ['switch', '-c', 'incoming']);
  fixtureGit(join(path, 'module'), ['checkout', theirs]);
  fixtureGit(path, ['add', 'module']);
  fixtureGit(path, ['commit', '-m', 'Theirs gitlink']);
  fixtureGit(path, ['switch', 'main']);
  fixtureGit(join(path, 'module'), ['checkout', ours]);
  fixtureGit(path, ['add', 'module']);
  fixtureGit(path, ['commit', '-m', 'Ours gitlink']);
  expect(() => fixtureGit(path, ['merge', 'incoming'])).toThrow();
  await writeFile(join(path, 'module/local.txt'), 'keep submodule work\n');
  const service = new RepositoryService('git', { dataDir: join(root, 'submodule-profile') });
  try {
    const repo = await service.open(path),
      pathBytes = Buffer.from('module').toString('base64');
    const preview = await service.conflictPreview(repo.id, pathBytes);
    expect(preview).toMatchObject({
      editable: false,
      working: { kind: 'submodule' },
      ours: { oid: ours, mode: '160000' },
      theirs: { oid: theirs },
    });
    await service.resolveConflict(repo.id, { pathBytes, token: preview.token, choice: 'theirs' });
    expect(fixtureGit(path, ['ls-files', '--stage', 'module'])).toBe(`160000 ${theirs} 0\tmodule`);
    expect(fixtureGit(join(path, 'module'), ['rev-parse', 'HEAD'])).toBe(ours);
    expect(await readFile(join(path, 'module/local.txt'), 'utf8')).toBe('keep submodule work\n');
    await service.undo(repo.id);
    expect(fixtureGit(path, ['ls-files', '--unmerged'])).toContain(`160000 ${ours} 2\tmodule`);
  } finally {
    await service.dispose();
  }
});
test('configured external merge tool stages its result and remains undoable', async () => {
  const { path, service, repo } = await conflict('external-tool');
  try {
    fixtureGit(path, ['config', 'merge.tool', 'fixture']);
    fixtureGit(path, [
      'config',
      'mergetool.fixture.cmd',
      'printf "external resolution\\n" > "$MERGED"',
    ]);
    fixtureGit(path, ['config', 'mergetool.fixture.trustExitCode', 'true']);
    fixtureGit(path, ['config', 'mergetool.keepBackup', 'false']);
    const pathBytes = Buffer.from('tracked.txt').toString('base64');
    const preview = await service.conflictPreview(repo.id, pathBytes);
    expect(preview.externalTool).toBe('fixture');
    const original = await readFile(join(path, 'tracked.txt'));
    await service.resolveConflict(repo.id, { pathBytes, token: preview.token, choice: 'external' });
    expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('external resolution');
    expect(fixtureGit(path, ['ls-files', '--unmerged'])).toBe('');
    await service.undo(repo.id);
    expect(await readFile(join(path, 'tracked.txt'))).toEqual(original);
    expect(fixtureGit(path, ['ls-files', '--unmerged'])).not.toBe('');
  } finally {
    await service.dispose();
  }
});
test('whole-side selection retains the selected executable mode even when core.filemode is disabled', async () => {
  const { path, service, repo } = await conflict('mode');
  try {
    const theirs = fixtureGit(path, ['rev-parse', ':3:tracked.txt']);
    fixtureGit(path, ['update-index', '--index-info'], `100755 ${theirs} 3\ttracked.txt\n`);
    fixtureGit(path, ['config', 'core.filemode', 'false']);
    const pathBytes = Buffer.from('tracked.txt').toString('base64');
    const preview = await service.conflictPreview(repo.id, pathBytes);
    await service.resolveConflict(repo.id, { pathBytes, token: preview.token, choice: 'theirs' });
    expect(fixtureGit(path, ['ls-files', '--stage', 'tracked.txt'])).toBe(
      `100755 ${theirs} 0\ttracked.txt`,
    );
  } finally {
    await service.dispose();
  }
});
test('cancelling an external merge tool preserves partial edits for Undo', async () => {
  const { path, service, repo } = await conflict('cancel-external');
  try {
    fixtureGit(path, ['config', 'merge.tool', 'fixture']);
    fixtureGit(path, [
      'config',
      'mergetool.fixture.cmd',
      'printf "partial external edit\\n" > "$MERGED"; sleep 30',
    ]);
    fixtureGit(path, ['config', 'mergetool.fixture.trustExitCode', 'true']);
    const pathBytes = Buffer.from('tracked.txt').toString('base64');
    const preview = await service.conflictPreview(repo.id, pathBytes);
    const original = await readFile(join(path, 'tracked.txt'));
    const abort = new AbortController();
    const result = service
      .resolveConflict(
        repo.id,
        { pathBytes, token: preview.token, choice: 'external' },
        abort.signal,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    let wrote = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await readFile(join(path, 'tracked.txt'), 'utf8')) === 'partial external edit\n') {
          wrote = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      abort.abort();
    }
    expect(wrote).toBe(true);
    expect(await result).toMatchObject({ code: 'CANCELLED' });
    await service.undo(repo.id);
    expect(await readFile(join(path, 'tracked.txt'))).toEqual(original);
    expect(fixtureGit(path, ['ls-files', '--unmerged'])).not.toBe('');
  } finally {
    await service.dispose();
  }
});
