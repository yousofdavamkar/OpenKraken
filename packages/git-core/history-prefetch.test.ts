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

// Every direct or complete snapshot format includes the worktree's HEAD marker,
// even when Git has already confirmed the tracking fields are empty.
function readsSnapshotRefs(args: string[]) {
  return args[0] === 'for-each-ref' && args.some((arg) => arg.endsWith('%00%(HEAD)%00'));
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
  'nested annotations',
  'moved annotation',
  'reordered annotations',
  'tree annotation',
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
    if (kind === 'tree annotation') fixtureGit(path, ['tag', '-a', 'tree', tree, '-m', 'Tree']);
    if (kind === 'nested annotations' || kind === 'moved annotation') {
      fixtureGit(path, ['tag', '-a', 'inner', orphan, '-m', 'Inner']);
      fixtureGit(path, ['tag', '-a', 'outer', 'inner', '-m', 'Outer']);
      fixtureGit(path, ['tag', '-a', 'other', orphan, '-m', 'Same commit, different tag']);
      fixtureGit(path, ['tag', '-d', 'inner']);
    }
    if (kind === 'reordered annotations') {
      fixtureGit(path, ['tag', '-a', 'left', orphan, '-m', 'Independent tip']);
      fixtureGit(path, ['tag', '-a', 'right', 'HEAD~2', '-m', 'Older tip']);
    }
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
      if (kind === 'reordered annotations') {
        const left = fixtureGit(path, ['rev-parse', 'refs/tags/left']);
        const right = fixtureGit(path, ['rev-parse', 'refs/tags/right']);
        fixtureGit(
          path,
          ['update-ref', '--stdin'],
          `update refs/tags/left ${right}\nupdate refs/tags/right ${left}\n`,
        );
      }
      if (kind === 'moved annotation') {
        fixtureGit(path, ['tag', '-f', 'outer', 'HEAD~2']);
        fixtureGit(path, ['tag', '-d', 'other']);
      }
      if (kind === 'moved') fixtureGit(path, ['update-ref', 'refs/heads/new', orphan]);
      if (kind === 'reordered') {
        fixtureGit(path, ['update-ref', 'refs/heads/a', orphan]);
        fixtureGit(path, ['update-ref', 'refs/heads/b', 'HEAD~2']);
      }
      full.resolve();
      const first = await snapshot;
      expect(ordinary).toHaveBeenCalledTimes(
        ['unchanged', 'loose', 'detached', 'annotated', 'nested annotations'].includes(kind)
          ? 0
          : 1,
      );
      const tail = await service.page(repo.id, first.cursor, 2000, 5000);
      expect(first.commits).toHaveLength(2000);
      expect(tail.offset).toBe(2000);
      expect(tail.hasMore).toBe(false);
      if (kind === 'nested annotations') {
        const match = await service.search(repo.id, first.cursor, orphan);
        expect(match.commits.map((commit) => commit.oid)).toEqual([orphan]);
        expect(
          run.mock.calls.some(
            ([, args]) => args.includes('--max-count=1') && args[0] === 'rev-list',
          ),
        ).toBe(false);
      }
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

test.each(['hidden', 'hidden HEAD', 'solo', 'moved solo', 'Unicode solo', 'detached'] as const)(
  'a saved %s view starts a filtered walk before full metadata and preserves exact paging',
  async (kind) => {
    const path = await clone('view-' + kind);
    const short = 'refs/heads/short';
    fixtureGit(path, ['update-ref', short, 'HEAD~2068']);
    const tree = fixtureGit(path, ['rev-parse', 'HEAD^{tree}']);
    const independent = fixtureGit(path, ['commit-tree', tree, '-m', 'Independent root']);
    const branch = 'refs/heads/main';
    const unicode = 'refs/tags/末尾\u00a0';
    if (kind === 'Unicode solo') fixtureGit(path, ['update-ref', unicode, 'HEAD']);
    if (kind === 'detached') fixtureGit(path, ['update-ref', '--no-deref', 'HEAD', independent]);
    if (kind === 'hidden HEAD') fixtureGit(path, ['update-ref', branch, independent]);
    const solo = kind.includes('solo');
    const view = solo
      ? { hiddenRefs: [], soloRef: kind === 'Unicode solo' ? unicode : branch }
      : { hiddenRefs: [kind === 'hidden HEAD' ? branch : short] };
    // Hidden views with mostly distinct packed targets benefit from the named root read.
    if (!solo) {
      const commits = fixtureGit(path, ['rev-list', '--max-count=2070', 'refs/tags/v0.1.0']).split(
        '\n',
      );
      fixtureGit(
        path,
        ['update-ref', '--stdin'],
        commits
          .map((oid, i) => `create refs/heads/start-${'x'.repeat(120)}-${i} ${oid}`)
          .join('\n') + '\n',
      );
      fixtureGit(path, ['pack-refs', '--all']);
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
        if (options?.env?.GIT_NO_REPLACE_OBJECTS) early(options.stdin);
        else ordinary();
      }
      return native(git, args, options);
    });
    const opening = service.snapshot(repo.id, undefined, false, view);
    try {
      await vi.waitFor(() => expect(early).toHaveBeenCalledOnce(), { timeout: 2000 });
      if (kind === 'moved solo') fixtureGit(path, ['update-ref', view.soloRef!, 'HEAD~20']);
      if (solo)
        expect(early.mock.calls[0]![0]).toBe(
          fixtureGit(path, ['rev-parse', 'refs/tags/v0.1.0']) + '\n',
        );
      full.resolve();
      const first = await opening;
      expect(ordinary).toHaveBeenCalledTimes(kind === 'moved solo' ? 1 : 0);
      const tail = await service.page(repo.id, first.cursor, first.commits.length, 5000);
      const expected = await service.snapshot(repo.id, undefined, true, view);
      expect(first.commits).toEqual(expected.commits);
      expect(tail.commits).toEqual(
        (await service.page(repo.id, expected.cursor, expected.commits.length, 5000)).commits,
      );
      expect(first.hasMore).toBe(true);
      expect(tail.hasMore).toBe(false);
      if (kind === 'detached' || kind === 'hidden HEAD')
        expect(first.commits.some((c) => c.oid === independent)).toBe(kind === 'detached');
    } finally {
      full.resolve();
      await opening.catch(() => {});
      run.mockRestore();
      await service.dispose();
    }
  },
);

