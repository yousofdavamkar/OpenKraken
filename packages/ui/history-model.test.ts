import { expect, test } from 'vitest';
import {
  locateRow,
  navigationTarget,
  projectCommits,
  refsByTarget,
  groupRefBadges,
  selectRow,
  soloRefView,
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
  expect(navigationTarget(rows, 0, 'ArrowDown', true)).toBe('left');
  expect(navigationTarget(rows, 3, 'ArrowUp', true)).toBe(2);
  expect(navigationTarget(rows, 0, 'ArrowUp', false)).toBe(0);
  expect(navigationTarget(rows, 3, 'ArrowDown', false)).toBe(3);
  expect(navigationTarget(rows, 1, 'Home', false)).toBe(0);
  expect(navigationTarget(rows, 1, 'End', false)).toBe(3);
  expect(navigationTarget(rows, 1, 'H', true, 'merge', 'right')).toBe('right');
  expect(navigationTarget(rows, 1, 'h', false, 'merge')).toBe('merge');
});
test('deep selection uses known positions and recovers by OID after a refresh moves rows', () => {
  let reads = 0;
  const history = Array<{ oid: string }>(32000).fill({
    get oid() {
      reads++;
      return 'earlier';
    },
  });
  history[31997] = { oid: 'anchor' };
  history[31998] = { oid: 'middle' };
  history[31999] = { oid: 'focus' };
  const selected = selectRow(history, { selected: [] }, 'anchor', 'single', 31997);
  const range = selectRow(history, selected, 'focus', 'range', 31999);
  expect(range.selected).toEqual(['anchor', 'middle', 'focus']);
  expect(locateRow(history, range.focus, range.focusIndex)).toBe(31999);
  expect(reads).toBe(0);
  const shifted = [{ oid: 'worktree' }, ...history];
  expect(locateRow(shifted, range.focus, range.focusIndex)).toBe(32000);
  expect(selectRow(shifted, range, 'middle', 'range', 31998).selected).toEqual([
    'anchor',
    'middle',
  ]);
  expect(locateRow(shifted, 'removed', range.focusIndex)).toBe(-1);
});

test('navigation at row 32,000 reads only the rows needed to locate its closest child', () => {
  const history = Array<DisplayCommit>(32000).fill(rows[0]!);
  history[31998] = rows[2]!;
  history[31999] = rows[3]!;
  const reads: string[] = [];
  const observed = new Proxy(history, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads.push(key);
      return Reflect.get(target, key, receiver);
    },
  });
  expect(navigationTarget(observed, 31999, 'Home', false)).toBe(0);
  expect(navigationTarget(observed, 31999, 'PageUp', false)).toBe(31979);
  expect(reads).toEqual([]);
  expect(navigationTarget(observed, 31999, 'ArrowUp', true)).toBe(31998);
  expect(reads).toEqual(['31999', '31998']);
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
  const index = refsByTarget(refs);
  const aliases = index.get('a')!;
  const single = index.get('b')!;
  expect(aliases).toEqual(refs.slice(0, 5));
  expect(single).toEqual([refs[5]]);
  expect(index.get('b')).toBe(single);
  expect(index.get('a')).toBe(aliases);
  expect(index.get('tag')).toBeUndefined();
  expect(index.size).toBe(2);
  expect(groupRefBadges(aliases).badges).toEqual([
    {
      label: 'main',
      nameCount: 3,
      names: ['refs/heads/main', 'refs/remotes/origin/main', 'refs/remotes/fork/main'],
      kind: 'branch',
    },
    { label: 'main', nameCount: 1, names: ['refs/tags/main'], kind: 'tag' },
    { label: 'feature', nameCount: 1, names: ['refs/heads/feature'], kind: 'branch' },
  ]);
  expect(groupRefBadges(single).badges).toEqual([
    { label: 'main', nameCount: 1, names: ['refs/heads/other-main'], kind: 'branch' },
  ]);
});

test('HEAD and upstream shortcuts follow visible or loaded commits, including peeled tracking tips', () => {
  const snapshot = {
    view: { hiddenRefs: ['refs/heads/main'] },
    repository: { head: { kind: 'branch', ref: 'refs/heads/main', oid: 'head' } },
    refs: [
      { name: 'refs/heads/main', target: 'head', upstream: { ref: 'refs/remotes/origin/main' } },
      { name: 'refs/remotes/origin/main', target: 'remote', objectType: 'commit' },
    ],
  } as Snapshot;
  expect(refNavigationTargets(snapshot, [])).toEqual({ head: undefined, upstream: 'remote' });
  snapshot.view.soloRef = 'refs/heads/other';
  expect(refNavigationTargets(snapshot, [])).toEqual({ head: undefined, upstream: undefined });
  expect(refNavigationTargets(snapshot, [{ oid: 'head' }, { oid: 'remote' }])).toEqual({
    head: 'head',
    upstream: 'remote',
  });

  const tracking = snapshot.refs[1]!;
  tracking.objectType = 'tag';
  tracking.peeled = 'base';
  tracking.peeledType = 'commit';
  snapshot.view = { hiddenRefs: [] };
  expect(refNavigationTargets(snapshot, []).upstream).toBe('base');
  snapshot.view.hiddenRefs = [tracking.name];
  expect(refNavigationTargets(snapshot, []).upstream).toBeUndefined();
  expect(refNavigationTargets(snapshot, [{ oid: 'base' }]).upstream).toBe('base');
  snapshot.view.hiddenRefs = [];
  tracking.peeledType = 'tree';
  expect(refNavigationTargets(snapshot, []).upstream).toBeUndefined();
  tracking.objectType = 'blob';
  tracking.peeledType = '';
  delete tracking.peeled;
  expect(refNavigationTargets(snapshot, []).upstream).toBeUndefined();
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
    const { badges } = groupRefBadges(refsByTarget(refs).get(target)!);
    const elapsedMs = performance.now() - start;
    expect(badges).toHaveLength(50000);
    expect(badges.map((badge) => badge.names[0])).toEqual(refs.map((ref) => ref.name));
    expect(badges[0]).toEqual({
      label: 'topic-0',
      nameCount: 1,
      kind: 'branch',
      names: ['refs/heads/topic-0'],
    });
    expect(badges.at(-1)).toEqual({
      label: 'topic-49999',
      nameCount: 1,
      kind: 'branch',
      names: ['refs/heads/topic-49999'],
    });
    // Generous algorithmic guard; the complete desktop still has its separate 500 ms gate.
    expect(elapsedMs).toBeLessThan(1000);
  },
);

