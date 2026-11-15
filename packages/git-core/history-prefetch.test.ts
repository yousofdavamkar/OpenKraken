import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { HistoryCursor } from './src/history.js';
import { RepositoryService } from './src/repository.js';
import * as runner from './src/runner.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-history-prefetch-'));
const source = join(root, 'source');

beforeAll(() => {
  createFixture(source, 'linear', 2070);
  fixtureGit(source, ['tag', '-d', 'annotated']);
  const tip = fixtureGit(source, ['rev-parse', 'HEAD']);
  const tags = Array.from({ length: 3200 }, (_, i) => {
    return `create refs/tags/${'t'.repeat(128)}-${i} ${tip}`;
  });
  fixtureGit(source, ['update-ref', '--stdin'], tags.join('\n') + '\n');
  fixtureGit(source, ['pack-refs', '--all']);
});
afterAll(() => rm(root, { recursive: true, force: true }));

// Both authoritative formats read tracking state and the worktree's HEAD marker.
function readsSnapshotRefs(args: string[]) {
  return (
    args[0] === 'for-each-ref' && args.some((arg) => arg.includes('%(upstream:track)%00%(HEAD)'))
  );
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function clone(name: string) {
  const path = join(root, name);
  fixtureGit(root, ['clone', '--mirror', '--shared', source, path]);
  expect((await stat(join(path, 'packed-refs'))).size).toBeGreaterThan(512 * 1024);
  return path;
}

test.each([
  'unchanged',
  'loose',
  'detached',
  'moved',
  'reordered',
  'replace',
  'annotated',
  'failed walk',
] as const)(
  'the first and appended pages match a normal native walk with %s roots',
  async (kind) => {
    const path = await clone(kind);
    const tree = fixtureGit(path, ['rev-parse', 'HEAD^{tree}']);
    const orphan = fixtureGit(path, ['commit-tree', tree, '-m', 'Independent root']);
    if (kind === 'loose') fixtureGit(path, ['update-ref', 'refs/heads/loose', orphan]);
    if (kind === 'detached') fixtureGit(path, ['update-ref', '--no-deref', 'HEAD', orphan]);
    if (kind === 'replace') fixtureGit(path, ['replace', 'HEAD~2050', orphan]);
    if (kind === 'annotated') fixtureGit(path, ['tag', '-a', 'annotation', '-m', 'Annotation']);
    if (kind === 'reordered') {
      fixtureGit(path, ['update-ref', 'refs/heads/a', 'HEAD~2']);
      fixtureGit(path, ['update-ref', 'refs/heads/b', orphan]);
    }
    const service = new RepositoryService('git');
    const repo = await service.open(path);
    const native = runner.runGit;
    const full = gate();
    const early = vi.fn();
    const ordinary = vi.fn();
    const run = vi.spyOn(runner, 'runGit').mockImplementation(async (git, args, options) => {
      if (readsSnapshotRefs(args)) await full.promise;
      if (args[0] === 'rev-list') {
        if (options?.env?.GIT_NO_REPLACE_OBJECTS) {
          early();
          if (kind === 'failed walk') throw new Error('Tentative walk failed');
        } else ordinary();
      }
      return native(git, args, options);
    });
    const snapshot = service.snapshot(repo.id, undefined, false);
    try {
      await vi.waitFor(() => expect(early).toHaveBeenCalledOnce(), { timeout: 5000 });
      if (kind === 'moved') fixtureGit(path, ['update-ref', 'refs/heads/new', orphan]);
      if (kind === 'reordered') {
        fixtureGit(path, ['update-ref', 'refs/heads/a', orphan]);
        fixtureGit(path, ['update-ref', 'refs/heads/b', 'HEAD~2']);
      }
      full.resolve();
      const first = await snapshot;
      expect(ordinary).toHaveBeenCalledTimes(
        ['unchanged', 'loose', 'detached'].includes(kind) ? 0 : 1,
      );
      const tail = await service.page(repo.id, first.cursor, 2000, 5000);
      expect(first.commits).toHaveLength(2000);
      expect(tail.offset).toBe(2000);
      expect(tail.hasMore).toBe(false);
      const reference = await service.snapshot(repo.id);
      expect(first.commits).toEqual(reference.commits);
      expect(tail.commits).toEqual(
        (await service.page(repo.id, reference.cursor, 2000, 5000)).commits,
      );
    } finally {
      full.resolve();
      await snapshot.catch(() => {});
      run.mockRestore();
      await service.dispose();
    }
  },
);

test('a slow optional ref read yields to the normal snapshot, and a warm prefix skips it', async () => {
  const path = await clone('slow');
  const profile = { dataDir: join(root, 'profile') };
  const service = new RepositoryService('git', profile);
  const repo = await service.open(path);
  const native = runner.runGit;
  const probe = gate();
  const completed = vi.fn();
  const run = vi.spyOn(runner, 'runGit').mockImplementation(async (git, args, options) => {
    if (args[0] === 'rev-parse' && args[1] === '--all') {
      probe.resolve();
      const signal = options!.signal!;
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      completed();
      throw new Error('Optional read cancelled');
    }
    if (readsSnapshotRefs(args)) await probe.promise;
    return native(git, args, options);
  });
  const warm = new RepositoryService('git', profile);
  const stop = AbortSignal.timeout(5000);
  try {
    const first = await service.snapshot(repo.id, stop, false);
    expect(completed).toHaveBeenCalledOnce();
    await service.dispose();
    const reopened = await warm.open(path);
    expect((await warm.snapshot(reopened.id, undefined, false)).commits).toEqual(first.commits);
    expect(
      run.mock.calls.filter(([, args]) => args[0] === 'rev-parse' && args[1] === '--all'),
    ).toHaveLength(1);
  } finally {
    run.mockRestore();
    await Promise.all([warm.dispose(), service.dispose()]);
  }
});

test('a failed authoritative ref read closes the unpublished cursor', async () => {
  const path = await clone('failed');
  const service = new RepositoryService('git');
  const repo = await service.open(path);
  const native = runner.runGit;
  const early = gate();
  const close = vi.spyOn(HistoryCursor.prototype, 'close');
  const run = vi.spyOn(runner, 'runGit').mockImplementation(async (git, args, options) => {
    if (args[0] === 'rev-list' && options?.env?.GIT_NO_REPLACE_OBJECTS) early.resolve();
    if (readsSnapshotRefs(args)) {
      await early.promise;
      throw new Error('Authoritative refs failed');
    }
    return native(git, args, options);
  });
  try {
    await expect(service.snapshot(repo.id, undefined, false)).rejects.toThrow(
      'Authoritative refs failed',
    );
    expect(close).toHaveBeenCalledOnce();
  } finally {
    early.resolve();
    run.mockRestore();
    close.mockRestore();
    await service.dispose();
  }
});

test('a solo view opens directly on its selected commit', async () => {
  const path = await clone('filtered');
  fixtureGit(path, ['update-ref', 'refs/heads/short', 'HEAD~2068']);
  const profile = { dataDir: join(root, 'filtered-profile') };
  const service = new RepositoryService('git', profile);
  const repo = await service.open(path);
  const run = vi.spyOn(runner, 'runGit');
  try {
    const first = await service.snapshot(repo.id, undefined, false, {
      hiddenRefs: [],
      soloRef: 'refs/heads/short',
    });
    expect(first.commits.map((commit) => commit.oid)).toEqual(
      fixtureGit(path, ['rev-list', 'refs/heads/short']).split('\n'),
    );
    expect(first.hasMore).toBe(false);
    expect(run.mock.calls.some(([, args]) => args[0] === 'rev-parse' && args[1] === '--all')).toBe(
      false,
    );
  } finally {
    run.mockRestore();
    await service.dispose();
  }
});
