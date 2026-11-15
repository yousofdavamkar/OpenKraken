import { expect, test } from 'vitest';
import { allocateLanes, emptyCheckpoint, type GraphCommit } from './src/index.js';
import type { GraphResponse } from './src/engine.js';
import { packLayout, unpackLayout } from './src/layout-message.js';

function checkTransfer(commits: GraphCommit[], checkpoint = emptyCheckpoint(), compact = true) {
  const result = allocateLanes(commits, checkpoint, compact);
  const reply: Extract<GraphResponse, { kind: 'layout' }> = {
    id: 7,
    generation: 'current',
    kind: 'layout',
    offset: checkpoint.nextRow,
    rows: result.rows,
    maxColumns: result.checkpoint.maxColumns,
    checkpointRows: result.checkpoints.map((c) => c.nextRow),
    reusedTail: 12,
    passages: result.passages,
  };
  const packed = packLayout(reply);
  const received = structuredClone(packed, {
    transfer: [packed.nodes.buffer, packed.edges.buffer],
  });
  expect(() => new Uint8Array(packed.nodes.buffer)).toThrow(TypeError);
  expect(() => new Uint8Array(packed.edges.buffer)).toThrow(TypeError);
  expect(unpackLayout(received)).toStrictEqual(reply);
  return result.checkpoint;
}

test('layout messages preserve pinned lanes, merges, stashes and page offsets across transfer', () => {
  const first = [
    { oid: 'worktree:linked', parents: ['tip'] },
    { oid: 'tip', parents: ['main', 'side', 'other'] },
    { oid: 'stash', parents: ['side', 'ignored'], isStash: true },
  ];
  const next = [
    { oid: 'main', parents: ['root'] },
    { oid: 'side', parents: ['root'] },
    { oid: 'other', parents: ['root'] },
    { oid: 'root', parents: [] },
  ];
  for (const compact of [true, false]) {
    const checkpoint = checkTransfer(first, emptyCheckpoint('tip'), compact);
    checkTransfer(next, checkpoint, compact);
    checkTransfer([], checkpoint, compact);
  }
});