test('large hidden-ref lists preserve visible badge order and solo takes precedence', () => {
  const refs: Ref[] = Array.from({ length: 50000 }, (_, i) => ({
    name: `refs/tags/benchmark-${String(i).padStart(5, '0')}`,
    shortName: String(i),
    kind: 'tag',
    target: 'a'.repeat(40),
    objectType: 'commit',
    peeledType: '',
    isHead: false,
  }));
  const hiddenRefs = refs.filter((_, i) => i % 5 === 0).map((ref) => ref.name);
  const start = performance.now();
  const { badges } = groupRefBadges(refsByTarget(refs, { hiddenRefs }).get(refs[0]!.target)!);
  const elapsed = performance.now() - start;
  expect(badges.map((badge) => badge.names[0])).toEqual(
    refs.filter((_, i) => i % 5 !== 0).map((ref) => ref.name),
  );
  expect(elapsed).toBeLessThan(1000);
  expect(
    groupRefBadges(refsByTarget(refs, { hiddenRefs, soloRef: refs[0]!.name }).get(refs[0]!.target)!)
      .badges,
  ).toEqual([{ label: '0', nameCount: 1, kind: 'tag', names: [refs[0]!.name] }]);
  expect(refsByTarget(refs, { hiddenRefs, soloRef: 'refs/tags/missing' }).size).toBe(0);
});

test('a capped badge preview counts matching branches even after later labels overflow', () => {
  const ref = (kind: 'local' | 'remote' | 'tag', shortName: string): Ref => ({
    name:
      (kind === 'local' ? 'refs/heads/' : kind === 'remote' ? 'refs/remotes/' : 'refs/tags/') +
      shortName,
    kind,
    shortName,
    target: 'a'.repeat(40),
    objectType: 'commit',
    isHead: false,
    peeledType: '',
  });
  const refs = [
    ref('local', 'main'),
    ref('tag', 'main'),
    ref('local', 'feature'),
    ref('tag', 'v1'),
    ref('remote', 'origin/main'),
    ref('remote', 'fork/main'),
    ref('remote', 'last/main'),
  ];
  const { badges, overflow } = groupRefBadges(refs, 3);
  expect(overflow).toBe(true);
  expect(badges).toEqual([
    {
      kind: 'branch',
      label: 'main',
      names: ['refs/heads/main', 'refs/remotes/origin/main', 'refs/remotes/fork/main'],
      nameCount: 4,
    },
    { kind: 'tag', label: 'main', names: ['refs/tags/main'], nameCount: 1 },
    { kind: 'branch', label: 'feature', names: ['refs/heads/feature'], nameCount: 1 },
  ]);
  expect(groupRefBadges(refs).badges.flatMap((b) => b.names)).toEqual([
    'refs/heads/main',
    'refs/remotes/origin/main',
    'refs/remotes/fork/main',
    'refs/remotes/last/main',
    'refs/tags/main',
    'refs/heads/feature',
    'refs/tags/v1',
  ]);
  expect(groupRefBadges(refs.slice(0, 3), 3).overflow).toBe(false);
  const nested = [
    ref('local', 'release/v1'),
    ref('tag', 'release/v1'),
    ref('remote', 'upstream/release/v1'),
  ];
  expect(groupRefBadges(nested, 1)).toEqual({
    badges: [
      { kind: 'branch', label: 'release/v1', names: ['refs/heads/release/v1'], nameCount: 2 },
    ],
    overflow: true,
  });
  expect(groupRefBadges(nested, 0)).toEqual({ badges: [], overflow: true });
});

test('soloing a ref reveals it and retains a pin only when it points to that ref', () => {
  const original = { hiddenRefs: ['topic', 'other'], pinnedRef: 'main' };
  expect(soloRefView(original, 'topic')).toEqual({
    soloRef: 'topic',
    hiddenRefs: ['other'],
    pinnedRef: undefined,
  });
  expect(soloRefView(original, 'main')).toEqual({
    soloRef: 'main',
    hiddenRefs: ['topic', 'other'],
    pinnedRef: 'main',
  });
  expect(original).toEqual({ hiddenRefs: ['topic', 'other'], pinnedRef: 'main' });
});
