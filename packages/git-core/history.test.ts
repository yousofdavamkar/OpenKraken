import { afterAll, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';
import * as runner from './src/runner.js';
import { HistoryCursor } from './src/history.js';
import { HISTORY_FORMAT, HistoryParser } from './src/parsers.js';
const root = mkdtempSync(join(tmpdir(), 'openkraken-pages-'));
const service = new RepositoryService('git');
afterAll(async () => {
  await service.dispose();
  rmSync(root, { recursive: true, force: true });
});
test.each(['octopus', 'shallow', 'replacement'])(
  'paged %s history preserves the full native records and traversal order',
  async (kind) => {
    let path = createFixture(join(root, 'wire-' + kind), 'octopus');
    if (kind === 'shallow') {
      const shallow = join(root, 'depth-two');
      fixtureGit(path, ['clone', '--depth=2', pathToFileURL(path).href, shallow]);
      path = shallow;
      expect(fixtureGit(path, ['rev-parse', '--is-shallow-repository'])).toBe('true');
    }
    if (kind === 'replacement') fixtureGit(path, ['replace', '--graft', 'HEAD', 'HEAD~2']);
    const start = fixtureGit(path, ['rev-parse', 'HEAD']);
    const legacy = await runner.runGit(
      'git',
      ['rev-list', '--date-order', '--parents', `--format=${HISTORY_FORMAT}`, '--stdin'],
      { cwd: path, stdin: start + '\n' },
    );
    const parser = new HistoryParser();
    parser.push(legacy.stdout);
    const expected = parser.finish();
    const cursor = new HistoryCursor('git', path, [start]);
    try {
      const commits = [];
      for (;;) {
        const page = await cursor.page(commits.length, 2);
        commits.push(...page.commits);
        if (!page.hasMore) break;
      }
      expect(commits).toEqual(expected);
    } finally {
      await cursor.close();
    }
  },
);
test('same cursor pages match Git without duplicates, skips or moved-ref contamination', async () => {
  const path = createFixture(join(root, 'large'), 'linear', 7300);
  const expected = fixtureGit(path, ['rev-list', '--date-order', '--all']).split('\n');
  const calls = vi.spyOn(runner, 'runGit');
  const repo = await service.open(path);
  const snapshot = await service.snapshot(repo.id);
  const initial = structuredClone(snapshot.commits);
  // A new commit must not enter the retained traversal until refresh.
  fixtureGit(path, ['commit', '--allow-empty', '-m', 'New after opening']);
  const start = performance.now();
  const next = await service.page(repo.id, snapshot.cursor, 2000, 5000);
  console.log(`Next 5000 Git commits: ${(performance.now() - start).toFixed(1)} ms`);
  expect(next.commits).toHaveLength(5000);
  expect(next.hasMore).toBe(true);
  const last = await service.page(repo.id, snapshot.cursor, 7000, 5000);
  expect(last.commits).toHaveLength(300);
  expect(last.hasMore).toBe(false);
  expect([...snapshot.commits, ...next.commits, ...last.commits].map((c) => c.oid)).toEqual(
    expected,
  );
  expect(snapshot.commits).toEqual(initial);
  await expect(service.page(repo.id, snapshot.cursor, 2000, 200)).rejects.toMatchObject({
    code: 'STALE_PAGE',
  });
  expect(calls.mock.calls.filter(([, args]) => args[0] === 'rev-list')).toHaveLength(1);
  const refreshed = await service.snapshot(repo.id);
  expect(refreshed.commits[0]?.summary).toBe('New after opening');
  expect(calls.mock.calls.filter(([, args]) => args[0] === 'rev-list')).toHaveLength(2);
  calls.mockRestore();
  await expect(service.page(repo.id, snapshot.cursor, 7300, 200)).rejects.toMatchObject({
    code: 'STALE_CURSOR',
  });
});
test('page-boundary stash insertion matches a single traversal', async () => {
  const path = createFixture(join(root, 'stash'), 'stash');
  const snap = await service.snapshot((await service.open(path)).id);
  const stashes = snap.commits.filter((c) => c.isStash);
  const cursor = new HistoryCursor('git', path, [snap.repository.head.oid!], stashes);
  try {
    const commits = [];
    let offset = 0,
      more = true;
    while (more) {
      const page = await cursor.page(offset, 1);
      commits.push(...page.commits);
      offset += page.commits.length;
      more = page.hasMore;
    }
    expect(commits).toEqual(snap.commits);
    const stashAt = commits.findIndex((c) => c.isStash);
    expect(commits[stashAt + 1]?.oid).toBe(stashes[0]?.parents[0]);
  } finally {
    await cursor.close();
  }
});
test('cancelled cursor closes, end-of-history is repeatable, and invalid pages reject', async () => {
  const path = createFixture(join(root, 'cancel'), 'linear', 50);
  const cursor = new HistoryCursor('git', path, [fixtureGit(path, ['rev-parse', 'HEAD'])]);
  const controller = new AbortController();
  controller.abort();
  await expect(cursor.page(0, 20, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  await cursor.close();
  const empty = new HistoryCursor('git', path, []);
  try {
    await expect(empty.page(0, 0)).rejects.toMatchObject({ code: 'INVALID_PAGE' });
    expect((await empty.page(0, 20)).hasMore).toBe(false);
    expect((await empty.page(0, 20)).commits).toEqual([]);
  } finally {
    await empty.close();
  }
});
test('Git search finds unloaded messages, author/email and object prefixes without advancing cursor', async () => {
  const path = createFixture(join(root, 'search'), 'linear', 2200);
  const snapshot = await service.snapshot((await service.open(path)).id);
  const result = await service.search(snapshot.repository.id, snapshot.cursor, 'Commit 100 —');
  expect(result.commits[0]?.summary).toBe('Commit 100 — linear');
  expect(snapshot.commits.some((c) => c.oid === result.commits[0]!.oid)).toBe(false);
  expect(
    (await service.search(snapshot.repository.id, snapshot.cursor, 'author@example.test'))
      .truncated,
  ).toBe(true);
  expect(
    (
      await service.search(
        snapshot.repository.id,
        snapshot.cursor,
        result.commits[0]!.oid.slice(0, 9),
      )
    ).commits[0]?.oid,
  ).toBe(result.commits[0]!.oid);
  expect((await service.search(snapshot.repository.id, snapshot.cursor, '--all')).commits).toEqual(
    [],
  );
  expect(
    (await service.page(snapshot.repository.id, snapshot.cursor, 2000, 200)).commits,
  ).toHaveLength(200);
});

test('a visible commit ID leads the capped results even when newer messages contain its prefix', async () => {
  const path = createFixture(join(root, 'search-id-cap'), 'linear', 5);
  const target = fixtureGit(path, ['rev-parse', 'HEAD~3']);
  const prefix = target.slice(0, 12);
  const head = fixtureGit(path, ['rev-parse', 'HEAD']);
  const message = `Follow up on ${prefix}\n`;
  let stream = '';
  for (let i = 0; i < 101; i++) {
    stream += `commit refs/heads/main\ncommitter Fixture <author@example.test> ${1700000300 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}`;
    if (!i) stream += `from ${head}\n`;
    stream += '\n';
  }
  fixtureGit(path, ['fast-import', '--quiet'], stream + 'done\n');
  const textMatches = fixtureGit(path, ['rev-list', '--max-count=99', 'HEAD']).split('\n');
  const repo = await service.open(path);
  const snapshot = await service.snapshot(repo.id);
  const result = await service.search(repo.id, snapshot.cursor, prefix);
  expect(result.commits.map((c) => c.oid)).toEqual([target, ...textMatches]);
  expect(result.truncated).toBe(true);
});

test('hexadecimal ref names cannot impersonate or shadow a commit ID in history search', async () => {
  const path = createFixture(join(root, 'hex-ref'), 'linear', 20);
  const target = fixtureGit(path, ['rev-parse', 'HEAD~8']);
  const prefix = target.slice(0, 10);
  fixtureGit(path, ['branch', prefix, 'HEAD']);
  fixtureGit(path, ['branch', 'badc0ffee123', 'HEAD']);
  const tag = fixtureGit(path, ['rev-parse', 'refs/tags/annotated']);
  const taggedCommit = fixtureGit(path, ['rev-parse', 'refs/tags/annotated^{commit}']);
  const repo = await service.open(path);
  const snapshot = await service.snapshot(repo.id);
  const lookup = async (query: string) =>
    (await service.search(repo.id, snapshot.cursor, query)).commits.map((c) => c.oid);
  expect(await lookup(prefix.toUpperCase())).toEqual([target]);
  expect(await lookup('badc0ffee123')).toEqual([]);
  expect(await lookup(tag.slice(0, 12))).toEqual([taggedCommit]);
});

test('an ambiguous object prefix keeps literal search results and selects neither object', async () => {
  const path = createFixture(join(root, 'ambiguous-oid'), 'linear', 8);
  const tree = fixtureGit(path, ['mktree'], '');
  // These two SHA-1 commit objects share their first seven hexadecimal digits.
  for (const n of [25990, 35034]) {
    const contents = `tree ${tree}\nauthor Fixture <f@example.test> 1700000000 +0000\ncommitter Fixture <f@example.test> 1700000000 +0000\n\nLookup ${n}\n`;
    const oid = fixtureGit(path, ['hash-object', '-t', 'commit', '-w', '--stdin'], contents);
    expect(oid.slice(0, 7)).toBe('75ee05d');
    fixtureGit(path, ['branch', `match-${n}`, oid]);
  }
  fixtureGit(path, ['commit', '--allow-empty', '-m', 'Investigate 75ee05d']);
  const head = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['branch', '75ee05d', 'match-25990']);
  const repo = await service.open(path);
  const snapshot = await service.snapshot(repo.id);
  const result = await service.search(repo.id, snapshot.cursor, '75ee05d');
  expect(result.commits.map((c) => c.oid)).toEqual([head]);
  expect(result.truncated).toBe(false);
});

test('hash lookup checks many visible tips together and ignores refs added after opening', async () => {
  const path = createFixture(join(root, 'many-search-tips'), 'linear', 80);
  const tips = fixtureGit(path, ['rev-list', '--max-count=32', 'HEAD']).split('\n');
  fixtureGit(
    path,
    ['update-ref', '--stdin'],
    tips.map((oid, i) => `create refs/tags/search-${i} ${oid}\n`).join(''),
  );
  const repo = await service.open(path);
  const snapshot = await service.snapshot(repo.id);
  const hidden = fixtureGit(path, ['commit-tree', 'HEAD^{tree}', '-m', 'Outside the open graph']);
  fixtureGit(path, ['update-ref', 'refs/heads/new-since-open', hidden]);
  const ancestor = fixtureGit(path, ['rev-parse', 'HEAD~60']);
  const requests = vi.spyOn(runner, 'runGit');
  try {
    expect((await service.search(repo.id, snapshot.cursor, hidden)).commits).toEqual([]);
    // Two text reads, object lookup, peeling, and one reachability check for all tips.
    expect(requests.mock.calls.length).toBeLessThanOrEqual(5);
    expect(requests.mock.calls.filter(([, args]) => args[0] === 'rev-list')).toHaveLength(1);
    expect(
      (await service.search(repo.id, snapshot.cursor, ancestor.slice(0, 10))).commits.map(
        (commit) => commit.oid,
      ),
    ).toEqual([ancestor]);
    const empty = await service.snapshot(repo.id, undefined, true, {
      hiddenRefs: [],
      soloRef: 'refs/heads/missing',
    });
    expect((await service.search(repo.id, empty.cursor, ancestor)).commits).toEqual([]);
  } finally {
    requests.mockRestore();
  }
});

test('all-history search includes stash messages without exposing implementation parents', async () => {
  const path = createFixture(join(root, 'stash-search'), 'stash');
  const snapshot = await service.snapshot((await service.open(path)).id);
  const result = await service.search(snapshot.repository.id, snapshot.cursor, 'Fixture stash');
  expect(result.commits).toHaveLength(1);
  expect(result.commits[0]?.isStash).toBe(true);
  expect(result.commits[0]?.parents).toHaveLength(1);
});

test('a branch pointing at a stash object keeps its actual DAG without duplicate overlay nodes', async () => {
  const path = createFixture(join(root, 'stash-branch'), 'stash');
  fixtureGit(path, ['branch', 'recovery', 'refs/stash']);
  const snapshot = await service.snapshot((await service.open(path)).id);
  expect(new Set(snapshot.commits.map((c) => c.oid)).size).toBe(snapshot.commits.length);
  expect(snapshot.commits.map((c) => c.oid).sort()).toEqual(
    fixtureGit(path, ['rev-list', '--all']).split('\n').sort(),
  );
  const stashOid = fixtureGit(path, ['rev-parse', 'refs/stash']);
  expect(snapshot.commits.find((c) => c.oid === stashOid)?.parents.length).toBeGreaterThan(1);
  const result = await service.search(snapshot.repository.id, snapshot.cursor, 'Fixture stash');
  expect(result.commits.find((c) => c.oid === stashOid)?.parents.length).toBeGreaterThan(1);
});

test('hide and solo select traversal roots, including HEAD, tags, and scoped hash search', async () => {
  const path = createFixture(join(root, 'views'), 'linear', 20);
  const repo = await service.open(path);
  const main = fixtureGit(path, ['symbolic-ref', 'HEAD']);
  const hiddenRefs = [main, 'refs/tags/v0.1.0', 'refs/tags/annotated', 'refs/remotes/origin/main'];
  const tip = fixtureGit(path, ['rev-parse', 'HEAD']);
  const base = fixtureGit(path, ['rev-parse', 'HEAD~10']);
  const side = fixtureGit(path, ['commit-tree', 'HEAD^{tree}', '-p', base, '-m', 'Side exclusive']);
  fixtureGit(path, ['update-ref', 'refs/heads/side', side]);
  const hidden = await service.snapshot(repo.id, undefined, true, { hiddenRefs });
  const expected = fixtureGit(path, ['rev-list', '--date-order', 'side']).split('\n');
  expect(hidden.commits.map((c) => c.oid)).toEqual(expected);
  expect(hidden.refs.some((r) => r.name === main)).toBe(true);
  expect((await service.search(repo.id, hidden.cursor, tip.slice(0, 9))).commits).toEqual([]);
  expect((await service.search(repo.id, hidden.cursor, side.slice(0, 9))).commits[0]?.oid).toBe(
    side,
  );
  const solo = await service.snapshot(repo.id, undefined, true, {
    hiddenRefs: ['refs/heads/side'],
    soloRef: 'refs/heads/side',
    pinnedRef: 'refs/heads/side',
  });
  expect(solo.commits.map((c) => c.oid)).toEqual(expected);
  expect(solo.pinnedOid).toBe(side);
  fixtureGit(path, ['tag', '-a', 'release', '-m', 'release', tip]);
  const shared = await service.snapshot(repo.id, undefined, true, { hiddenRefs });
  expect(shared.commits.some((c) => c.oid === tip)).toBe(true);
  const tag = await service.snapshot(repo.id, undefined, true, {
    hiddenRefs: [],
    soloRef: 'refs/tags/release',
    pinnedRef: 'refs/tags/release',
  });
  expect(tag.pinnedOid).toBe(tip);
  expect(tag.commits.map((c) => c.oid)).toEqual(fixtureGit(path, ['rev-list', main]).split('\n'));
  const missing = await service.snapshot(repo.id, undefined, true, {
    hiddenRefs: [],
    soloRef: 'refs/heads/deleted',
  });
  expect(missing.commits).toEqual([]);
  expect(missing.hasMore).toBe(false);
});

test('stash filters remove overlay nodes and detached HEAD remains an independent visible root', async () => {
  const path = createFixture(join(root, 'view-stash'), 'stash');
  const repo = await service.open(path);
  const hidden = await service.snapshot(repo.id, undefined, true, { hiddenRefs: ['refs/stash'] });
  expect(hidden.commits.some((c) => c.isStash)).toBe(false);
  const solo = await service.snapshot(repo.id, undefined, true, {
    hiddenRefs: [],
    soloRef: 'refs/stash',
  });
  expect(solo.commits.some((c) => c.isStash)).toBe(true);
  fixtureGit(path, ['checkout', '--detach']);
  const detached = await service.snapshot(repo.id, undefined, true, {
    hiddenRefs: hidden.refs.map((r) => r.name),
  });
  expect(detached.commits[0]?.oid).toBe(repo.head.oid);
});
