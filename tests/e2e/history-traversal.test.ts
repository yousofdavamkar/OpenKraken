import { _electron as electron, expect, test } from '@playwright/test';
import { loadHistory, warmHistoryProfile } from '../history-profile.js';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Result } from '../../packages/ipc-contract/src/index.js';

async function nativeHistory(cwd: string) {
  // The scale fixtures have an attached HEAD, no stash overlays and no additional worktree roots. Git resolves annotated refs when enumerating all reachable commits.
  const git = spawn('git', ['rev-list', '--date-order', '--parents', '--all'], {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const done = once(git, 'close');
  const hash = createHash('sha256');
  let count = 0;
  for await (const chunk of git.stdout) {
    hash.update(chunk);
    for (const byte of chunk) if (byte === 10) count++;
  }
  expect((await done)[0]).toBe(0);
  return { count, digest: hash.digest('hex') };
}

function nativeRefDigest(cwd: string) {
  const git = (args: string[], input?: string) =>
    execFileSync('git', args, {
      cwd,
      input,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 32 * 1024 * 1024,
    });
  // Git forbids tabs and line feeds in ref names. Preserve the space emitted for a non-HEAD ref.
  const format =
    '%(refname)%09%(objectname)%09%(objecttype)%09%(upstream)%09%(upstream:track,nobracket)%09%(HEAD)';
  const rows = git(['for-each-ref', '--format=' + format]).split('\n');
  expect(rows.pop()).toBe('');
  const records = rows.map((row) => row.split('\t'));
  const tags = [...new Set(records.filter((row) => row[2] === 'tag').map((row) => row[1]!))];
  const peeled = new Map<string, string>();
  if (tags.length) {
    const objects = git(
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      tags.map((id) => id + '^{}\n').join(''),
    )
      .trimEnd()
      .split('\n');
    expect(objects).toHaveLength(tags.length);
    for (const [index, id] of tags.entries()) {
      const object = objects[index]!;
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64}) (?:commit|tree|blob)$/.test(object))
        throw new Error('Incomplete native tag target for ' + id);
      peeled.set(id, object.replace(' ', '\t'));
    }
  }
  const hash = createHash('sha256');
  for (const [name, target, type, upstream, track, head] of records) {
    const object = type === 'tag' ? peeled.get(target!)! : '\t';
    hash.update([name, target, type, object, upstream, track, head].join('\t') + '\n');
  }
  return { count: records.length, digest: hash.digest('hex') };
}

test('every desktop history page matches native Git through the final commit', async () => {
  const fixture = process.env.OPENKRAKEN_TRAVERSAL_REPO;
  test.skip(
    !fixture,
    'Set OPENKRAKEN_TRAVERSAL_REPO to a scale fixture for native history comparison',
  );
  test.setTimeout(10 * 60 * 1000);
  const cwd = realpathSync(fixture!);
  const source = process.env.OPENKRAKEN_BENCH_FROM_REPO;
  const switchedFrom = source ? realpathSync(source) : undefined;
  expect(switchedFrom).not.toBe(cwd);
  const expected = await nativeHistory(cwd);
  const expectedRefs = nativeRefDigest(cwd);
  const profile = mkdtempSync(join(tmpdir(), 'openkraken-traversal-'));
  let app;
  try {
    const persistedCommits =
      process.env.OPENKRAKEN_BENCH_WARM === '1'
        ? await warmHistoryProfile(profile, cwd)
        : undefined;
    app = await electron.launch({
      args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
    });
    const page = await app.firstWindow();
    if (switchedFrom) await loadHistory(app, switchedFrom);
    else await page.getByRole('button', { name: 'Open a repository', exact: true }).waitFor();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, cwd);
    const first = await page.evaluate(async () => {
      const opened = await window.openkraken.request({ id: crypto.randomUUID(), method: 'open' });
      if (opened.kind !== 'snapshot') throw Error(JSON.stringify(opened));
      const { repository, cursor, commits, hasMore, refs } = opened.snapshot;
      const rows = refs.map((ref) => {
        const { upstream } = ref;
        const counts = [];
        if (upstream?.ahead) counts.push('ahead ' + upstream.ahead);
        if (upstream?.behind) counts.push('behind ' + upstream.behind);
        return (
          [
            ref.name,
            ref.target,
            ref.objectType,
            ref.peeled ?? '',
            ref.peeledType,
            upstream?.ref ?? '',
            upstream?.gone ? 'gone' : counts.join(', '),
            ref.isHead ? '*' : ' ',
          ].join('\t') + '\n'
        );
      });
      const bytes = new TextEncoder().encode(rows.join(''));
      const refHash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return {
        refs: {
          count: refs.length,
          digest: Array.from(refHash, (byte) => byte.toString(16).padStart(2, '0')).join(''),
        },
        repoId: repository.id,
        path: repository.path,
        cursor,
        count: commits.length,
        hasMore,
        lines: commits.map((c) => [c.oid, ...c.parents].join(' ') + '\n').join(''),
      };
    });

    expect(first.refs).toEqual(expectedRefs);
    expect(realpathSync(first.path)).toBe(cwd);
    const hash = createHash('sha256').update(first.lines);
    const { repoId, cursor } = first;
    let { count, hasMore } = first;
    let pages = 1;
    expect(count).toBe(Math.min(2000, expected.count));
    while (hasMore) {
      const next = await page.evaluate(
        async (request) => {
          const reply = await window.openkraken.request(
            { ...request, id: crypto.randomUUID(), method: 'page', count: 5000 },
            'history-page',
          );
          if (reply.kind !== 'page') throw Error(JSON.stringify(reply));
          const data: Extract<Result, { kind: 'page' }> = JSON.parse(reply.metadata);
          if (data.commits.length !== reply.bodies.length) throw Error('Incomplete page bodies');
          return {
            cursor: data.cursor,
            offset: data.offset,
            count: data.commits.length,
            hasMore: data.hasMore,
            lines: data.commits.map((c) => [c.oid, ...c.parents].join(' ') + '\n').join(''),
          };
        },
        { repoId, cursor, offset: count },
      );
      expect(next.cursor).toBe(cursor);
      expect(next.offset).toBe(count);
      expect(next.count).toBe(Math.min(5000, expected.count - count));
      expect(next.count).toBeGreaterThan(0);
      hash.update(next.lines);
      count += next.count;
      hasMore = next.hasMore;
      pages++;
    }
    const digest = hash.digest('hex');
    expect({ count, digest }).toEqual(expected);
    console.log(
      JSON.stringify({ count, pages, digest, refs: first.refs, persistedCommits, switchedFrom }),
    );
  } finally {
    await app?.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
