import { afterAll, expect, test, vi } from 'vitest';
import type { Snapshot } from '@openkraken/ipc-contract';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';
import { HistoryCache } from './src/history-cache.js';
import { HistoryCursor } from './src/history.js';
import * as runner from './src/runner.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-history-cache-'));
afterAll(() => rm(root, { recursive: true, force: true }));
test('cached windows paint without waiting for Git and join the real stream without duplicates', async () => {
  const path = createFixture(join(root, 'large'), 'linear', 19000),
    dataDir = join(root, 'profile');
  const expected = fixtureGit(path, ['rev-list', '--date-order', '--all']).split('\n');
  let service = new RepositoryService('git', { dataDir });
  const repo = await service.open(path);
  const first = await service.snapshot(repo.id);
  for (const offset of [2000, 7000, 12000]) await service.page(repo.id, first.cursor, offset, 5000);
  await service.dispose();
  const original = runner.runGit;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(runner, 'runGit')
    .mockImplementation((git, args, options) =>
      args[0] === 'rev-list'
        ? gate.then(() => original(git, args, options))
        : original(git, args, options),
    );
  service = new RepositoryService('git', { dataDir });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await service.open(path);
    const warm = await Promise.race([
      service.snapshot(repo.id),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Cached prefix waited for the Git stream')),
          1500,
        );
      }),
    ]);
    clearTimeout(timer);
    const all = [...warm.commits];
    for (const offset of [2000, 7000, 12000])
      all.push(...(await service.page(repo.id, warm.cursor, offset, 5000)).commits);
    expect(all.map((c) => c.oid)).toEqual(expected.slice(0, 17000));
    release();
    const end = await service.page(repo.id, warm.cursor, 17000, 5000);
    all.push(...end.commits);
    expect(end.hasMore).toBe(false);
    expect(all.map((c) => c.oid)).toEqual(expected);
    expect(spy.mock.calls.filter(([, args]) => args[0] === 'rev-list')).toHaveLength(1);
  } finally {
    clearTimeout(timer);
    release();
    await service.dispose();
    spy.mockRestore();
  }
  // A missing middle cache page falls back to the retained walk at the exact prefix.
  await rm(join(dataDir, 'history', repo.id, 'tail-1.json'));
  service = new RepositoryService('git', { dataDir });
  try {
    const partial = await service.snapshot((await service.open(path)).id);
    const recovered = [...partial.commits];
    let more = partial.hasMore;
    while (more) {
      const page = await service.page(repo.id, partial.cursor, recovered.length, 5000);
      recovered.push(...page.commits);
      more = page.hasMore;
    }
    expect(recovered.map((c) => c.oid)).toEqual(expected);
  } finally {
    await service.dispose();
  }
});
test('reopening a partially cached page records the live suffix for the next restart', async () => {
  const path = createFixture(join(root, 'mixed-page'), 'linear', 7024);
  const expected = fixtureGit(path, ['rev-list', '--date-order', '--all']).split('\n');
  const dataDir = join(root, 'mixed-page-profile');
  let id = '';
  for (const count of [333, 5000]) {
    const service = new RepositoryService('git', { dataDir });
    try {
      id = (await service.open(path)).id;
      const initial = await service.snapshot(id);
      const page = await service.page(id, initial.cursor, initial.commits.length, count);
      expect(page.commits.map((c) => c.oid)).toEqual(expected.slice(2000, 2000 + count));
      if (count === 5000) {
        const tail = await service.page(id, initial.cursor, 7000, 5000);
        expect(tail.commits.map((c) => c.oid)).toEqual(expected.slice(7000));
        expect(tail.hasMore).toBe(false);
      }
    } finally {
      await service.dispose();
    }
  }
  const directory = join(dataDir, 'history', id);
  const { key } = JSON.parse(await readFile(join(directory, 'prefix.json'), 'utf8'));
  const loaded = await new HistoryCache(dataDir, id, key).load();
  if (!loaded?.continuation) throw new Error('Missing cached history');
  const cached = loaded.commits.map((c) => c.oid);
  let hasMore = loaded.hasMore;
  await loaded.continuation((page) => {
    cached.push(...page.commits.map((c) => c.oid));
    hasMore = page.hasMore;
    return true;
  });
  expect(cached.length).toBe(expected.length);
  expect(cached).toEqual(expected);
  expect(hasMore).toBe(false);
});
test('changed refs, effective configuration and shallow boundaries invalidate cached history', async () => {
  const source = createFixture(join(root, 'source'), 'linear', 30),
    path = join(root, 'shallow.git'),
    dataDir = join(root, 'shallow-profile');
  fixtureGit(root, [
    'clone',
    '--bare',
    '--depth=10',
    '--no-tags',
    pathToFileURL(source).href,
    path,
  ]);
  let service = new RepositoryService('git', { dataDir });
  let repo = await service.open(path),
    snapshot = await service.snapshot(repo.id);
  expect(snapshot.commits).toHaveLength(10);
  await service.dispose();
  const cachePath = join(dataDir, 'history', repo.id, 'prefix.json');
  const oldKey = JSON.parse(await readFile(cachePath, 'utf8')).key;
  fixtureGit(path, ['fetch', '--deepen=5', 'origin']);
  service = new RepositoryService('git', { dataDir });
  repo = await service.open(path);
  snapshot = await service.snapshot(repo.id);
  expect(snapshot.commits).toHaveLength(15);
  await service.dispose();
  expect(JSON.parse(await readFile(cachePath, 'utf8')).key).not.toBe(oldKey);
  fixtureGit(source, ['commit', '--allow-empty', '-m', 'New visible head']);
  fixtureGit(path, ['fetch', 'origin', 'main:refs/heads/main']);
  fixtureGit(path, ['config', 'core.commitGraph', 'false']);
  service = new RepositoryService('git', { dataDir });
  try {
    snapshot = await service.snapshot((await service.open(path)).id);
    expect(snapshot.commits[0]?.summary).toBe('New visible head');
  } finally {
    await service.dispose();
  }
});
test('an external graft file uses live history and preserves the existing cache', async () => {
  const path = createFixture(join(root, 'grafted'), 'linear', 32);
  // Exercise a single traversal root. The fixture normally also tracks HEAD's parent.
  for (const ref of fixtureGit(path, ['for-each-ref', '--format=%(refname)']).split('\n'))
    if (ref !== 'refs/heads/main') fixtureGit(path, ['update-ref', '-d', ref]);
  const profile = { dataDir: join(root, 'grafted-profile') };
  const open = async () => {
    const service = new RepositoryService('git', profile);
    try {
      return await service.snapshot((await service.open(path)).id);
    } finally {
      await service.dispose();
    }
  };
  const before = await open();
  const prefix = join(profile.dataDir, 'history', before.repository.id, 'prefix.json');
  const saved = await readFile(prefix);
  const head = fixtureGit(path, ['rev-parse', 'HEAD']);
  const file = join(root, 'external-grafts');
  await writeFile(file, head + '\n');
  vi.stubEnv('GIT_GRAFT_FILE', file);
  try {
    const expected = fixtureGit(path, ['rev-list', '--date-order', '--all']).split('\n');
    expect(expected).not.toEqual(before.commits.map((commit) => commit.oid));
    expect((await open()).commits.map((commit) => commit.oid)).toEqual(expected);
    expect(await readFile(prefix)).toEqual(saved);
  } finally {
    vi.unstubAllEnvs();
  }
  expect((await open()).commits).toEqual(before.commits);

  await writeFile(join(path, '.git', 'info', 'grafts'), head + '\n');
  expect((await open()).commits.map((commit) => commit.oid)).toEqual([head]);
  const graftedCache = await readFile(prefix);
  vi.stubEnv('GIT_GRAFT_FILE', '');
  try {
    const expected = fixtureGit(path, ['rev-list', '--date-order', '--all']).split('\n');
    expect(expected).toHaveLength(32);
    expect((await open()).commits.map((commit) => commit.oid)).toEqual(expected);
    expect(await readFile(prefix)).toEqual(graftedCache);
  } finally {
    vi.unstubAllEnvs();
  }
  expect((await open()).commits.map((commit) => commit.oid)).toEqual([head]);
});
test.each(['GIT_SHALLOW_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE'] as const)(
  'an empty %s uses Git’s effective parentage and preserves ordinary cached pages',
  async (variable) => {
    const path = createFixture(join(root, variable), 'linear', 32);
    const head = fixtureGit(path, ['rev-parse', 'HEAD']);
    if (variable === 'GIT_SHALLOW_FILE') {
      await writeFile(join(path, '.git', 'shallow'), head + '\n');
    } else {
      fixtureGit(path, ['replace', '--graft', 'HEAD']);
      if (variable === 'GIT_REPLACE_REF_BASE') {
        const replacement = fixtureGit(path, ['rev-parse', 'refs/replace/' + head]);
        fixtureGit(path, ['update-ref', 'refs/custom/' + head, replacement]);
        fixtureGit(path, ['replace', '-d', head]);
      }
    }
    const dataDir = join(root, variable + '-profile');
    const open = async () => {
      const service = new RepositoryService('git', { dataDir });
      try {
        const repo = await service.open(path);
        return await service.snapshot(repo.id, undefined, false, {
          hiddenRefs: [],
          soloRef: 'refs/heads/main',
        });
      } finally {
        await service.dispose();
      }
    };
    const native = () =>
      fixtureGit(path, ['rev-list', '--date-order', '--parents', 'HEAD']).split('\n');
    const displayed = (snapshot: Snapshot) =>
      snapshot.commits.map((commit) => [commit.oid, ...commit.parents].join(' '));
    const ordinary = native();
    const first = await open();
    expect(displayed(first)).toEqual(ordinary);
    const file = join(dataDir, 'history', first.repository.id, 'prefix.json');
    const cached = await readFile(file);
    vi.stubEnv(variable, '');
    try {
      const expected = native();
      expect(expected).not.toEqual(ordinary);
      expect(displayed(await open())).toEqual(expected);
      expect(await readFile(file)).toEqual(cached);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(displayed(await open())).toEqual(ordinary);
  },
);
test('damaged records miss safely; cache quotas and invalidation do not affect repositories', async () => {
  const service = new RepositoryService('git');
  const snapshot = await service.snapshot(
    (await service.open(createFixture(join(root, 'small')))).id,
  );
  await service.dispose();
  const directory = join(root, 'bounded'),
    id = 'a'.repeat(64);
  const cache = new HistoryCache(directory, id, 'key');
  cache.record(0, snapshot.commits, false);
  await cache.flush();
  const path = join(directory, 'history', id, 'prefix.json');
  const damaged = JSON.parse(await readFile(path, 'utf8'));
  damaged.commits[0].summary = 'Tampered';
  await writeFile(path, JSON.stringify(damaged));
  expect(await new HistoryCache(directory, id, 'key').load()).toBeUndefined();
  for (let i = 0; i < 18; i++) {
    const entry = new HistoryCache(directory, i.toString(16).padStart(64, '0'), 'key');
    entry.record(0, snapshot.commits, false);
    await entry.flush();
  }
  expect(await readdir(join(directory, 'history'))).toHaveLength(16);
  const last = new HistoryCache(directory, '0'.repeat(63) + 'f', 'key');
  await last.invalidate();
  await last.flush();
  expect(await last.load()).toBeUndefined();
});
test.each(['changed commit', 'extra commit'])(
  'cached tail with %s is rejected while the opening page is displayed',
  async (difference) => {
    const path = createFixture(join(root, 'cached-' + difference), 'linear', 7009);
    const service = new RepositoryService('git');
    const snapshot = await service.snapshot((await service.open(path)).id);
    const firstTail = await service.page(snapshot.repository.id, snapshot.cursor, 2000, 5000);
    const lastTail = await service.page(snapshot.repository.id, snapshot.cursor, 7000, 5000);
    await service.dispose();
    const commits = structuredClone(lastTail.commits);
    const changed = { ...commits.at(-1)!, oid: 'f'.repeat(40) };
    if (difference === 'extra commit') commits.push(changed);
    else commits[commits.length - 1] = changed;
    let invalidate!: () => void;
    const invalidated = new Promise<void>((resolve) => {
      invalidate = resolve;
    });
    const cursor = new HistoryCursor('git', path, [snapshot.repository.head.oid!], [], {
      commits: snapshot.commits,
      hasMore: true,
      continuation: async (append) => {
        append(firstTail);
        append({ commits, hasMore: false });
      },
      invalidate,
    });
    try {
      const first = await cursor.page(0, 2000);
      expect(first.commits).toHaveLength(2000);
      await invalidated;
      await expect(cursor.page(2000, 1)).rejects.toMatchObject({ code: 'STALE_CACHE' });
    } finally {
      await cursor.close();
    }
  },
);

test('a divergent seeded prefix rejects continuation and invalidates the cache', async () => {
  const path = createFixture(join(root, 'mismatch'), 'linear', 20),
    service = new RepositoryService('git');
  const snapshot = await service.snapshot((await service.open(path)).id);
  await service.dispose();
  const invalidate = vi.fn(),
    commits = structuredClone(snapshot.commits.slice(0, 5));
  commits[0]!.oid = 'f'.repeat(40);
  const cursor = new HistoryCursor('git', path, [snapshot.repository.head.oid!], [], {
    commits,
    hasMore: true,
    invalidate,
  });
  try {
    await cursor.page(0, 5);
    await expect(cursor.page(5, 10)).rejects.toMatchObject({ code: 'STALE_CACHE' });
    expect(invalidate).toHaveBeenCalled();
  } finally {
    await cursor.close();
  }
});

test('an oversized UTF-8 history page stops encoding later batches and removes its old prefix', async () => {
  const path = createFixture(join(root, 'oversized-page'), 'linear', 101);
  const profile = join(root, 'oversized-profile');
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const { commits } = await service.snapshot(repo.id);
    expect(commits).toHaveLength(101);
    const cache = new HistoryCache(profile, repo.id, 'large-page');
    cache.record(0, commits, false);
    await cache.flush();
    const prefix = join(profile, 'history', repo.id, 'prefix.json');
    expect(JSON.parse(await readFile(prefix, 'utf8')).commits).toHaveLength(101);
    const readLast = vi.fn(() => commits[100]!.body);
    const next = commits.slice();
    next[0] = { ...commits[0]!, body: '🌱'.repeat(2 * 1024 * 1024) };
    next[100] = {
      ...commits[100]!,
      get body() {
        return readLast();
      },
    };
    const updated = new HistoryCache(profile, repo.id, 'replacement');
    updated.record(0, next, false);
    await updated.flush();
    await expect(readFile(prefix)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(readLast).not.toHaveBeenCalled();
  } finally {
    await service.dispose();
  }
});

test('appending rewrites only changed cache pages and repairs lost or edited prefixes', async () => {
  const path = createFixture(join(root, 'incremental'), 'linear', 10);
  const service = new RepositoryService('git');
  const repo = await service.open(path);
  const { commits } = await service.snapshot(repo.id);
  await service.dispose();
  const profile = join(root, 'incremental-profile');
  const directory = join(profile, 'history', repo.id);
  const prefix = join(directory, 'prefix.json');
  const tail = join(directory, 'tail-0.json');
  let cache = new HistoryCache(profile, repo.id, 'incremental');
  cache.record(0, commits.slice(0, 2), true);
  await cache.flush();
  const original = await stat(prefix, { bigint: true });
  const bytes = await readFile(prefix);
  cache.record(2, commits.slice(2, 4), true);
  await cache.flush();
  expect(await stat(prefix, { bigint: true })).toMatchObject({
    ino: original.ino,
    mtimeNs: original.mtimeNs,
  });
  expect(JSON.parse(await readFile(tail, 'utf8')).commits).toEqual(commits.slice(2, 4));

  cache = new HistoryCache(profile, repo.id, 'incremental');
  const seed = await cache.load();
  await seed!.continuation!(() => true);
  cache.record(4, commits.slice(4, 6), true);
  await cache.flush();
  expect(await stat(prefix, { bigint: true })).toMatchObject({
    ino: original.ino,
    mtimeNs: original.mtimeNs,
  });
  expect(JSON.parse(await readFile(tail, 'utf8')).commits).toEqual(commits.slice(2, 6));

  await writeFile(prefix, Buffer.alloc(bytes.length, 32));
  cache.record(6, commits.slice(6, 8), true);
  await cache.flush();
  expect(await readFile(prefix)).toEqual(bytes);
  await rm(prefix);
  cache.record(8, commits.slice(8), false);
  await cache.flush();
  expect(await readFile(prefix)).toEqual(bytes);
  expect(JSON.parse(await readFile(tail, 'utf8'))).toMatchObject({
    offset: 2,
    commits: commits.slice(2),
    hasMore: false,
  });
});

test('a tail declined by the cursor cannot stand in for a live page of the same size', async () => {
  const path = createFixture(join(root, 'declined'), 'linear', 6);
  const service = new RepositoryService('git');
  const repo = await service.open(path);
  const { commits } = await service.snapshot(repo.id);
  await service.dispose();
  const profile = join(root, 'declined-profile');
  const cache = new HistoryCache(profile, repo.id, 'declined');
  cache.record(0, commits.slice(0, 2), true);
  cache.record(2, commits.slice(2, 4), true);
  await cache.flush();

  const reopened = new HistoryCache(profile, repo.id, 'declined');
  const seed = await reopened.load();
  await seed!.continuation!(() => false);
  reopened.record(2, commits.slice(4), true);
  await reopened.flush();
  const next = await new HistoryCache(profile, repo.id, 'declined').load();
  const append = vi.fn(() => true);
  await next!.continuation!(append);
  expect(append).toHaveBeenCalledExactlyOnceWith({ commits: commits.slice(4), hasMore: true });
});
