import { expect, test } from 'vitest';
import {
  encodeGitServiceResult,
  encodeSnapshotBodies,
  decodeSnapshotBodies,
  expandGitServiceResult,
  resultSchema,
  serializeLegacySnapshot,
  serviceResponseSchema,
  type Ref,
  type Snapshot,
} from './src/index.js';

const id = '00000000-0000-4000-8000-000000000001';
const oid = 'a'.repeat(40);
function snapshot(refs: Ref[]): Snapshot {
  return {
    cursor: id,
    refs,
    commits: [],
    hasMore: false,
    elapsedMs: 1,
    view: { hiddenRefs: [] },
    status: { entries: [], ahead: 0, behind: 0 },
    repository: {
      id: 'b'.repeat(64),
      path: '/repo',
      gitDir: '/repo',
      commonDir: '/repo',
      isBare: true,
      isShallow: false,
      isSparse: false,
      head: { kind: 'branch', ref: 'refs/heads/main', oid },
      state: 'clean',
    },
  };
}
const tag: Ref = {
  name: 'refs/tags/v1',
  shortName: 'v1',
  kind: 'tag',
  target: oid,
  objectType: 'commit',
  peeledType: '',
  isHead: false,
};

test('a large Git reply round-trips ordered refs and retains exceptional metadata', () => {
  const local: Ref = {
    ...tag,
    name: 'refs/heads/実験/🌱',
    shortName: '実験/🌱',
    kind: 'local',
    target: 'b'.repeat(64),
  };
  const remote: Ref = {
    ...tag,
    name: 'refs/remotes/origin/実験',
    shortName: 'origin/実験',
    kind: 'remote',
  };
  const exceptional: Ref[] = [
    { ...local, isHead: true },
    { ...local, upstream: { ref: remote.name, ahead: 2, behind: 3, gone: false } },
    { ...tag, objectType: 'tag', peeled: 'e'.repeat(40), peeledType: 'commit' },
    { ...tag, objectType: 'blob' },
    { ...tag, name: 'refs/stash', shortName: 'refs/stash', kind: 'stash' },
    { ...tag, name: 'refs/custom/x', shortName: 'refs/custom/x', kind: 'other' },
    { ...remote, shortName: 'custom display name' },
  ];
  const refs: Ref[] = [local, ...exceptional, remote, tag];
  while (refs.length < 10000) {
    const shortName = 'fixture-' + refs.length;
    refs.push({ ...tag, shortName, name: 'refs/tags/' + shortName });
  }
  const original = { kind: 'snapshot' as const, snapshot: snapshot(refs) };
  const encoded = encodeGitServiceResult(original);
  expect(encoded.kind).toBe('compactSnapshot');
  if (encoded.kind !== 'compactSnapshot') throw new Error('Expected compact Git reply');
  expect(encoded.snapshot.refs.slice(1, 1 + exceptional.length)).toEqual(exceptional);
  expect(typeof encoded.snapshot.refs[0]).toBe('string');
  expect(JSON.stringify(encoded).length).toBeLessThan(JSON.stringify(original).length / 2);
  // The service is untrusted. Extra fields on a rich record must never cross into the renderer.
  encoded.snapshot.refs[1] = Object.assign({}, exceptional[0]!, { extra: 'discard' });
  const checked = serviceResponseSchema.parse({ id, result: encoded }).result;
  expect(checked.kind).toBe('compactSnapshot');
  if (checked.kind !== 'compactSnapshot') throw new Error('Expected compact validated reply');
  expect(checked.snapshot.refs[1]).not.toHaveProperty('extra');
  expect(typeof checked.snapshot.refs[0]).toBe('string');
  const ordinary = expandGitServiceResult(checked);
  const store = expandGitServiceResult(checked, { freezeCompactRefs: true });
  if (ordinary.kind !== 'snapshot' || store.kind !== 'snapshot')
    throw new Error('Expected snapshots');
  expect(Object.isFrozen(ordinary.snapshot.refs[0])).toBe(false);
  expect(Object.isFrozen(store.snapshot.refs[0])).toBe(true);
  expect(Object.isFrozen(store.snapshot.refs[1])).toBe(false);
  expect(store.snapshot.refs).toStrictEqual(refs);
  expect(expandGitServiceResult(JSON.parse(JSON.stringify(checked)))).toStrictEqual(original);
  expect(resultSchema.safeParse(encoded).success).toBe(false);
});

