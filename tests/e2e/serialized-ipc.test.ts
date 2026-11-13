import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  decodeHistoryPage,
  expandGitServiceResult,
  type ServiceResult,
  type Result,
} from '../../packages/ipc-contract/src/index.js';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('serialized responses retain Git text, paging and errors through the sandbox bridge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-serialized-ipc-'));
  const repository = createFixture(join(root, 'repo'), 'linear', 2003);
  const summary = 'Résumé 🌱 "quoted" \\ path';
  const body = 'First line\nSecond line\twith a tab';
  fixtureGit(repository, ['tag', '-d', 'v0.1.0', 'annotated']);
  fixtureGit(repository, ['commit', '--amend', '--allow-empty', '-m', summary, '-m', body]);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Open a repository', exact: true }).waitFor();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    const raw = await page.evaluate(() =>
      window.openkraken.request({ id: crypto.randomUUID(), method: 'open' }, 'json'),
    );
    expect(typeof raw).toBe('string');
    const opened: Result = JSON.parse(raw);
    if (opened.kind !== 'snapshot') throw new Error('Expected repository snapshot');
    expect(opened.snapshot.commits).toHaveLength(2000);
    expect(opened.snapshot.commits[0]).toMatchObject({
      summary,
      body: `${summary}\n\n${body}\n`,
    });
    const pageRequest = {
      method: 'page' as const,
      repoId: opened.snapshot.repository.id,
      cursor: opened.snapshot.cursor,
      offset: 2000,
      count: 5000,
    };
    const next: Result = JSON.parse(
      await page.evaluate(
        (request) => window.openkraken.request({ id: crypto.randomUUID(), ...request }, 'json'),
        pageRequest,
      ),
    );
    expect(next).toMatchObject({ kind: 'page', offset: 2000, hasMore: false });
    if (next.kind !== 'page') throw new Error('Expected history page');
    expect(next.commits.map((commit) => commit.summary)).toEqual([
      'Commit 3 — linear',
      'Commit 2 — linear',
      'Commit 1 — linear',
    ]);
    const stale: Result = JSON.parse(
      await page.evaluate(
        (request) => window.openkraken.request({ id: crypto.randomUUID(), ...request }, 'json'),
        pageRequest,
      ),
    );
    expect(stale).toMatchObject({ kind: 'error', code: 'STALE_PAGE' });
    await expect(
      page.evaluate(
        (request) =>
          window.openkraken.request({ id: crypto.randomUUID(), ...request, count: 5001 }, 'json'),
        pageRequest,
      ),
    ).rejects.toThrow();
    await expect(
      page.evaluate(() =>
        Reflect.apply(window.openkraken.request, window.openkraken, [
          { id: crypto.randomUUID(), method: 'commandPreferences' },
          'yaml',
        ]),
      ),
    ).rejects.toThrow('Invalid response format');
    const split = await page.evaluate(async (old) => {
      const refreshed = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'refresh',
        repoId: old.repoId,
      });
      if (refreshed.kind !== 'snapshot') throw new Error('Expected refreshed snapshot');
      const page = { ...old, cursor: refreshed.snapshot.cursor };
      const transferred = await window.openkraken.request(
        { id: crypto.randomUUID(), ...page },
        'history-page',
      );
      const stale = await window.openkraken.request(
        { id: crypto.randomUUID(), ...page },
        'history-page',
      );
      return { transferred, cursor: refreshed.snapshot.cursor, stale };
    }, pageRequest);
    expect(decodeHistoryPage(split.transferred)).toEqual({ ...next, cursor: split.cursor });
    expect(split.stale).toMatchObject({ kind: 'error', code: 'STALE_PAGE' });
    await expect(
      page.evaluate(() =>
        Reflect.apply(window.openkraken.request, window.openkraken, [
          { id: crypto.randomUUID(), method: 'open' },
          'history-page',
        ]),
      ),
    ).rejects.toThrow('Invalid response format');
    await expect(
      page.evaluate(() =>
        Reflect.apply(window.openkraken.request, window.openkraken, [
          { id: crypto.randomUUID(), method: 'commandPreferences' },
          'snapshot-json',
        ]),
      ),
    ).rejects.toThrow('Invalid response format');
    const preferences = await page.evaluate(async () => {
      const request = { id: crypto.randomUUID(), method: 'commandPreferences' as const };
      return {
        object: await window.openkraken.request(request),
        serialized: JSON.parse(
          await window.openkraken.request({ ...request, id: crypto.randomUUID() }, 'json'),
        ),
      };
    });
    expect(preferences.serialized).toEqual(preferences.object);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('large Git snapshots round-trip their ordered reference records through all three response formats', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-large-refs-ipc-'));
  const repository = createFixture(join(root, 'repo'), 'linear', 5);
  const head = fixtureGit(repository, ['rev-parse', 'HEAD']);
  fixtureGit(
    repository,
    ['update-ref', '--stdin'],
    Array.from({ length: 10000 }, (_, i) => `create refs/tags/fixture-${i} ${head}\n`).join(''),
  );
  fixtureGit(repository, ['pack-refs', '--all']);
  fixtureGit(repository, ['branch', 'Ångström/🌱']);
  const names = fixtureGit(repository, ['for-each-ref', '--format=%(refname)']).split('\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    const result = await page.evaluate(async () => {
      const opened = await window.openkraken.request({ id: crypto.randomUUID(), method: 'open' });
      if (opened.kind !== 'snapshot') throw new Error('Expected an ordinary snapshot');
      const refreshed: Result = JSON.parse(
        await window.openkraken.request(
          { id: crypto.randomUUID(), method: 'refresh', repoId: opened.snapshot.repository.id },
          'json',
        ),
      );
      if (refreshed.kind !== 'snapshot') throw new Error('Expected a serialized snapshot');
      return {
        refs: opened.snapshot.refs,
        compact: await window.openkraken.request(
          { id: crypto.randomUUID(), method: 'refresh', repoId: opened.snapshot.repository.id },
          'snapshot-json',
        ),
        same: JSON.stringify(opened.snapshot.refs) === JSON.stringify(refreshed.snapshot.refs),
        branch: opened.snapshot.refs.find((ref) => ref.shortName === 'Ångström/🌱'),
        annotated: opened.snapshot.refs.find((ref) => ref.name === 'refs/tags/annotated'),
      };
    });
    const wire: ServiceResult = JSON.parse(result.compact);
    expect(wire.kind).toBe('compactSnapshot');
    if (wire.kind !== 'compactSnapshot') throw new Error('Expected compact snapshot');
    expect(
      wire.snapshot.refs.filter((row) => typeof row === 'string').length,
    ).toBeGreaterThanOrEqual(10000);
    const expanded = expandGitServiceResult(wire);
    if (expanded.kind !== 'snapshot') throw new Error('Expected reference records');
    expect(expanded.snapshot.refs).toEqual(result.refs);
    expect(result.refs.map((ref) => ref.name)).toEqual(names);
    expect(result.same).toBe(true);
    expect(result.branch).toMatchObject({
      kind: 'local',
      objectType: 'commit',
      target: head,
      isHead: false,
    });
    expect(result.annotated).toMatchObject({
      kind: 'tag',
      objectType: 'tag',
      peeledType: 'commit',
      peeled: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
