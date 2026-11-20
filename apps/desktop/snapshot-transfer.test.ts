import { expect, test } from 'vitest';
import { SnapshotTransfer } from './src/snapshot-transfer.js';
import {
  encodeAliasedTagRefs,
  requestSchema,
  serviceRequestSchema,
  snapshotPartSchema,
  type Ref,
} from '@openkraken/ipc-contract';

const id = '00000000-0000-4000-8000-000000000001';
const transferId = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const oid = 'a'.repeat(40);
const tag = {
  name: 'refs/tags/v1',
  shortName: 'v1',
  kind: 'tag',
  target: oid,
  objectType: 'tag',
  peeled: 'b'.repeat(40),
  peeledType: 'commit',
  isHead: false,
};
const refs = [
  oid + ':refs/heads/main',
  ...Array.from({ length: 9998 }, (_, i) => 'refs/tags/t' + i),
  { ...tag, unknown: true },
];
const first = { id, transferId, snapshotPart: 'refs', refs };
const snapshot = {
  cursor: id,
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
const last = { id, transferId, snapshotPart: 'complete', snapshot, refCount: refs.length };

test('main returns one validated snapshot for the matching request and opening', () => {
  const transfer = new SnapshotTransfer(id, transferId);
  expect(transfer.receive({ ...first, id: other })).toBeUndefined();
  expect(transfer.receive({ ...first, transferId: other })).toBeUndefined();
  expect(transfer.receive(first)).toBeUndefined();
  expect(transfer.receive({ ...last, transferId: other })).toBeUndefined();
  const result = transfer.receive(last);
  expect(result?.kind).toBe('compactSnapshot');
  if (result?.kind !== 'compactSnapshot') throw Error('Missing snapshot');
  expect(result.snapshot.refs).toEqual([...refs.slice(0, -1), tag]);
  expect(result.snapshot.cursor).toBe(id);
});

test('main reconstructs consecutive annotated aliases and preserves exceptional refs in order', () => {
  const source: Ref[] = Array.from({ length: 10000 }, (_, i) => ({
    ...tag,
    kind: 'tag',
    name: 'refs/tags/发布/' + i,
    shortName: '发布/' + i,
  }));
  source[2] = { ...source[2]!, peeledType: 'tree' };
  source[4] = {
    ...source[4]!,
    upstream: { ref: 'refs/heads/main', ahead: 1, behind: 2, gone: false },
  };
  source[6] = { ...source[6]!, target: 'c'.repeat(64), peeled: 'd'.repeat(64), peeledType: 'blob' };
  source[7] = { ...source[6]!, name: source[7]!.name, shortName: source[7]!.shortName };
  expect(encodeAliasedTagRefs(source.slice(0, 9999))).toBeUndefined();
  const rows = encodeAliasedTagRefs(source)!;
  expect(rows.slice(0, 8)).toEqual([
    source[0],
    source[1]!.name,
    source[2],
    source[3],
    source[4],
    source[5],
    source[6],
    source[7]!.name,
  ]);
  const transfer = new SnapshotTransfer(id, transferId);
  const message = { ...first, snapshotPart: 'tagAliases', refs: rows };
  transfer.receive(message);
  const result = transfer.receive(last);
  expect(result?.kind).toBe('snapshot');
  if (result?.kind !== 'snapshot') throw Error('Missing snapshot');
  expect(result.snapshot.refs).toStrictEqual(source);
});

test('tag aliases require a matching opener and share the transfer identity and duplicate checks', () => {
  const partial = {
    ...first,
    snapshotPart: 'tagAliases',
    refs: [tag, ...Array<string>(9999).fill('refs/tags/two')],
  };
  for (const rows of [
    ['refs/tags/two'],
    [tag, 'refs/heads/main'],
    [tag, 'refs/tags/'],
    [{ ...tag, isHead: true }, 'refs/tags/two'],
    [{ ...tag, target: 'bad' }, 'refs/tags/two'],
    [tag, { ...tag, kind: 'other' }, 'refs/tags/two'],
  ]) {
    const transfer = new SnapshotTransfer(id, transferId);
    const message = { ...partial, refs: rows };
    expect(snapshotPartSchema.safeParse(message).success).toBe(false);
    transfer.receive(message);
    expect(transfer.receive(last)).toMatchObject({ kind: 'error', code: 'INVALID_SNAPSHOT' });
  }
  for (const duplicate of [
    [first, partial],
    [partial, first],
  ]) {
    const transfer = new SnapshotTransfer(id, transferId);
    for (const message of duplicate) transfer.receive(message);
    expect(transfer.receive(last)).toMatchObject({ kind: 'error', code: 'INVALID_SNAPSHOT' });
  }
});

test('missing, duplicate, malformed or inconsistent parts fail without publishing a partial snapshot', () => {
  const invalid = { kind: 'error', code: 'INVALID_SNAPSHOT' };
  for (const parts of [
    [last],
    [first, first, last],
    [{ ...first, refs: refs.slice(1) }, last],
    [{ ...first, refs: [tag] }, last],
    [first, { ...last, refCount: refs.length + 1 }],
    [first, { ...last, snapshot: { ...snapshot, commits: [{}] } }],
    [first, { ...last, snapshot: { ...snapshot, refs: [] } }],
  ]) {
    const receiver = new SnapshotTransfer(id, transferId);
    for (const part of parts.slice(0, -1)) expect(receiver.receive(part)).toBeUndefined();
    expect(receiver.receive(parts.at(-1)!)).toMatchObject(invalid);
  }
});

test('a retried request ID can only receive parts from the new opening', () => {
  const retry = new SnapshotTransfer(id, other);
  expect(retry.receive(first)).toBeUndefined();
  expect(retry.receive(last)).toBeUndefined();
  expect(retry.receive({ ...first, transferId: other })).toBeUndefined();
  expect(retry.receive(last)).toBeUndefined();
  expect(retry.receive({ ...last, transferId: other })?.kind).toBe('compactSnapshot');
});

test('only main can add the transfer identity to an open request', () => {
  expect(requestSchema.safeParse({ id, method: 'open', transferId }).success).toBe(false);
  expect(
    serviceRequestSchema.safeParse({ id, method: 'open', transferId, path: '/repo' }).success,
  ).toBe(true);
  expect(
    serviceRequestSchema.safeParse({ id, method: 'open', transferId: 'bad', path: '/repo' })
      .success,
  ).toBe(false);
});
