import { expect, test } from 'vitest';
import {
  navigationTarget,
  projectCommits,
  refBadges,
  selectRow,
  refNavigationTargets,
} from './src/history-model.js';
import type { DisplayCommit } from './src/history-model.js';
import type { Snapshot, Commit, Ref } from '@openkraken/ipc-contract';
const commit = (oid: string, parents: string[] = []): Commit => ({
  oid,
  parents,
  summary: oid,
  body: oid,
  isStash: false,
  author: { name: 'Author', email: 'author@example.test', time: 1, tzOffsetMin: 0 },
  committer: { name: 'Author', email: '', time: 1, tzOffsetMin: 0 },
});
const rows: DisplayCommit[] = [
  commit('merge', ['left', 'right']),
  commit('left', ['root']),
  commit('right', ['root']),
  commit('root'),
].map((c) => ({ ...c, kind: 'commit' }));
test('range, toggle and ancestry navigation preserve stable OID selection', () => {
  const initial = selectRow(rows, { selected: [] }, 'merge');
  expect(selectRow(rows, initial, 'right', 'range').selected).toEqual(['merge', 'left', 'right']);
  const toggled = selectRow(rows, initial, 'root', 'toggle');
  expect(toggled.selected).toEqual(['merge', 'root']);
  expect(selectRow(rows, toggled, 'merge', 'toggle').selected).toEqual(['root']);
  expect(navigationTarget(rows, 'merge', 'ArrowDown', true)).toBe('left');
  expect(navigationTarget(rows, 'root', 'ArrowUp', true)).toBe('right');
  expect(navigationTarget(rows, 'merge', 'ArrowUp', false)).toBe('merge');
  expect(navigationTarget(rows, 'root', 'ArrowDown', false)).toBe('root');
  expect(navigationTarget(rows, 'left', 'Home', false)).toBe('merge');
  expect(navigationTarget(rows, 'left', 'End', false)).toBe('root');
  expect(navigationTarget(rows, 'left', 'H', true, 'merge', 'right')).toBe('right');
  expect(navigationTarget(rows, 'left', 'h', false, 'merge')).toBe('merge');
});
test('synthetic rows are inserted only on the page containing HEAD, including unborn conflicts', () => {
  const snapshot = {
    repository: { id: 'repo', head: { kind: 'branch', ref: 'refs/heads/main', oid: 'root' } },
    status: { entries: [{ path: 'conflicted.txt', kind: 'conflict' }] },
  } as Snapshot;
  expect(projectCommits(rows.slice(0, 2), snapshot).map((c) => c.oid)).toEqual(['merge', 'left']);
  expect(projectCommits(rows.slice(2), snapshot).map((c) => c.oid)).toEqual([
    'right',
    'conflict:repo',
    'root',
  ]);
  snapshot.repository.head = { kind: 'branch', ref: 'refs/heads/main' };
  expect(projectCommits([], snapshot, true)[0]?.parents).toEqual([]);
});
test('local and remote badges sharing a name and target combine; tags stay separate', () => {
  const refs = [
    { name: 'refs/heads/main', shortName: 'main', kind: 'local', target: 'a' },
    { name: 'refs/remotes/origin/main', shortName: 'origin/main', kind: 'remote', target: 'a' },
    { name: 'refs/tags/main', shortName: 'main', kind: 'tag', target: 'tag', peeled: 'a' },
  ] as Ref[];
  expect(refBadges(refs).get('a')).toEqual([
    { label: 'main', names: ['refs/heads/main', 'refs/remotes/origin/main'], kind: 'branch' },
    { label: 'main', names: ['refs/tags/main'], kind: 'tag' },
  ]);
});

test('HEAD and upstream shortcuts do not scan excluded histories, but still select loaded shared commits', () => {
  const snapshot = {
    view: { hiddenRefs: ['refs/heads/main'] },
    repository: { head: { kind: 'branch', ref: 'refs/heads/main', oid: 'head' } },
    refs: [
      { name: 'refs/heads/main', target: 'head', upstream: { ref: 'refs/remotes/origin/main' } },
      { name: 'refs/remotes/origin/main', target: 'remote' },
    ],
  } as Snapshot;
  expect(refNavigationTargets(snapshot, [])).toEqual({ head: undefined, upstream: 'remote' });
  snapshot.view.soloRef = 'refs/heads/other';
  expect(refNavigationTargets(snapshot, [])).toEqual({ head: undefined, upstream: undefined });
  expect(refNavigationTargets(snapshot, [{ oid: 'head' }, { oid: 'remote' }])).toEqual({
    head: 'head',
    upstream: 'remote',
  });
});
