import { afterAll, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';
import { HistoryCursor } from './src/history.js';
import * as runner from './src/runner.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-snapshot-recovery-'));
afterAll(() => rm(root, { recursive: true, force: true }));

function missingParent(path: string) {
  fixtureGit(path, ['config', '--remove-section', 'branch.main']);
  const tree = fixtureGit(path, ['rev-parse', 'HEAD^{tree}']);
  const oid = fixtureGit(
    path,
    ['hash-object', '-t', 'commit', '-w', '--stdin'],
    `tree ${tree}\nparent ${'1'.repeat(40)}\nauthor Fixture <fixture@example.test> 1700000000 +0000\ncommitter Fixture <fixture@example.test> 1700000000 +0000\n\nMissing parent\n`,
  );
  fixtureGit(path, ['update-ref', 'refs/heads/main', oid]);
  return oid;
}

test.each(['switch', 'refresh'] as const)(
  'failed first-page %s preserves the published cursor and its cache',
  async (kind) => {
    const active = createFixture(join(root, `active-${kind}`), 'linear', 2200);
    const target =
      kind === 'switch' ? createFixture(join(root, 'invalid-switch'), 'linear', 10) : active;
    const expected = fixtureGit(active, ['rev-list', '--date-order', '--all']).split('\n');
    const dataDir = join(root, `profile-${kind}`);
    const service = new RepositoryService('git', { dataDir });
    const repo = await service.open(active);
    try {
      const first = await service.snapshot(repo.id);
      const broken = missingParent(target);
      // Ref metadata remains readable; the missing parent fails the retained history walk.
      expect(
        fixtureGit(target, ['for-each-ref', '--format=%(objectname) %(objecttype)']),
      ).toContain(`${broken} commit`);
      const destination = await service.open(target);
      await expect(service.snapshot(destination.id)).rejects.toMatchObject({ code: 'GIT_FAILED' });
      const page = await service.page(repo.id, first.cursor, 2000, 5000);
      expect(page.offset).toBe(2000);
      expect(page.commits.map((commit) => commit.oid)).toEqual(expected.slice(2000));
      expect(page.hasMore).toBe(false);
      await service.dispose();
      const tail = JSON.parse(
        await readFile(join(dataDir, 'history', repo.id, 'tail-0.json'), 'utf8'),
      );
      expect(tail.offset).toBe(2000);
      expect(tail.commits.map((commit: { oid: string }) => commit.oid)).toEqual(
        expected.slice(2000),
      );
    } finally {
      await service.dispose();
    }
  },
);

test.each(['during', 'after'] as const)(
  'cancelling %s the replacement first page preserves paging from the published snapshot',
  async (when) => {
    const path = createFixture(join(root, `cancelled-${when}`), 'linear', 2200);
    const service = new RepositoryService('git', {
      dataDir: join(root, `cancelled-profile-${when}`),
    });
    const repo = await service.open(path);
    const first = await service.snapshot(repo.id);
    const controller = new AbortController();
    const original = HistoryCursor.prototype.page;
    const page = vi.spyOn(HistoryCursor.prototype, 'page').mockImplementation(async function (
      this: HistoryCursor,
      ...args
    ) {
      if (when === 'during') controller.abort();
      const result = await original.call(this, ...args);
      if (when === 'after') controller.abort();
      return result;
    });
    try {
      await expect(service.snapshot(repo.id, controller.signal)).rejects.toMatchObject({
        code: 'CANCELLED',
      });
      page.mockRestore();
      const tail = await service.page(repo.id, first.cursor, 2000, 5000);
      expect(tail.commits).toHaveLength(200);
      expect(tail.hasMore).toBe(false);
    } finally {
      page.mockRestore();
      await service.dispose();
    }
  },
);

test('a preference write failure leaves the old page usable and a later successful refresh replaces it', async () => {
  const path = createFixture(join(root, 'preferences-failure'), 'linear', 12000);
  const dataDir = join(root, 'preferences-profile');
  const service = new RepositoryService('git', { dataDir });
  const repo = await service.open(path);
  try {
    const first = await service.snapshot(repo.id);
    const blocked = join(dataDir, 'repos', `${repo.id}.json`);
    await mkdir(blocked, { recursive: true });
    const view = { hiddenRefs: [], pinnedRef: 'refs/heads/main' };
    let candidateFinished = false;
    const original = runner.runGit;
    const run = vi.spyOn(runner, 'runGit').mockImplementation((git, args, options) => {
      const result = original(git, args, options);
      return args[0] === 'rev-list'
        ? result.finally(() => {
            candidateFinished = true;
          })
        : result;
    });
    try {
      await expect(service.snapshot(repo.id, undefined, true, view)).rejects.toThrow();
      // The replacement's retained native walk must be drained before rejection.
      expect(candidateFinished).toBe(true);
    } finally {
      run.mockRestore();
    }
    expect((await service.page(repo.id, first.cursor, 2000, 5000)).commits).toHaveLength(5000);
    await rm(blocked, { recursive: true });
    const refreshed = await service.snapshot(repo.id, undefined, true, view);
    expect(refreshed.view).toEqual(view);
    expect(refreshed.cursor).not.toBe(first.cursor);
    await expect(service.page(repo.id, first.cursor, 7000, 5000)).rejects.toMatchObject({
      code: 'STALE_CURSOR',
    });
    expect((await service.page(repo.id, refreshed.cursor, 2000, 5000)).commits).toHaveLength(5000);
  } finally {
    await service.dispose();
  }
});
