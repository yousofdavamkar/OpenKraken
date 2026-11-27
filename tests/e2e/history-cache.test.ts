import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('external grafts replace the displayed topology across restarts and preserve ordinary cached pages', async () => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), 'ok-grafted-graph-'));
  try {
    const repo = createFixture(join(root, 'repo'), 'linear', 7100);
    for (const ref of fixtureGit(repo, ['for-each-ref', '--format=%(refname)']).split('\n')) {
      if (ref !== 'refs/heads/main') fixtureGit(repo, ['update-ref', '-d', ref]);
    }
    const ids = fixtureGit(repo, ['rev-list', '--date-order', 'HEAD']).split('\n');
    const profile = join(root, 'profile'),
      file = join(root, 'grafts');
    const ordinaryCache = join(
      profile,
      'history',
      createHash('sha256')
        .update(await realpath(repo))
        .digest('hex'),
    );
    const readCache = () =>
      Promise.all(
        ['prefix.json', 'tail-0.json'].map((name) => readFile(join(ordinaryCache, name), 'utf8')),
      );
    let before: string[] | undefined;
    for (const size of [0, 1, 2, 0]) {
      const env: Record<string, string> = { ...process.env, GIT_GRAFT_FILE: file };
      if (size) {
        await writeFile(file, ids[size - 1] + '\n');
      } else delete env.GIT_GRAFT_FILE;
      const app = await electron.launch({
        args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
        env,
      });
      try {
        const page = await app.firstWindow();
        await app.evaluate(({ dialog }, path) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
        }, repo);
        await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
        const count = page.getByTestId('commit-count');
        if (size) {
          await expect(count).toHaveText(`${size} commits`);
          const rows = page.getByRole('grid').locator('[data-oid]');
          await expect(rows).toHaveCount(size);
          expect(
            await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-oid'))),
          ).toEqual(ids.slice(0, size));
        } else {
          await expect(count).toHaveText('2,000 commits · more available');
          const more = page.getByRole('button', { name: 'Load more commits', exact: true });
          await more.click();
          await expect(count).toHaveText('7,000 commits · more available');
          if (before) {
            await more.click();
            await expect(count).toHaveText('7,100 commits');
          }
        }
      } finally {
        await app.close();
      }
      if (!before) {
        before = await readCache();
        expect(
          before.flatMap((raw) =>
            JSON.parse(raw).commits.map((commit: { oid: string }) => commit.oid),
          ),
        ).toEqual(ids.slice(0, 7000));
      } else if (size) expect(await readCache()).toEqual(before);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('moving a late ref invalidates the cached graph when the ordered root count stays the same', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ok-cache-roots-'));
  try {
    const repo = createFixture(join(root, 'repo'), 'linear', 1100);
    const tips = fixtureGit(repo, ['rev-list', 'HEAD']).split('\n');
    const ref = (index: number) => 'refs/tags/window-' + String(index).padStart(4, '0');
    fixtureGit(
      repo,
      ['update-ref', '--stdin'],
      tips.map((oid, i) => `create ${ref(i)} ${oid}\n`).join(''),
    );
    const orderedRoots = () => [
      ...new Set(
        fixtureGit(repo, ['for-each-ref', '--format=%(objectname) %(*objectname)'])
          .split('\n')
          .map((row) => {
            const [oid, peeled] = row.split(' ');
            return peeled || oid;
          }),
      ),
    ];
    const before = orderedRoots();
    const old = tips[1050]!;
    expect(before.indexOf(old)).toBeGreaterThanOrEqual(1024);

    const profile = join(root, 'profile');
    const prefix = join(
      profile,
      'history',
      createHash('sha256')
        .update(await realpath(repo))
        .digest('hex'),
      'prefix.json',
    );
    const openAndCompareHistory = async () => {
      const expected = fixtureGit(repo, ['rev-list', '--date-order', '--parents', '--all']).split(
        '\n',
      );
      const app = await electron.launch({
        args: [resolve('apps/desktop'), '--user-data-dir=' + profile],
      });
      try {
        const page = await app.firstWindow();
        await app.evaluate(({ dialog }, path) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
        }, repo);
        await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
        await expect(page.getByTestId('commit-count')).toHaveText(
          expected.length.toLocaleString('en-US') + ' commits',
        );
      } finally {
        await app.close();
      }
      const saved = JSON.parse(await readFile(prefix, 'utf8'));
      expect(
        saved.commits.map((c: { oid: string; parents: string[] }) =>
          [c.oid, ...c.parents].join(' '),
        ),
      ).toEqual(expected);
      expect(saved.key).toMatch(/^[0-9a-f]{64}$/);
      return saved.key;
    };
    const previousKey = await openAndCompareHistory();
    const tree = fixtureGit(repo, ['rev-parse', 'HEAD^{tree}']);
    const next = fixtureGit(repo, ['commit-tree', tree, '-m', 'Independent history']);
    fixtureGit(repo, ['update-ref', ref(1050), next, old]);
    expect(orderedRoots()).toEqual(before.map((oid) => (oid === old ? next : oid)));
    expect(await openAndCompareHistory()).not.toBe(previousKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
