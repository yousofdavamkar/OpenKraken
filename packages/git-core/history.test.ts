import { afterAll, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';
import * as runner from './src/runner.js';
import { HistoryCursor } from './src/history.js';
const root = mkdtempSync(join(tmpdir(), 'openkraken-pages-'));
const service = new RepositoryService('git');
afterAll(async () => {
  await service.dispose();
  rmSync(root, { recursive: true, force: true });
});
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

test('all-history search includes stash messages without exposing implementation parents', async () => {
  const path = createFixture(join(root, 'stash-search'), 'stash');
  const snapshot = await service.snapshot((await service.open(path)).id);
  const result = await service.search(snapshot.repository.id, snapshot.cursor, 'Fixture stash');
  expect(result.commits).toHaveLength(1);
  expect(result.commits[0]?.isStash).toBe(true);
  expect(result.commits[0]?.parents).toHaveLength(1);
});