test.each([40, 64])(
  'a shared %i-digit target preserves names, exceptions and the renderer wire format',
  (length) => {
    const target = 'b'.repeat(length);
    const refs: Ref[] = Array.from({ length: 10000 }, (_, i) => {
      const shortName = '共有/' + i;
      return { ...tag, target, name: 'refs/tags/' + shortName, shortName };
    });
    refs[1] = { ...tag, objectType: 'tag', peeled: target, peeledType: 'commit' };
    refs[2] = { ...refs[2]!, target: oid, isHead: true };
    const nextTarget = 'c'.repeat(length);
    refs[4] = { ...refs[4]!, target: nextTarget };
    refs[5] = { ...refs[5]!, target: nextTarget };
    const original = { kind: 'snapshot' as const, snapshot: snapshot(refs) };
    const wire = encodeGitServiceResult(original);
    if (wire.kind !== 'compactSnapshot') throw new Error('Expected compact utility reply');
    expect(wire.snapshot.refs.slice(0, 7)).toStrictEqual([
      target + ':' + refs[0]!.name,
      refs[1],
      refs[2],
      refs[3]!.name,
      nextTarget + ':' + refs[4]!.name,
      refs[5]!.name,
      target + ':' + refs[6]!.name,
    ]);
    wire.snapshot.refs[1] = Object.assign({}, refs[1]!, { extra: 'strip me' });
    const checked = serviceResponseSchema.parse({ id, result: wire }).result;
    if (checked.kind !== 'compactSnapshot') throw new Error('Expected compact renderer reply');
    const legacy = JSON.parse(serializeLegacySnapshot(checked));
    expect(legacy.snapshot.refs.slice(0, 4)).toStrictEqual([
      target + ':' + refs[0]!.name,
      refs[1],
      refs[2],
      target + ':' + refs[3]!.name,
    ]);
    expect(expandGitServiceResult(legacy)).toStrictEqual(original);
    const expanded = expandGitServiceResult(checked, { freezeCompactRefs: true });
    expect(expanded).toStrictEqual(original);
    if (expanded.kind !== 'snapshot') throw new Error('Expected decoded snapshot');
    expect(Object.isFrozen(expanded.snapshot.refs[3])).toBe(true);
  },
);

test('rejects invalid shared targets, names and exceptional records', () => {
  for (const refs of [
    ['refs/tags/a'],
    [tag, 'refs/heads/a'],
    ['bad:refs/tags/a', 'refs/tags/b'],
    [oid + ':refs/tags/a', 'refs/tag/b'],
    [oid + ':refs/tags/a', { ...tag, peeled: 'bad' }],
  ]) {
    expect(
      serviceResponseSchema.safeParse({
        id,
        result: { kind: 'compactSnapshot', snapshot: { ...snapshot([]), refs } },
      }).success,
    ).toBe(false);
  }
});

test('small snapshots and other result types use the ordinary reply', () => {
  const small = { kind: 'snapshot' as const, snapshot: snapshot([tag]) };
  expect(encodeGitServiceResult(small)).toBe(small);
  const rich = {
    kind: 'snapshot' as const,
    snapshot: snapshot(
      Array(10000).fill({ ...tag, objectType: 'tag', peeled: oid, peeledType: 'commit' }),
    ),
  };
  expect(encodeGitServiceResult(rich)).toBe(rich);
  const cancelled = { kind: 'cancelled' as const };
  expect(encodeGitServiceResult(cancelled)).toBe(cancelled);
});

test('main rejects malformed packed rows and validates the enclosing snapshot and request ID', () => {
  const result = { kind: 'compactSnapshot', snapshot: snapshot([]) };
  for (const row of [
    null,
    42,
    [],
    {},
    oid,
    'x'.repeat(40) + ':refs/tags/x',
    'a'.repeat(39) + ':refs/tags/x',
    'a'.repeat(41) + ':refs/tags/x',
    'a'.repeat(63) + ':refs/tags/x',
    'a'.repeat(65) + ':refs/tags/x',
    'a'.repeat(63) + 'G:refs/heads/main',
    'a'.repeat(39) + '\n:refs/heads/main',
    oid + ':refs/heads-suffix/main',
    oid + ':refs/unknown/x',
    { ...tag, target: 'bad' },
  ]) {
    expect(
      serviceResponseSchema.safeParse({
        id,
        result: { ...result, snapshot: { ...result.snapshot, refs: [row] } },
      }).success,
    ).toBe(false);
  }
  expect(serviceResponseSchema.safeParse({ id: 'wrong', result }).success).toBe(false);
  expect(
    serviceResponseSchema.safeParse({
      id,
      result: { ...result, snapshot: { ...result.snapshot, cursor: 'wrong' } },
    }).success,
  ).toBe(false);
});

test('initial commit bodies stay ordered for both snapshot formats and incomplete transfers fail', () => {
  const author = { name: 'Å', email: 'a@example.test', time: 1, tzOffsetMin: -60 };
  const commits = ['', 'independent summary\n🌱\u0000\r\n', '\"\\'.repeat(10000)].map(
    (body, i) => ({
      oid: String(i).repeat(40),
      parents: [],
      summary: 'Subject',
      author,
      committer: author,
      body,
      isStash: false,
    }),
  );
  const plain = { kind: 'snapshot' as const, snapshot: { ...snapshot([tag]), commits } };
  const compact = {
    kind: 'compactSnapshot' as const,
    snapshot: { ...plain.snapshot, refs: [oid + ':' + tag.name, 'refs/tags/v2'] },
  };
  for (const input of [plain, compact]) {
    const reply = structuredClone(encodeSnapshotBodies(input));
    if (typeof reply === 'string') throw new Error('Expected split snapshot');
    expect(reply.bodies).toEqual(commits.map((c) => c.body));
    expect(JSON.parse(reply.metadata).snapshot.commits[1]).not.toHaveProperty('body');
    expect(decodeSnapshotBodies(reply)).toStrictEqual(input);
    reply.bodies.pop();
    expect(() => decodeSnapshotBodies(reply)).toThrow('Incomplete snapshot commit bodies');
  }
  for (const result of [
    { kind: 'cancelled' },
    { kind: 'error', code: 'GIT_FAILED', message: 'Read failed' },
  ] as const) {
    expect(decodeSnapshotBodies(encodeSnapshotBodies(result))).toEqual(result);
  }
});