test('a hidden view with repeated packed targets needs one native root enumeration', async () => {
  const path = await clone('grouped-hidden');
  const service = new RepositoryService('git');
  const repo = await service.open(path);
  const run = vi.spyOn(runner, 'runGit');
  try {
    const view = { hiddenRefs: ['refs/heads/main'] };
    const first = await service.snapshot(repo.id, undefined, false, view);
    expect(first.commits).toHaveLength(2000);
    expect(
      run.mock.calls.some(([, args]) => args.includes('--format=%(objectname) %(refname)')),
    ).toBe(false);
    expect(
      run.mock.calls.some(
        ([, args, options]) => args[0] === 'rev-list' && options?.env?.GIT_NO_REPLACE_OBJECTS,
      ),
    ).toBe(false);
  } finally {
    run.mockRestore();
    await service.dispose();
  }
});

test('an empty replacement namespace follows Git across the first page and append', async () => {
  const path = await clone('custom-replacements');
  const original = fixtureGit(path, ['rev-parse', 'HEAD~2050']);
  const tree = fixtureGit(path, ['rev-parse', 'HEAD^{tree}']);
  const replacement = fixtureGit(path, ['commit-tree', tree, '-m', 'Replacement root']);
  fixtureGit(path, ['update-ref', 'refs/custom/' + original, replacement]);
  vi.stubEnv('GIT_REPLACE_REF_BASE', '');
  const service = new RepositoryService('git');
  const run = vi.spyOn(runner, 'runGit');
  try {
    const repo = await service.open(path);
    const first = await service.snapshot(repo.id, undefined, false);
    expect(first.hasMore).toBe(true);
    const tail = await service.page(repo.id, first.cursor, first.commits.length, 5000);
    const records = [...first.commits, ...tail.commits].map((c) => [c.oid, ...c.parents].join(' '));
    expect(records).toEqual(
      fixtureGit(path, ['rev-list', '--date-order', '--parents', '--all']).split('\n'),
    );
    expect(records).toContain(original);
    expect(tail.hasMore).toBe(false);
    expect(run.mock.calls.some(([, args]) => args.includes('--no-replace-objects'))).toBe(false);
    expect(run.mock.calls.some(([, args]) => args[0] === 'rev-parse' && args[1] === '--all')).toBe(
      false,
    );
  } finally {
    run.mockRestore();
    vi.unstubAllEnvs();
    await service.dispose();
  }
});

