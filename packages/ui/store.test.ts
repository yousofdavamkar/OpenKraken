import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { GraphEngine } from '../graph/src/engine.js';
import type { GraphRequest } from '../graph/src/engine.js';
import type { Result, Snapshot } from '@openkraken/ipc-contract';
vi.mock('./src/graph-client.js', () => ({
  GraphClient: class {
    private engine = new GraphEngine(true);
    close() {}
    async request(request: GraphRequest) {
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
function deferred() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const request = vi.fn<(request: unknown) => Promise<Result>>();
beforeEach(() => {
  useRepository.setState(useRepository.getInitialState(), true);
  request.mockReset();
  vi.stubGlobal('window', { openkraken: { request, cancel: vi.fn(async () => {}) } });
});
afterEach(() => vi.unstubAllGlobals());
async function open(snapshot: Snapshot) {
  request.mockResolvedValueOnce({ kind: 'snapshot', snapshot });
  await useRepository.getState().run({ id: crypto.randomUUID(), method: 'open' });
}
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
test('late all-history search is discarded after query changes', async () => {
  const snapshot = fixture();
  await open(snapshot);
  await useRepository.getState().search('First');
  const pending = deferred();
  request.mockReturnValueOnce(pending.promise);
  const searching = useRepository.getState().searchAll();
  await useRepository.getState().search('absent');
  pending.resolve({
    kind: 'search',
    cursor: snapshot.cursor,
    commits: snapshot.commits,
    truncated: false,
  });
  await searching;
  expect(useRepository.getState().searchResults).toBeUndefined();
  expect(useRepository.getState().matches).toEqual([]);
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
