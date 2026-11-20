import { expect, test, vi } from 'vitest';
import { mkdtemp, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';
import * as runner from './src/runner.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});

test('a restarted service reads its cached prefix while Git enumerates changed refs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-cache-restart-'));
  const dataDir = join(root, 'profile');
  const path = createFixture(join(root, 'repository'), 'linear', 3);
  let service = new RepositoryService('git', { dataDir });
  let finishRefs!: () => void;
  const gate = new Promise<void>((resolve) => {
    finishRefs = resolve;
  });
  const git = runner.runGit;
  try {
    const repo = await service.open(path);
    await service.snapshot(repo.id);
    await service.dispose();
    fixtureGit(path, ['commit', '--allow-empty', '-m', 'New tip after shutdown']);
    service = new RepositoryService('git', { dataDir });
    await service.open(path);
    vi.mocked(open).mockClear();
    let readingRefs = false;
    vi.spyOn(runner, 'runGit').mockImplementation(async (binary, args, options) => {
      if (args[0] === 'for-each-ref') {
        readingRefs = true;
        await gate;
      }
      return git(binary, args, options);
    });
    const opening = service.observeInitialSnapshot(repo.id);
    try {
      await expect
        .poll(
          () =>
            readingRefs &&
            vi
              .mocked(open)
              .mock.calls.some(
                ([name]) => name === join(dataDir, 'history', repo.id, 'prefix.json'),
              ),
        )
        .toBe(true);
    } finally {
      finishRefs();
      const { snapshot } = await opening;
      expect(snapshot.commits.map((c) => c.oid)).toEqual(
        fixtureGit(path, ['rev-list', '--date-order', '--all']).split('\n'),
      );
    }
  } finally {
    finishRefs();
    vi.restoreAllMocks();
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
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

test('cancelling an initial cache read lets the service open another repository immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-cancel-prefix-'));
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
    const first = await service.open(createFixture(join(root, 'first')));
    const second = await service.open(createFixture(join(root, 'second')));
    vi.mocked(open).mockImplementation(async (...args) => {
      if (args[0] === join(dataDir, 'history', first.id, 'prefix.json')) {
        reached();
        await gate;
      }
      return original.open(...args);
    });
    const controller = new AbortController();
    const rejected = expect(
      service.observeInitialSnapshot(first.id, controller.signal),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await stalled;
    controller.abort();
    try {
      expect(
        await Promise.race([rejected.then(() => true), delay(2000, false, { ref: false })]),
      ).toBe(true);
      const { snapshot } = await service.observeInitialSnapshot(second.id);
      expect(snapshot.commits[0]?.oid).toBe(second.head.oid);
    } finally {
      resume();
      await rejected;
    }
  } finally {
    resume();
    vi.mocked(open).mockImplementation(original.open);
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

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

test.each(['cancelled', 'failed'])(
  'a %s switch releases the outgoing cursor while its cache write finishes',
  async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-cancel-cache-write-'));
    const dataDir = join(root, 'profile');
    const service = new RepositoryService('git', { dataDir });
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writing!: () => void;
    const pendingWrite = new Promise<void>((resolve) => {
      writing = resolve;
    });
    try {
      const source = await service.open(createFixture(join(root, 'source'), 'linear', 2003));
      const destination = await service.open(createFixture(join(root, 'destination')));
      const { snapshot } = await service.observeInitialSnapshot(source.id);
      vi.mocked(open).mockImplementation(async (...args) => {
        if (
          String(args[0]).startsWith(join(dataDir, 'history', source.id, 'prefix.json.')) &&
          args[1] === 'wx'
        ) {
          writing();
          await gate;
        }
        return original.open(...args);
      });
      const moved = join(root, 'moved-destination');
      if (outcome === 'failed') await rename(destination.path, moved);
      const controller = new AbortController();
      const rejection = expect(
        service.observeInitialSnapshot(destination.id, controller.signal),
      ).rejects;
      const attempt =
        outcome === 'failed' ? rejection.toThrow() : rejection.toMatchObject({ code: 'CANCELLED' });
      try {
        await pendingWrite;
        if (outcome === 'cancelled') controller.abort();
        expect(
          await Promise.race([attempt.then(() => true), delay(2000, false, { ref: false })]),
        ).toBe(true);
        const tail = await service.page(source.id, snapshot.cursor, 2000, 5000);
        expect(tail.commits.map((c) => c.oid)).toEqual(
          fixtureGit(source.path, ['rev-list', '--date-order', '--all']).split('\n').slice(2000),
        );
        expect(tail.hasMore).toBe(false);
      } finally {
        release();
        await attempt;
      }
      if (outcome === 'failed') await rename(moved, destination.path);
      await service.observeInitialSnapshot(destination.id);
      const stored = JSON.parse(
        await original.readFile(join(dataDir, 'history', source.id, 'prefix.json'), 'utf8'),
      );
      expect(stored.commits.map((c: { oid: string }) => c.oid)).toEqual(
        snapshot.commits.map((c) => c.oid),
      );
      const tail = JSON.parse(
        await original.readFile(join(dataDir, 'history', source.id, 'tail-0.json'), 'utf8'),
      );
      expect(tail.offset).toBe(2000);
      expect(tail.commits).toHaveLength(3);
    } finally {
      release();
      vi.mocked(open).mockImplementation(original.open);
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
