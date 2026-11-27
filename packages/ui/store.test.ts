import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { GraphEngine } from '../graph/src/engine.js';
import type { GraphDocument, GraphRequest } from '../graph/src/engine.js';
import { encodeHistoryPage, encodeSnapshotBodies } from '@openkraken/ipc-contract';
import type { Result, Snapshot } from '@openkraken/ipc-contract';
const workers = vi.hoisted(() => ({ start: vi.fn(), close: vi.fn(), layout: vi.fn() }));
vi.mock('./src/graph-client.js', () => ({
  GraphClient: class {
    failed = false;
    private engine = new GraphEngine(true);
    constructor() {
      workers.start(this);
    }
    close() {
      workers.close(this);
    }
    async request(request: GraphRequest) {
      if (this.failed) throw new Error('Graph worker failed');
      if (request.method === 'reset') await workers.layout(request.commits);
      return this.engine.handle({ ...request, id: 1 });
    }
  },
}));
import { useRepository } from './src/store.js';
function fixture(cursor = crypto.randomUUID()): Snapshot {
  const oid = 'a'.repeat(40),
    signature = { name: 'Author', email: 'author@example.test', time: 1, tzOffsetMin: 0 };
  return {
    view: { hiddenRefs: [] },
    cursor,
    repository: {
      id: 'a'.repeat(64),
      path: '/repo',
      gitDir: '/repo/.git',
      commonDir: '/repo/.git',
      isBare: false,
      isShallow: false,
      isSparse: false,
      head: { kind: 'branch', ref: 'refs/heads/main', oid },
      state: 'clean',
    },
    commits: [
      {
        oid,
        parents: ['b'.repeat(40)],
        summary: 'First',
        body: 'First',
        author: signature,
        committer: signature,
        isStash: false,
      },
    ],
    refs: [],
    status: { entries: [], ahead: 0, behind: 0 },
    hasMore: true,
    elapsedMs: 0,
  };
}
function deferred<T = Result>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const request = vi.fn<(request: unknown) => Promise<Result>>();
beforeEach(() => {
  useRepository.setState(useRepository.getInitialState(), true);
  request.mockReset();
  vi.stubGlobal('window', {
    openkraken: {
      request: async (
        input: unknown,
        format?:
          'json' | 'snapshot-bodies' | 'history-page' | 'snapshot-json' | 'snapshot-transfer',
      ) => {
        const result = await request(input);
        if (format === 'snapshot-bodies') return encodeSnapshotBodies(result);
        if (format === 'history-page' && result.kind === 'page') return encodeHistoryPage(result);
        return format === 'json' || format === 'snapshot-json' || format === 'snapshot-transfer'
          ? JSON.stringify(result)
          : result;
      },
      cancel: vi.fn(async () => {}),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
async function open(snapshot: Snapshot) {
  request.mockResolvedValueOnce({ kind: 'snapshot', snapshot });
  await useRepository.getState().run({ id: crypto.randomUUID(), method: 'open' });
}
test.each(['snapshot', 'layout'] as const)(
  'failed %s during a switch keeps the displayed graph searchable',
  async (failure) => {
    const first = fixture();
    await open(first);
    workers.start.mockClear();
    workers.close.mockClear();
    const read = deferred();
    request.mockReturnValueOnce(read.promise);
    const switching = useRepository.getState().run({ id: crypto.randomUUID(), method: 'open' });
    try {
      expect(workers.start).toHaveBeenCalledTimes(1);
      expect(workers.close).not.toHaveBeenCalled();
    } finally {
      if (failure === 'layout') {
        workers.layout.mockImplementationOnce(() => {
          throw new Error('Layout failed');
        });
        read.resolve({ kind: 'snapshot', snapshot: fixture() });
      } else {
        read.resolve({ kind: 'error', code: 'GIT_FAILED', message: 'Snapshot failed' });
      }
      await switching;
    }
    expect(workers.close.mock.calls).toEqual(workers.start.mock.calls);
    expect(useRepository.getState().snapshot?.cursor).toBe(first.cursor);
    await useRepository.getState().search('First');
    expect(useRepository.getState().matches).toEqual([first.commits[0]!.oid]);
  },
);

test('a repository switch prepares its new rows while the displayed graph waits for layout', async () => {
  const first = fixture();
  await open(first);
  const previous = useRepository.getState();
  const next = fixture();
  next.commits[0] = { ...next.commits[0]!, oid: 'f'.repeat(40), summary: 'Replacement' };
  const dispatched = deferred<GraphDocument[]>();
  const finish = deferred<void>();
  workers.layout.mockImplementationOnce((rows: GraphDocument[]) => {
    dispatched.resolve(rows);
    return finish.promise;
  });
  const opening = open(next);
  const rows = await dispatched.promise;
  try {
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0]!.parents)).toBe(true);
    expect(useRepository.getState().snapshot).toBe(previous.snapshot);
    expect(useRepository.getState().layout).toBe(previous.layout);
    expect(useRepository.getState().selection).toBe(previous.selection);
  } finally {
    finish.resolve();
    await opening;
  }
  const state = useRepository.getState();
  expect(state.rows).toBe(rows);
  expect(state.snapshot?.cursor).toBe(next.cursor);
  expect(state.layout[0]?.oid).toBe(next.commits[0]!.oid);
  await state.search('Replacement');
  expect(useRepository.getState().matches).toEqual([next.commits[0]!.oid]);
});

test('refresh replaces a failed graph worker and restores the active query and selection', async () => {
  const first = fixture();
  await open(first);
  await useRepository.getState().search('First');
  const current = workers.start.mock.lastCall![0];
  current.failed = true;
  workers.close.mockClear();
  const fresh = { ...first, cursor: crypto.randomUUID() };
  request.mockResolvedValueOnce({ kind: 'snapshot', snapshot: fresh });
  await useRepository.getState().run({
    id: crypto.randomUUID(),
    method: 'refresh',
    repoId: first.repository.id,
  });
  const state = useRepository.getState();
  expect(state.error).toBeUndefined();
  expect(state.snapshot?.cursor).toBe(fresh.cursor);
  expect(state.layout.map((row) => row.oid)).toEqual(first.commits.map((commit) => commit.oid));
  expect(state.selection.focus).toBe(first.commits[0]!.oid);
  expect(state.matches).toEqual([first.commits[0]!.oid]);
  expect(workers.close).toHaveBeenCalledWith(current);
});

test('appending keeps previous rows and selection intact', async () => {
  const snapshot = fixture();
  await open(snapshot);
  const first = useRepository.getState().layout[0];
  request.mockResolvedValueOnce({
    kind: 'page',
    cursor: snapshot.cursor,
    offset: 1,
    commits: [{ ...snapshot.commits[0]!, oid: 'b'.repeat(40), parents: [], summary: 'Second' }],
    hasMore: false,
  });
  await useRepository.getState().loadMore();
  expect(useRepository.getState().layout[0]).toBe(first);
  expect(useRepository.getState().rows).toHaveLength(2);
  expect(useRepository.getState().selection.focus).toBe(snapshot.commits[0]!.oid);
  await useRepository.getState().search('Second');
  expect(useRepository.getState().matches).toEqual(['b'.repeat(40)]);
});
test('deep range selection preserves the loaded page and ignores a missing target', async () => {
  const snapshot = fixture();
  await open(snapshot);
  const previous = snapshot.commits[0]!;
  const commits = Array.from({ length: 5000 }, (_, i) => ({
    ...previous,
    oid: (i + 1).toString(16).padStart(40, '0'),
  }));
  request.mockResolvedValueOnce({
    kind: 'page',
    cursor: snapshot.cursor,
    offset: 1,
    commits,
    hasMore: false,
  });
  await useRepository.getState().loadMore();
  const { rows, select } = useRepository.getState();
  const last = commits.at(-1)!.oid;
  const start = commits.at(-3)!.oid;
  select(start);
  select(last, 'range');
  const state = useRepository.getState();
  expect(state.rows).toBe(rows);
  expect(state.selection).toEqual({
    anchor: start,
    anchorIndex: 4998,
    focus: last,
    focusIndex: 5000,
    selected: commits.slice(-3).map((row) => row.oid),
  });
  select('missing', 'range');
  expect(useRepository.getState()).toBe(state);
});
test('a keyboard jump checks each appended page without revisiting earlier commit IDs', async () => {
  const snapshot = fixture();
  await open(snapshot);
  const first = useRepository.getState().rows[0]!;
  const readOid = vi.fn(() => first.oid);
  const observed = Object.freeze({
    ...first,
    get oid() {
      return readOid();
    },
  });
  useRepository.setState({ rows: [observed] });
  for (const [index, digit] of ['b', 'c', 'd'].entries()) {
    request.mockResolvedValueOnce({
      kind: 'page',
      cursor: snapshot.cursor,
      offset: index + 1,
      commits: [{ ...snapshot.commits[0]!, oid: digit.repeat(40), parents: [] }],
      hasMore: digit !== 'd',
    });
  }
  readOid.mockClear();
  await useRepository.getState().navigate('d'.repeat(40));
  expect(useRepository.getState().selection.focus).toBe('d'.repeat(40));
  expect(readOid).toHaveBeenCalledTimes(1);
});
test('a pending jump to unloaded history preserves a newer row selection', async () => {
  const snapshot = fixture();
  const second = { ...snapshot.commits[0]!, oid: 'b'.repeat(40), parents: ['c'.repeat(40)] };
  snapshot.commits.push(second);
  await open(snapshot);
  const pending = deferred();
  request.mockReturnValueOnce(pending.promise);
  const target = second.parents[0]!;
  const navigation = useRepository.getState().navigate(target);
  useRepository.getState().select(second.oid);
  pending.resolve({
    kind: 'page',
    cursor: snapshot.cursor,
    offset: 2,
    commits: [{ ...second, oid: target, parents: [] }],
    hasMore: false,
  });
  await navigation;
  expect(useRepository.getState().rows.at(-1)?.oid).toBe(target);
  expect(useRepository.getState().selection.focus).toBe(second.oid);
});
test.each([0, 2])(
  'a viewport jump stops at the root with %i commits on the last page',
  async (count) => {
    const snapshot = fixture();
    await open(snapshot);
    const commits = ['b', 'c'].slice(0, count).map((digit) => ({
      ...snapshot.commits[0]!,
      oid: digit.repeat(40),
      parents: [],
    }));
    request.mockResolvedValueOnce({
      kind: 'page',
      cursor: snapshot.cursor,
      offset: 1,
      commits,
      hasMore: false,
    });
    await useRepository.getState().navigate(18);
    const state = useRepository.getState();
    expect(state.selection.focus).toBe(state.rows.at(-1)!.oid);
    expect(state.selection.focusIndex).toBe(count);
    expect(request).toHaveBeenCalledTimes(2);
  },
);
test('the newest keyboard jump uses the page already in flight', async () => {
  const snapshot = fixture();
  await open(snapshot);
  const pending = deferred();
  request.mockReturnValueOnce(pending.promise);
  const second = { ...snapshot.commits[0]!, oid: 'b'.repeat(40), parents: ['c'.repeat(40)] };
  const third = { ...second, oid: 'c'.repeat(40), parents: [] };
  const firstJump = useRepository.getState().navigate(third.oid);
  const nextRow = useRepository.getState().navigate(1);
  pending.resolve({
    kind: 'page',
    cursor: snapshot.cursor,
    offset: 1,
    commits: [second, third],
    hasMore: false,
  });
  await Promise.all([firstJump, nextRow]);
  expect(useRepository.getState().selection.focus).toBe(second.oid);
  expect(request).toHaveBeenCalledTimes(2); // Open and one page.
});
test.each(['cancelled', 'error'] as const)(
  'a %s repository switch preserves the page arriving during the picker',
  async (kind) => {
    const snapshot = fixture();
    await open(snapshot);
    const page = deferred(),
      picker = deferred();
    request.mockReturnValueOnce(page.promise).mockReturnValueOnce(picker.promise);
    const loading = useRepository.getState().loadMore();
    const switching = useRepository.getState().run({ id: crypto.randomUUID(), method: 'open' });
    const second = { ...snapshot.commits[0]!, oid: 'b'.repeat(40), summary: 'Second' };
    page.resolve({
      kind: 'page',
      cursor: snapshot.cursor,
      offset: 1,
      commits: [second],
      hasMore: true,
    });
    await loading;
    picker.resolve(
      kind === 'cancelled' ? { kind } : { kind, code: 'GIT_FAILED', message: 'Open failed' },
    );
    await switching;
    expect(window.openkraken.cancel).not.toHaveBeenCalled();
    expect(useRepository.getState().snapshot?.commits.at(-1)).toEqual(second);
    const third = { ...second, oid: 'c'.repeat(40), summary: 'Third' };
    request.mockResolvedValueOnce({
      kind: 'page',
      cursor: snapshot.cursor,
      offset: 2,
      commits: [third],
      hasMore: false,
    });
    await useRepository.getState().loadMore();
    expect(useRepository.getState().layout.map((row) => row.oid)).toEqual([
      snapshot.commits[0]!.oid,
      second.oid,
      third.oid,
    ]);
  },
);
test('late page after refresh cannot append to the new generation', async () => {
  const old = fixture();
  await open(old);
  const pending = deferred();
  request.mockReturnValueOnce(pending.promise);
  const loading = useRepository.getState().loadMore();
  const fresh = fixture();
  request.mockResolvedValueOnce({ kind: 'snapshot', snapshot: fresh });
  await useRepository
    .getState()
    .run({ id: crypto.randomUUID(), method: 'refresh', repoId: old.repository.id });
  pending.resolve({
    kind: 'page',
    cursor: old.cursor,
    offset: 1,
    commits: old.commits,
    hasMore: false,
  });
  await loading;
  expect(useRepository.getState().snapshot?.cursor).toBe(fresh.cursor);
  expect(useRepository.getState().rows).toHaveLength(1);
});
test.each(['complete', 'pending'])(
  'paging preserves a %s all-history search while updating loaded matches',
  async (timing) => {
    const snapshot = fixture();
    await open(snapshot);
    const match = { ...snapshot.commits[0]!, oid: 'b'.repeat(40), summary: 'Second' };
    await useRepository.getState().search('Second');
    const pending = deferred();
    request.mockReturnValueOnce(pending.promise);
    const searching = useRepository.getState().searchAll();
    const result = {
      kind: 'search' as const,
      commits: [match],
      cursor: snapshot.cursor,
      truncated: true,
    };
    if (timing === 'complete') {
      pending.resolve(result);
      await searching;
    }
    request.mockResolvedValueOnce({
      kind: 'page',
      commits: [match],
      cursor: snapshot.cursor,
      offset: 1,
      hasMore: false,
    });
    await useRepository.getState().loadMore();
    pending.resolve(result);
    await searching;
    const state = useRepository.getState();
    expect(state.matches).toEqual([match.oid]);
    expect(state.searchResults).toEqual([match]);
    expect(state.searchTruncated).toBe(true);
    expect(window.openkraken.cancel).not.toHaveBeenCalled();
  },
);

test.each(['result', 'error'])(
  'cancel search preserves an in-flight page and ignores a late %s during a retry',
  async (reply) => {
    const snapshot = fixture();
    await open(snapshot);
    const state = useRepository.getState;
    await state().search('First');
    const search = deferred(),
      page = deferred(),
      retry = deferred();
    request.mockReturnValueOnce(search.promise).mockReturnValueOnce(page.promise);
    const searching = state().searchAll();
    const searchId = state().searching;
    const paging = state().loadMore();
    const pageId = state().paging;
    await state().cancelSearch();
    expect(window.openkraken.cancel).toHaveBeenCalledExactlyOnceWith(searchId);
    expect(state()).toMatchObject({
      query: 'First',
      matches: [snapshot.commits[0]!.oid],
      paging: pageId,
    });
    expect(state().searching).toBeUndefined();
    request.mockReturnValueOnce(retry.promise);
    const retrying = state().searchAll();
    const retryId = state().searching;
    const found = {
      kind: 'search' as const,
      cursor: snapshot.cursor,
      commits: snapshot.commits,
      truncated: false,
    };
    search.resolve(
      reply === 'result' ? found : { kind: 'error', code: 'CANCELLED', message: 'Stopped' },
    );
    await searching;
    expect(state().searchResults).toBeUndefined();
    expect(state().error).toBeUndefined();
    expect(state().searching).toBe(retryId);
    await state().cancel();
    expect(window.openkraken.cancel).toHaveBeenCalledTimes(2);
    expect(window.openkraken.cancel).toHaveBeenLastCalledWith(pageId);
    page.resolve({ kind: 'cancelled' });
    await paging;
    retry.resolve(found);
    await retrying;
    expect(state().searchResults).toEqual(snapshot.commits);
  },
);

test.each(['cancel', 'edit', 'switch', 'refresh'] as const)(
  'full-history search queued during a background snapshot handles %s',
  async (action) => {
    const snapshot = fixture();
    await open(snapshot);
    const state = useRepository.getState;
    await state().search('First');
    const update = deferred();
    request.mockReturnValueOnce(update.promise);
    const refreshing = state().run(
      { id: crypto.randomUUID(), method: 'refresh', repoId: snapshot.repository.id },
      true,
    );
    const searching = state().searchAll();
    expect(state().searching).toBeDefined();
    if (action === 'cancel') await state().cancelSearch();
    if (action === 'edit') {
      await state().search('Changed');
      await state().search('First');
    }
    const next = fixture();
    if (action === 'switch') next.repository.id = 'e'.repeat(64);
    update.resolve({ kind: 'snapshot', snapshot: next });
    request.mockResolvedValueOnce({
      kind: 'search',
      cursor: next.cursor,
      commits: next.commits,
      truncated: false,
    });
    await Promise.all([refreshing, searching]);
    if (action === 'refresh') {
      expect(request).toHaveBeenCalledTimes(3);
      expect(request).toHaveBeenLastCalledWith(
        expect.objectContaining({
          method: 'search',
          query: 'First',
          cursor: next.cursor,
          repoId: next.repository.id,
        }),
      );
      expect(state().searchResults).toEqual(next.commits);
    } else {
      expect(request).toHaveBeenCalledTimes(2);
      expect(state().searchResults).toBeUndefined();
    }
    expect(window.openkraken.cancel).not.toHaveBeenCalled();
    expect(state().searching).toBeUndefined();
  },
);

test('a failed cancellation can be retried while the search is running', async () => {
  const snapshot = fixture();
  await open(snapshot);
  const state = useRepository.getState;
  await state().search('First');
  const search = deferred();
  request.mockReturnValueOnce(search.promise);
  const searching = state().searchAll();
  const id = state().searching;
  vi.mocked(window.openkraken.cancel).mockRejectedValueOnce(new Error('Connection closed'));
  await state().cancelSearch();
  expect(state().searching).toBe(id);
  expect(state().error).toContain('Connection closed');
  await state().cancelSearch();
  expect(state().searching).toBeUndefined();
  search.resolve({ kind: 'cancelled' });
  await searching;
});

function rejectRetiredSearchCancellation() {
  const cancellations: string[] = [];
  window.openkraken.cancel = async (id) => {
    cancellations.push(id);
    throw new Error('Retired request');
  };
  return cancellations;
}

test.each(['cancelled', 'snapshot'] as const)(
  'a picker returning %s retires search only on repository replacement',
  async (kind) => {
    const snapshot = fixture();
    await open(snapshot);
    await useRepository.getState().search('First');
    const read = deferred(),
      picker = deferred();
    request.mockReturnValueOnce(read.promise).mockReturnValueOnce(picker.promise);
    const searching = useRepository.getState().searchAll();
    const searchId = useRepository.getState().searching;
    const cancellations = rejectRetiredSearchCancellation();
    const switching = useRepository.getState().run({ id: crypto.randomUUID(), method: 'open' });
    expect(cancellations).toEqual([]);
    picker.resolve(kind === 'snapshot' ? { kind, snapshot: fixture() } : { kind });
    await switching;
    read.resolve({
      kind: 'search',
      cursor: snapshot.cursor,
      commits: snapshot.commits,
      truncated: false,
    });
    await searching;
    await new Promise((resolve) => setImmediate(resolve));
    expect(useRepository.getState().error).toBeUndefined();
    if (kind === 'cancelled') {
      expect(useRepository.getState().searchResults).toEqual(snapshot.commits);
      expect(cancellations).toEqual([]);
    } else {
      expect(useRepository.getState().searchResults).toBeUndefined();
      expect(cancellations).toEqual([searchId]);
    }
  },
);
test('editing a query discards late results even if cancelling the old search fails', async () => {
  const snapshot = fixture();
  await open(snapshot);
  await useRepository.getState().search('First');
  const pending = deferred();
  request.mockReturnValueOnce(pending.promise);
  const searching = useRepository.getState().searchAll();
  const searchId = useRepository.getState().searching;
  const cancellations = rejectRetiredSearchCancellation();
  await useRepository.getState().search('absent');
  expect(cancellations).toEqual([searchId]);
  pending.resolve({
    kind: 'search',
    cursor: snapshot.cursor,
    commits: snapshot.commits,
    truncated: false,
  });
  await searching;
  expect(useRepository.getState().searchResults).toBeUndefined();
  expect(useRepository.getState().matches).toEqual([]);
  await new Promise((resolve) => setImmediate(resolve));
  expect(useRepository.getState().error).toBeUndefined();
});
test('wrong page offset fails before modifying visible history', async () => {
  const snapshot = fixture();
  await open(snapshot);
  request.mockResolvedValueOnce({
    kind: 'page',
    cursor: snapshot.cursor,
    offset: 20,
    commits: [],
    hasMore: false,
  });
  await useRepository.getState().loadMore();
  expect(useRepository.getState().error).toContain('no longer matches');
  expect(useRepository.getState().rows).toHaveLength(1);
});

test('refresh keeps unchanged layout identities, selection, search and the active view', async () => {
  const snapshot = fixture();
  snapshot.view = { hiddenRefs: ['refs/heads/hidden'], pinnedRef: 'refs/heads/main' };
  snapshot.pinnedOid = snapshot.commits[0]!.oid;
  snapshot.commits.push({
    ...snapshot.commits[0]!,
    oid: 'b'.repeat(40),
    parents: [],
    summary: 'Second',
  });
  await open(snapshot);
  useRepository.getState().select('b'.repeat(40), 'toggle');
  await useRepository.getState().search('First');
  const before = useRepository.getState();
  const next = structuredClone(snapshot);
  next.cursor = crypto.randomUUID();
  next.commits[0]!.summary = 'Replacement';
  request.mockResolvedValueOnce({ kind: 'snapshot', snapshot: next });
  await useRepository
    .getState()
    .run({ id: crypto.randomUUID(), method: 'refresh', repoId: snapshot.repository.id });
  expect(request.mock.lastCall?.[0]).toMatchObject({ view: snapshot.view });
  expect(useRepository.getState().layout[0]).toBe(before.layout[0]);
  expect(useRepository.getState().layout[1]).toBe(before.layout[1]);
  expect(useRepository.getState().selection).toEqual(before.selection);
  expect(useRepository.getState().query).toBe('First');
  // The body still contains First, even though the subject changed.
  expect(useRepository.getState().matches).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
  await useRepository.getState().search('Replacement');
  expect(useRepository.getState().matches).toEqual(['a'.repeat(40)]);
});

test('changing views sends explicit roots and only applies the returned snapshot', async () => {
  const snapshot = fixture();
  await open(snapshot);
  const pending = deferred();
  request.mockReturnValueOnce(pending.promise);
  const view = { hiddenRefs: [], soloRef: 'refs/heads/side' };
  const changing = useRepository.getState().setView(view);
  expect(request.mock.lastCall?.[0]).toMatchObject({ method: 'refresh', view });
  expect(useRepository.getState().snapshot?.view).toEqual(snapshot.view);
  pending.resolve({
    kind: 'snapshot',
    snapshot: { ...snapshot, cursor: crypto.randomUUID(), commits: [], view, hasMore: false },
  });
  await changing;
  expect(useRepository.getState().snapshot?.view).toEqual(view);
  expect(useRepository.getState().layout).toEqual([]);
  expect(useRepository.getState().selection.selected).toEqual([]);
});
test('staging a displayed path updates status and keeps the graph and active search', async () => {
  const snapshot = fixture();
  const path = 'notes.txt';
  const entry = {
    path,
    pathBytes: Buffer.from(path).toString('base64'),
    kind: 'ordinary' as const,
    index: '.',
    worktree: 'M',
    submodule: 'N...',
  };
  snapshot.status.entries.push(entry);
  await open(snapshot);
  await useRepository.getState().search('notes');
  const previous = useRepository.getState();
  expect(previous.matches).toEqual([`wip:${snapshot.repository.id}`]);
  const refresh = async (status: Snapshot['status']) => {
    request.mockResolvedValueOnce({
      kind: 'workingState',
      state: { head: snapshot.repository.head, revision: '0'.repeat(64), status },
    });
    await useRepository.getState().refreshStatus();
    return useRepository.getState();
  };
  const staged = { ...entry, index: 'M', worktree: '.' };
  const updated = await refresh({ ...snapshot.status, entries: [staged] });
  expect(updated.snapshot?.status.entries).toEqual([staged]);
  expect(updated.workingState?.status.entries).toEqual([staged]);
  expect(updated.layout).toBe(previous.layout);
  expect(updated.rows).toBe(previous.rows);
  expect(updated.matches).toBe(previous.matches);
  useRepository.getState().setDetail(updated.rows[0]);
  const renamed = await refresh({
    ...snapshot.status,
    entries: [
      { ...staged, path: 'other.txt', pathBytes: Buffer.from('other.txt').toString('base64') },
    ],
  });
  expect(renamed.rows[0]?.body).toBe('other.txt');
  expect(renamed.detail).toBe(renamed.rows[0]);
  expect(renamed.layout).toBe(updated.layout);
  expect(renamed.passages).toBe(updated.passages);
  expect(renamed.selection).toBe(updated.selection);
  expect(renamed.rows[1]).toBe(updated.rows[1]);
  expect(renamed.matches).toEqual([]);
  const conflicted = await refresh({
    ...snapshot.status,
    entries: [{ ...staged, kind: 'conflict' }],
  });
  expect(conflicted.rows[0]?.kind).toBe('conflict');
  expect(conflicted.matches).toEqual([`conflict:${snapshot.repository.id}`]);
});

test('a rename before HEAD is loaded becomes searchable when its page arrives', async () => {
  const snapshot = fixture();
  const head = 'b'.repeat(40);
  snapshot.repository.head = { kind: 'branch', ref: 'refs/heads/main', oid: head };
  const entry = {
    path: 'old.txt',
    pathBytes: Buffer.from('old.txt').toString('base64'),
    kind: 'untracked' as const,
    index: '?',
    worktree: '?',
    submodule: 'N...',
  };
  snapshot.status.entries.push(entry);
  await open(snapshot);
  await useRepository.getState().search('renamed');
  const previous = useRepository.getState();
  const renamed = {
    ...entry,
    path: 'renamed.txt',
    pathBytes: Buffer.from('renamed.txt').toString('base64'),
  };
  request.mockResolvedValueOnce({
    kind: 'workingState',
    state: {
      head: snapshot.repository.head,
      revision: '0'.repeat(64),
      status: { ...snapshot.status, entries: [renamed] },
    },
  });
  await previous.refreshStatus();
  const updated = useRepository.getState();
  expect(updated.error).toBeUndefined();
  expect(updated.rows).toBe(previous.rows);
  expect(updated.snapshot?.status.entries).toEqual([renamed]);
  expect(updated.matches).toEqual([]);
  request.mockResolvedValueOnce({
    kind: 'page',
    cursor: snapshot.cursor,
    offset: 1,
    commits: [{ ...snapshot.commits[0]!, oid: head, parents: [] }],
    hasMore: false,
  });
  await updated.loadMore();
  expect(useRepository.getState().matches).toEqual([`wip:${snapshot.repository.id}`]);
});

test('status refresh preserves the append-only history cursor, loaded commits and selection', async () => {
  const snapshot = fixture();
  await open(snapshot);
  request.mockResolvedValueOnce({
    kind: 'page',
    cursor: snapshot.cursor,
    offset: 1,
    commits: [{ ...snapshot.commits[0]!, oid: 'b'.repeat(40), parents: [], summary: 'Second' }],
    hasMore: true,
  });
  await useRepository.getState().loadMore();
  useRepository.getState().select('b'.repeat(40));
  request.mockResolvedValueOnce({
    kind: 'workingState',
    state: {
      head: snapshot.repository.head,
      revision: '0'.repeat(64),
      status: {
        entries: [
          {
            path: 'a.txt',
            pathBytes: 'YS50eHQ=',
            kind: 'untracked',
            index: '?',
            worktree: '?',
            submodule: 'N...',
          },
        ],
        ahead: 0,
        behind: 0,
      },
    },
  });
  await useRepository.getState().refreshStatus();
  const updated = useRepository.getState();
  expect(updated.snapshot?.cursor).toBe(snapshot.cursor);
  expect(updated.snapshot?.commits).toHaveLength(2);
  expect(updated.rows.map((r) => r.kind)).toEqual(['wip', 'commit', 'commit']);
  expect(updated.selection.focus).toBe('b'.repeat(40));
  request.mockResolvedValueOnce({
    kind: 'page',
    cursor: snapshot.cursor,
    offset: 2,
    commits: [],
    hasMore: false,
  });
  await useRepository.getState().loadMore();
  expect(useRepository.getState().error).toBeUndefined();
  expect(useRepository.getState().rows).toHaveLength(3);
});
test('a user request arriving during background refresh runs after it instead of being dropped', async () => {
  const original = fixture();
  await open(original);
  const pending = deferred();
  request.mockReturnValueOnce(pending.promise);
  const refreshing = useRepository
    .getState()
    .run({ id: crypto.randomUUID(), method: 'refresh', repoId: original.repository.id }, true);
  const next = fixture();
  request.mockResolvedValueOnce({ kind: 'snapshot', snapshot: next });
  const userRequest = useRepository.getState().run({ id: crypto.randomUUID(), method: 'open' });
  pending.resolve({ kind: 'snapshot', snapshot: original });
  await Promise.all([refreshing, userRequest]);
  expect(useRepository.getState().snapshot?.cursor).toBe(next.cursor);
  expect(useRepository.getState().busy).toBeUndefined();
});
test('background snapshots retain undo controls until fresh working state arrives', async () => {
  const snapshot = fixture();
  await open(snapshot);
  useRepository.setState({
    workingState: {
      head: snapshot.repository.head,
      revision: '0'.repeat(64),
      status: snapshot.status,
      undo: { id: crypto.randomUUID(), label: 'Delete tag' },
    },
  });
  const next = fixture();
  request.mockResolvedValueOnce({ kind: 'snapshot', snapshot: next });
  await useRepository
    .getState()
    .run({ id: crypto.randomUUID(), method: 'refresh', repoId: snapshot.repository.id }, true);
  expect(useRepository.getState().workingState?.undo?.label).toBe('Delete tag');
  expect(useRepository.getState().syncing).toBeUndefined();
});

test('reopening the same repository retains its active watcher mode', async () => {
  const snapshot = fixture();
  await open(snapshot);
  useRepository.setState({ watcherMode: 'polling' });
  await open({ ...snapshot, cursor: crypto.randomUUID() });
  expect(useRepository.getState().watcherMode).toBe('polling');
  await open({ ...snapshot, repository: { ...snapshot.repository, id: 'b'.repeat(64) } });
  expect(useRepository.getState().watcherMode).toBeUndefined();
});
