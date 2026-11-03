import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Result } from '../../packages/ipc-contract/src/index.js';
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
