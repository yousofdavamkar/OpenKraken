import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { GraphEngine } from '../graph/src/engine.js';
import type { GraphRequest } from '../graph/src/engine.js';
import type { Result, Snapshot } from '@openkraken/ipc-contract';
vi.mock('./src/graph-client.js', () => ({
  GraphClient: class {
    private engine = new GraphEngine();
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
