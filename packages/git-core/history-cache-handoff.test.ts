import { expect, test, vi } from 'vitest';
import { mkdtemp, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});

test.each(['switch', 'failed switch', 'dispose'])(
  '%s finishes while a previous cached page is still being opened',
  async (action) => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-cache-handoff-'));
    const dataDir = join(root, 'profile');
    const source = createFixture(join(root, 'source'), 'linear', 2010);
    const destination = createFixture(join(root, 'destination'), 'linear', 3);
    let service = new RepositoryService('git', { dataDir });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let reached!: () => void;
    const stalled = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    try {
      const first = await service.open(source);
      const snapshot = await service.snapshot(first.id);
      await service.page(first.id, snapshot.cursor, 2000, 5000);
      await service.dispose();
      const tail = join(dataDir, 'history', first.id, 'tail-0.json');
      const closedTail = vi.fn();
      vi.mocked(open).mockImplementation(async (...args) => {
        if (args[0] === tail) {
          reached();
          await gate;
          const handle = await original.open(...args);
          const close = handle.close.bind(handle);
          vi.spyOn(handle, 'close').mockImplementation(async () => {
            await close();
            closedTail();
          });
          return handle;
        }
        return original.open(...args);
      });
      service = new RepositoryService('git', { dataDir });
      const reopened = await service.open(source);
      const visible = await service.snapshot(reopened.id);
      expect(visible.commits).toHaveLength(2000);
      await stalled;
      const handoff = async () => {
        if (action === 'dispose') await service.dispose();
        else {
          const other = await service.open(destination);
          if (action === 'failed switch') {
            await rename(destination, join(root, 'moved'));
            await expect(service.snapshot(other.id)).rejects.toThrow();
            const page = await service.page(reopened.id, visible.cursor, 2000, 5000);
            const expected = fixtureGit(source, ['rev-list', '--date-order', '--all']).split('\n');
            expect(page.commits.map((commit) => commit.oid)).toEqual(expected.slice(2000));
            expect(page.hasMore).toBe(false);
          } else {
            const next = await service.snapshot(other.id);
            expect(next.commits[0]?.oid).toBe(fixtureGit(destination, ['rev-parse', 'HEAD']));
          }
        }
      };
      const result = handoff();
      try {
        expect(
          await Promise.race([result.then(() => true), delay(2000, false, { ref: false })]),
        ).toBe(true);
      } finally {
        resume();
        await result;
      }
      await vi.waitFor(() => expect(closedTail).toHaveBeenCalledOnce());
    } finally {
      resume();
      vi.mocked(open).mockImplementation(original.open);
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('cancelling the opening cache read preserves the displayed history cursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-cache-open-'));
  const dataDir = join(root, 'profile');
  const service = new RepositoryService('git', { dataDir });
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let reached!: () => void;
  const stalled = new Promise<void>((resolve) => {
    reached = resolve;
  });
  try {
    const source = createFixture(join(root, 'source'), 'linear', 2010);
    const active = await service.open(source);
    const displayed = await service.snapshot(active.id);
    const other = await service.open(createFixture(join(root, 'destination'), 'linear', 3));
    vi.mocked(open).mockImplementation(async (...args) => {
      if (args[0] === join(dataDir, 'history', other.id, 'prefix.json')) {
        reached();
        await gate;
      }
      return original.open(...args);
    });
    const controller = new AbortController();
    const attempt = expect(
      service.snapshot(other.id, controller.signal, false),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await stalled;
    controller.abort();
    try {
      expect(
        await Promise.race([attempt.then(() => true), delay(2000, false, { ref: false })]),
      ).toBe(true);
      const tail = await service.page(active.id, displayed.cursor, 2000, 5000);
      expect(tail.commits.map((c) => c.oid)).toEqual(
        fixtureGit(source, ['rev-list', '--date-order', '--all']).split('\n').slice(2000),
      );
    } finally {
      resume();
      await attempt;
    }
  } finally {
    resume();
    vi.mocked(open).mockImplementation(original.open);
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