test.each(['none', 'loose', 'packed'] as const)(
  'a packed sample pointing to HEAD preserves history with an additional root (%s)',
  async (extraRoot) => {
    const path = await clone('shared-head-' + extraRoot);
    fixtureGit(path, ['update-ref', '-d', 'refs/remotes/origin/main']);
    fixtureGit(path, ['pack-refs', '--all']);
    if (extraRoot !== 'none') {
      const tree = fixtureGit(path, ['rev-parse', 'HEAD^{tree}']);
      const independent = fixtureGit(path, ['commit-tree', tree, '-m', 'Independent root']);
      // The tag sorts after the bounded packed sample.
      fixtureGit(path, ['update-ref', 'refs/tags/zzz-independent', independent]);
      if (extraRoot === 'packed') fixtureGit(path, ['pack-refs', '--all']);
    }
    const service = new RepositoryService('git');
    const repo = await service.open(path);
    const native = runner.runGit;
    const started = gate();
    const calls = vi.spyOn(runner, 'runGit').mockImplementation(async (git, args, options) => {
      if (readsSnapshotRefs(args)) await started.promise;
      if (args[0] === 'rev-list' && options?.env?.GIT_NO_REPLACE_OBJECTS) started.resolve();
      return native(git, args, options);
    });
    const snapshot = service.snapshot(repo.id, undefined, false);
    try {
      await vi.waitFor(
        () => expect(calls.mock.calls.some(([, args]) => args[0] === 'rev-list')).toBe(true),
        { timeout: 5000 },
      );
      const first = await snapshot;
      const next = await service.page(repo.id, first.cursor, first.commits.length, 5000);
      expect(next.hasMore).toBe(false);
      const records = [...first.commits, ...next.commits].map((c) =>
        [c.oid, ...c.parents].join(' '),
      );
      expect(records).toEqual(
        fixtureGit(path, ['rev-list', '--date-order', '--parents', '--all']).split('\n'),
      );
      expect(
        calls.mock.calls.some(([, args]) => args[0] === 'rev-parse' && args[1] === '--all'),
      ).toBe(false);
      expect(calls.mock.calls.filter(([, args]) => args[0] === 'rev-list')).toHaveLength(
        extraRoot === 'none' ? 1 : 2,
      );
    } finally {
      started.resolve();
      await snapshot.catch(() => {});
      calls.mockRestore();
      await service.dispose();
    }
  },
);

test.each([false, true])(
  'an annotated alias sample preserves ordered roots with a later independent tip (%s)',
  async (laterTip) => {
    const path = await clone('tag-sample-' + laterTip);
    const tree = fixtureGit(path, ['rev-parse', 'HEAD^{tree}']);
    const orphan = fixtureGit(path, [
      'commit-tree',
      tree,
      '-m',
      'Reachable only through annotations',
    ]);
    fixtureGit(path, ['tag', '-a', '000-00-tree', tree, '-m', 'Non-commit annotation']);
    fixtureGit(path, ['tag', '-a', 'inner', orphan, '-m', 'Inner']);
    fixtureGit(path, ['tag', '-a', 'outer', 'inner', '-m', 'Outer']);
    const tag = fixtureGit(path, ['rev-parse', 'outer']);
    fixtureGit(
      path,
      ['update-ref', '--stdin'],
      Array.from(
        { length: 160 },
        (_, i) => 'create refs/tags/000-alias-' + i + ' ' + tag + '\n',
      ).join(''),
    );
    fixtureGit(path, ['tag', '-d', 'inner', 'outer']);
    if (laterTip) {
      const independent = fixtureGit(path, ['commit-tree', tree, '-m', 'Outside the sample']);
      fixtureGit(path, ['update-ref', 'refs/tags/zzz-independent', independent]);
    }
    fixtureGit(path, ['pack-refs', '--all']);
    const service = new RepositoryService('git');
    const repo = await service.open(path);
    const native = runner.runGit;
    const walk = gate();
    const calls = vi.spyOn(runner, 'runGit').mockImplementation(async (git, args, options) => {
      if (readsSnapshotRefs(args)) await walk.promise;
      if (args[0] === 'rev-list' && options?.env?.GIT_NO_REPLACE_OBJECTS) walk.resolve();
      return native(git, args, options);
    });
    const opening = service.snapshot(repo.id, undefined, false);
    try {
      await vi.waitFor(
        () => expect(calls.mock.calls.some(([, args]) => args[0] === 'rev-list')).toBe(true),
        { timeout: 5000 },
      );
      const first = await opening;
      const tail = await service.page(repo.id, first.cursor, first.commits.length, 5000);
      expect(
        [...first.commits, ...tail.commits].map((c) => [c.oid, ...c.parents].join(' ')),
      ).toEqual(fixtureGit(path, ['rev-list', '--date-order', '--parents', '--all']).split('\n'));
      expect(
        (await service.search(repo.id, first.cursor, orphan)).commits.map((c) => c.oid),
      ).toEqual([orphan]);
      expect(calls.mock.calls.filter(([, args]) => args.includes('--count=128'))).toHaveLength(1);
      expect(calls.mock.calls.some(([, args]) => args.includes('--no-walk=unsorted'))).toBe(false);
      expect(
        calls.mock.calls.filter(([, args]) => args[0] === 'rev-list' && args.includes('--parents')),
      ).toHaveLength(laterTip ? 2 : 1);
    } finally {
      walk.resolve();
      await opening.catch(() => {});
      calls.mockRestore();
      await service.dispose();
    }
  },
);
