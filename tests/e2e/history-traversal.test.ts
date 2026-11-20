import { _electron as electron, expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Result } from '../../packages/ipc-contract/src/index.js';

async function nativeHistory(cwd: string) {
  // Both scale fixtures have branch tips only, with HEAD attached to the main branch.
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

test('every desktop history page matches native Git through the final commit', async () => {
  const fixture = process.env.OPENKRAKEN_TRAVERSAL_REPO;
  test.skip(!fixture, 'Set OPENKRAKEN_TRAVERSAL_REPO to a branch-only scale fixture');
  test.setTimeout(10 * 60 * 1000);
  const cwd = resolve(fixture!);
  const expected = await nativeHistory(cwd);
  const profile = mkdtempSync(join(tmpdir(), 'openkraken-traversal-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Open a repository', exact: true }).waitFor();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, cwd);
    const first = await page.evaluate(async () => {
      const opened = await window.openkraken.request({ id: crypto.randomUUID(), method: 'open' });
      if (opened.kind !== 'snapshot') throw Error(JSON.stringify(opened));
      const { repository, cursor, commits, hasMore } = opened.snapshot;
      return {
        repoId: repository.id,
        cursor,
        count: commits.length,
        hasMore,
        lines: commits.map((c) => [c.oid, ...c.parents].join(' ') + '\n').join(''),
      };
    });

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
    console.log(JSON.stringify({ count, pages, digest }));
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
