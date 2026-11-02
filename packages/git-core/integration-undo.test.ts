import { afterAll, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepositoryService } from './src/repository.js';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-integration-undo-'));
afterAll(() => rm(root, { recursive: true, force: true }));
test('merge Undo and Redo restore native trees and reject newer edits to affected files', async () => {
  const path = createFixture(join(root, 'merge'));
  await writeFile(join(path, 'unchanged.txt'), 'original unrelated content\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Unrelated file']);
  const original = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['switch', '-c', 'incoming']);
  await writeFile(join(path, 'tracked.txt'), 'incoming content\n');
  await writeFile(join(path, 'added.txt'), 'added by merge\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Incoming']);
  const target = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['switch', 'main']);
  const service = new RepositoryService('git', { dataDir: join(root, 'profile') });
  try {
    const repo = await service.open(path);
    const before = await service.workingState(repo.id);
    const result = await service.startOperation(repo.id, {
      kind: 'merge',
      mode: 'no-ff',
      target,
      revision: before.revision,
    });
    expect(result.undo?.label).toBe('Merge (no-ff)');
    const after = fixtureGit(path, ['rev-parse', 'HEAD']);
    await writeFile(join(path, 'unrelated.txt'), 'keep this later work\n');
    await writeFile(join(path, 'unchanged.txt'), 'newer unrelated tracked edit\n');
    await service.undo(repo.id);
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
    expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('base\n');
    await expect(readFile(join(path, 'added.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(path, 'unrelated.txt'), 'utf8')).toBe('keep this later work\n');
    expect(await readFile(join(path, 'unchanged.txt'), 'utf8')).toBe(
      'newer unrelated tracked edit\n',
    );
    await service.undo(repo.id, true);
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(after);
    expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('incoming content\n');
    expect(await readFile(join(path, 'added.txt'), 'utf8')).toBe('added by merge\n');
    expect(await readFile(join(path, 'unchanged.txt'), 'utf8')).toBe(
      'newer unrelated tracked edit\n',
    );
    await writeFile(join(path, 'tracked.txt'), 'newer edit\n');
    await expect(service.undo(repo.id)).rejects.toMatchObject({ code: 'STALE_UNDO' });
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(after);
    expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('newer edit\n');
  } finally {
    await service.dispose();
  }
});
for (const kind of ['ff', 'squash', 'rebase', 'cherry-pick', 'revert'] as const)
  test(`${kind} integration restores HEAD, index and files across Undo and Redo`, async () => {
    const path = createFixture(join(root, kind));
    fixtureGit(path, ['switch', '-c', 'incoming']);
    await writeFile(join(path, 'tracked.txt'), 'incoming version\n');
    await writeFile(join(path, 'new.txt'), 'new content\n');
    fixtureGit(path, ['add', '.']);
    fixtureGit(path, ['commit', '-m', 'Incoming']);
    const target = fixtureGit(path, ['rev-parse', 'HEAD']);
    fixtureGit(path, ['switch', 'main']);
    if (kind === 'rebase') {
      await writeFile(join(path, 'local.txt'), 'local content\n');
      fixtureGit(path, ['add', '.']);
      fixtureGit(path, ['commit', '-m', 'Local commit']);
    }
    if (kind === 'revert') fixtureGit(path, ['merge', '--ff-only', 'incoming']);
    const original = fixtureGit(path, ['rev-parse', 'HEAD']);
    const originalTree = fixtureGit(path, ['write-tree']);
    const originalBytes = await readFile(join(path, 'tracked.txt'));
    const service = new RepositoryService('git', { dataDir: join(root, `${kind}-profile`) });
    try {
      const repo = await service.open(path);
      const state = await service.workingState(repo.id);
      await service.startOperation(
        repo.id,
        kind === 'ff' || kind === 'squash'
          ? { kind: 'merge', mode: kind, target, revision: state.revision }
          : { kind, target, revision: state.revision },
      );
      const after = fixtureGit(path, ['rev-parse', 'HEAD']);
      const afterTree = fixtureGit(path, ['write-tree']);
      const afterBytes = await readFile(join(path, 'tracked.txt'));
      await service.undo(repo.id);
      expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
      expect(fixtureGit(path, ['write-tree'])).toBe(originalTree);
      expect(await readFile(join(path, 'tracked.txt'))).toEqual(originalBytes);
      expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
      await service.undo(repo.id, true);
      expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(after);
      expect(fixtureGit(path, ['write-tree'])).toBe(afterTree);
      expect(await readFile(join(path, 'tracked.txt'))).toEqual(afterBytes);
      expect(fixtureGit(path, ['diff', '--name-only'])).toBe('');
    } finally {
      await service.dispose();
    }
  });
test('integration Undo verifies historical blob availability before changing refs or files', async () => {
  const path = createFixture(join(root, 'missing-blob'));
  await writeFile(join(path, 'tracked.txt'), 'historical loose blob\n');
  fixtureGit(path, ['commit', '-am', 'Original version']);
  const oldBlob = fixtureGit(path, ['rev-parse', 'HEAD:tracked.txt']);
  fixtureGit(path, ['switch', '-c', 'incoming']);
  await writeFile(join(path, 'tracked.txt'), 'current version\n');
  fixtureGit(path, ['commit', '-am', 'Incoming version']);
  const target = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['switch', 'main']);
  const service = new RepositoryService('git', { dataDir: join(root, 'missing-profile') });
  try {
    const repo = await service.open(path);
    const state = await service.workingState(repo.id);
    await service.startOperation(repo.id, {
      kind: 'merge',
      mode: 'ff',
      target,
      revision: state.revision,
    });
    await rm(join(path, '.git/objects', oldBlob.slice(0, 2), oldBlob.slice(2)));
    await expect(service.undo(repo.id)).rejects.toMatchObject({ code: 'UNDO_OBJECT_MISSING' });
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(target);
    expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('current version\n');
  } finally {
    await service.dispose();
  }
});
test.each(['merge', 'rebase', 'cherry-pick', 'revert'] as const)(
  'a conflicted %s completed after restart undoes the entire integration',
  async (kind) => {
    const path = createFixture(join(root, `paused-${kind}`));
    fixtureGit(path, ['switch', '-c', 'incoming']);
    await writeFile(join(path, 'tracked.txt'), 'incoming version\n');
    fixtureGit(path, ['commit', '-am', 'Incoming']);
    const target = fixtureGit(path, ['rev-parse', 'HEAD']);
    fixtureGit(path, ['switch', 'main']);
    await writeFile(join(path, 'tracked.txt'), 'original local version\n');
    fixtureGit(path, ['commit', '-am', 'Local']);
    const original = fixtureGit(path, ['rev-parse', 'HEAD']);
    const dataDir = join(root, `paused-${kind}-profile`);
    let service = new RepositoryService('git', { dataDir });
    try {
      let repo = await service.open(path);
      const state = await service.workingState(repo.id);
      await expect(
        service.startOperation(
          repo.id,
          kind === 'merge'
            ? { kind, mode: 'no-ff', target, revision: state.revision }
            : { kind, target, revision: state.revision },
        ),
      ).rejects.toMatchObject({ code: 'GIT_FAILED' });
      await service.dispose();
      service = new RepositoryService('git', { dataDir });
      repo = await service.open(path);
      const pathBytes = Buffer.from('tracked.txt').toString('base64');
      const preview = await service.conflictPreview(repo.id, pathBytes);
      await service.resolveConflict(repo.id, {
        pathBytes,
        token: preview.token,
        choice: 'output',
        text: 'combined resolution\n',
      });
      const operation = await service.operationState(repo.id);
      const completed = await service.operationAction(repo.id, {
        action: 'continue',
        token: operation.token,
      });
      expect(completed.undo?.label).toBe(kind === 'merge' ? 'Merge (no-ff)' : kind);
      const integrated = fixtureGit(path, ['rev-parse', 'HEAD']);
      await service.undo(repo.id);
      expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
      expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('original local version\n');
      expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
      expect((await service.workingState(repo.id)).undo).toBeUndefined();
      await service.undo(repo.id, true);
      expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(integrated);
      expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('combined resolution\n');
      expect((await service.operationState(repo.id)).kind).toBe('none');
    } finally {
      await service.dispose();
    }
  },
);
test.each(['abort', 'external-restart'] as const)(
  'operation origin is retired on %s',
  async (action) => {
    const path = createFixture(join(root, action));
    fixtureGit(path, ['switch', '-c', 'incoming']);
    await writeFile(join(path, 'tracked.txt'), 'incoming\n');
    fixtureGit(path, ['commit', '-am', 'Incoming']);
    const target = fixtureGit(path, ['rev-parse', 'HEAD']);
    fixtureGit(path, ['switch', 'main']);
    await writeFile(join(path, 'tracked.txt'), 'local\n');
    fixtureGit(path, ['commit', '-am', 'Local']);
    const service = new RepositoryService('git', { dataDir: join(root, `${action}-profile`) });
    try {
      const repo = await service.open(path);
      const state = await service.workingState(repo.id);
      await expect(
        service.startOperation(repo.id, {
          kind: 'merge',
          mode: 'no-ff',
          target,
          revision: state.revision,
        }),
      ).rejects.toThrow();
      if (action === 'external-restart') {
        fixtureGit(path, ['merge', '--abort']);
        // Recreate the same conflict externally: same commits do not imply the same operation.
        expect(() => fixtureGit(path, ['merge', '--no-ff', target])).toThrow();
        await writeFile(join(path, 'tracked.txt'), 'external resolution\n');
        fixtureGit(path, ['add', 'tracked.txt']);
      } else {
        const pathBytes = Buffer.from('tracked.txt').toString('base64');
        const preview = await service.conflictPreview(repo.id, pathBytes);
        await service.resolveConflict(repo.id, { pathBytes, token: preview.token, choice: 'ours' });
      }
      await service.operationAction(repo.id, {
        action: action === 'abort' ? 'abort' : 'continue',
        token: (await service.operationState(repo.id)).token,
      });
      expect((await service.operationState(repo.id)).kind).toBe('none');
      expect((await service.workingState(repo.id)).undo).toBeUndefined();
      expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
    } finally {
      await service.dispose();
    }
  },
);
test('rebase Skip retains its original checkpoint after an earlier commit was replayed', async () => {
  const path = createFixture(join(root, 'rebase-skip'));
  fixtureGit(path, ['switch', '-c', 'incoming']);
  await writeFile(join(path, 'tracked.txt'), 'incoming\n');
  fixtureGit(path, ['commit', '-am', 'Incoming']);
  const target = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['switch', 'main']);
  await writeFile(join(path, 'local.txt'), 'keep local commit\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Clean local commit']);
  await writeFile(join(path, 'tracked.txt'), 'original local content\n');
  fixtureGit(path, ['commit', '-am', 'Conflicted local commit']);
  const original = fixtureGit(path, ['rev-parse', 'HEAD']);
  const service = new RepositoryService('git', { dataDir: join(root, 'skip-profile') });
  try {
    const repo = await service.open(path);
    await expect(
      service.startOperation(repo.id, {
        kind: 'rebase',
        target,
        revision: (await service.workingState(repo.id)).revision,
      }),
    ).rejects.toMatchObject({ code: 'GIT_FAILED' });
    const state = await service.operationState(repo.id);
    expect(state.progress).toEqual({ current: 2, total: 2 });
    await service.operationAction(repo.id, { action: 'skip', token: state.token });
    const integrated = fixtureGit(path, ['rev-parse', 'HEAD']);
    expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('incoming\n');
    await service.undo(repo.id);
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(original);
    expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('original local content\n');
    expect(await readFile(join(path, 'local.txt'), 'utf8')).toBe('keep local commit\n');
    await service.undo(repo.id, true);
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(integrated);
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await service.dispose();
  }
});
test('an already-up-to-date integration preserves the available Redo', async () => {
  const path = createFixture(join(root, 'no-op'));
  const original = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['switch', '-c', 'incoming']);
  await writeFile(join(path, 'tracked.txt'), 'incoming\n');
  fixtureGit(path, ['commit', '-am', 'Incoming']);
  const target = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['switch', 'main']);
  const service = new RepositoryService('git', { dataDir: join(root, 'no-op-profile') });
  try {
    const repo = await service.open(path);
    await service.startOperation(repo.id, {
      kind: 'merge',
      mode: 'ff',
      target,
      revision: (await service.workingState(repo.id)).revision,
    });
    await service.undo(repo.id);
    const unchanged = await service.startOperation(repo.id, {
      kind: 'merge',
      mode: 'ff',
      target: original,
      revision: (await service.workingState(repo.id)).revision,
    });
    expect(unchanged.redo?.label).toBe('Merge (ff)');
    await service.undo(repo.id, true);
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(target);
  } finally {
    await service.dispose();
  }
});
