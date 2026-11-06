import { expect, test } from 'vitest';
import {
  encodeGitServiceResult,
  resultSchema,
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
  expect(serviceResponseSchema.parse({ id, result: encoded }).result).toEqual(original);
  expect(resultSchema.safeParse(encoded).success).toBe(false);
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
