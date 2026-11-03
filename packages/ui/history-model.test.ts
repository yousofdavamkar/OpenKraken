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
    { name: 'refs/heads/feature', shortName: 'feature', kind: 'local', target: 'a' },
    { name: 'refs/remotes/fork/main', shortName: 'fork/main', kind: 'remote', target: 'a' },
    { name: 'refs/heads/other-main', shortName: 'main', kind: 'local', target: 'b' },
  ] as Ref[];
  expect(refBadges(refs).get('a')).toEqual([
    {
      label: 'main',
      names: ['refs/heads/main', 'refs/remotes/origin/main', 'refs/remotes/fork/main'],
      kind: 'branch',
    },
    { label: 'main', names: ['refs/tags/main'], kind: 'tag' },
    { label: 'feature', names: ['refs/heads/feature'], kind: 'branch' },
  ]);
  expect(refBadges(refs).get('b')).toEqual([
    { label: 'main', names: ['refs/heads/other-main'], kind: 'branch' },
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

test(
  '50,000 refs sharing a commit retain badge order and every full ref name',
  { timeout: 2000 },
  () => {
    const target = 'a'.repeat(40);
    const refs: Ref[] = Array.from({ length: 50000 }, (_, index) => ({
      name: `refs/heads/topic-${index}`,
      shortName: `topic-${index}`,
      kind: 'local',
      target,
      objectType: 'commit',
      peeledType: '',
      isHead: index === 0,
    }));
    const start = performance.now();
    const badges = refBadges(refs).get(target)!;
    const elapsedMs = performance.now() - start;
    expect(badges).toHaveLength(50000);
    expect(badges.map((badge) => badge.names[0])).toEqual(refs.map((ref) => ref.name));
    expect(badges[0]).toEqual({ label: 'topic-0', kind: 'branch', names: ['refs/heads/topic-0'] });
    expect(badges.at(-1)).toEqual({
      label: 'topic-49999',
      kind: 'branch',
      names: ['refs/heads/topic-49999'],
    });
    // Generous algorithmic guard; the complete desktop still has its separate 500 ms gate.
    expect(elapsedMs).toBeLessThan(1000);
  },
);
