import { expect, test } from 'vitest';
import { GraphEngine, type GraphDocument } from './src/engine.js';
import { allocateLanes, emptyCheckpoint } from './src/index.js';
import { rowSegments, paintGraph } from './src/canvas.js';
const documents = (count: number): GraphDocument[] =>
  Array.from({ length: count }, (_, i) => ({
    oid: String(i),
    parents: i < count - 1 ? [String(i + 1)] : [],
    summary: i === 3 ? 'Fix navigation' : `Commit ${i}`,
    body: i === 5 ? 'A hidden phrase in the body' : '',
    author: { name: 'Zoë Writer', email: 'zoe@example.test' },
  }));
test('worker appends only new rows, indexes appended fields and rejects stale/duplicate pages', () => {
  const engine = new GraphEngine(),
    commits = documents(1000);
  const first = engine.handle({
    id: 1,
    generation: 'a',
    method: 'reset',
    offset: 0,
    commits: commits.slice(0, 500),
  });
  const saved = structuredClone(first);
  const second = engine.handle({
    id: 2,
    generation: 'a',
    method: 'append',
    offset: 500,
    commits: commits.slice(500),
  });
  if (first.kind !== 'layout' || second.kind !== 'layout') throw new Error('Expected layouts');
  expect(first).toEqual(saved);
  expect(second.rows).toHaveLength(500);
  expect([...first.rows, ...second.rows]).toEqual(allocateLanes(commits).rows);
  expect(second.checkpointRows).toEqual([1000]);
  for (const query of ['nav', 'hidden phrase', 'zoe@example.test', '999']) {
    const response = engine.handle({ id: 3, generation: 'a', method: 'search', query });
    expect(response.kind === 'matches' && response.oids.length > 0).toBe(true);
  }
  expect(engine.handle({ id: 4, generation: 'old', method: 'search', query: 'fix' }).kind).toBe(
    'error',
  );
  expect(
    engine.handle({ id: 5, generation: 'a', method: 'append', offset: 500, commits: [] }).kind,
  ).toBe('error');
  expect(
    engine.handle({
      id: 6,
      generation: 'a',
      method: 'append',
      offset: 1000,
      commits: [commits[0]!],
    }).kind,
  ).toBe('error');
  engine.handle({ id: 7, generation: 'b', method: 'reset', offset: 0, commits: [] });
  expect(
    engine.handle({ id: 8, generation: 'b', method: 'search', query: 'navigation' }),
  ).toMatchObject({ kind: 'matches', oids: [] });
});
test('canvas segments meet at row boundaries and use correct upper/lower halves', () => {
  const rows = allocateLanes([
    { oid: 'merge', parents: ['a', 'b'] },
    { oid: 'a', parents: ['root'] },
    { oid: 'b', parents: ['root'] },
    { oid: 'root', parents: [] },
  ]).rows;
  expect(rowSegments(rows[0]!, 0).every((s) => s.y1 === 14 && s.y2 === 28)).toBe(true);
  const outgoing = rowSegments(rows[0]!, 0);
  const incoming = rowSegments(rows[1]!, 28);
  for (const edge of outgoing)
    expect(incoming.some((e) => e.x1 === edge.x2 && e.y1 === edge.y2)).toBe(true);
});
test('canvas work and pixel buffer are bounded by viewport, including DPR and partial rows', () => {
  const rows = allocateLanes(documents(10000)).rows;
  let nodes = 0;
  const context = {
    canvas: { width: 0, height: 0 },
    setTransform() {},
    translate() {},
    clearRect() {},
    setLineDash() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    bezierCurveTo() {},
    stroke() {},
    fill() {},
    arc() {
      nodes++;
    },
  } as unknown as CanvasRenderingContext2D;
  paintGraph(context, rows, { width: 120, height: 560, scrollTop: 2807, dpr: 2 });
  expect(nodes).toBe(21);
  expect(context.canvas).toMatchObject({ width: 240, height: 1120 });
});

test('pin reserves lane zero for the first-parent chain across pages and converging branches', () => {
  const commits = [
    { oid: 'other', parents: ['shared'] },
    { oid: 'pin', parents: ['middle', 'side'] },
    { oid: 'side', parents: ['shared'] },
    { oid: 'middle', parents: ['shared'] },
    { oid: 'shared', parents: ['root'] },
    { oid: 'root', parents: [] },
  ];
  const all = allocateLanes(commits, emptyCheckpoint('pin'));
  expect(
    all.rows
      .filter((r) => ['pin', 'middle', 'shared', 'root'].includes(r.oid))
      .every((r) => r.column === 0),
  ).toBe(true);
  expect(all.rows[0]?.column).toBe(1);
  expect(all.rows[0]?.edges.some((e) => e.from === 0)).toBe(false);
  const first = allocateLanes(commits.slice(0, 3), emptyCheckpoint('pin'));
  const second = allocateLanes(commits.slice(3), first.checkpoint);
  expect([...first.rows, ...second.rows]).toEqual(all.rows);
  expect(all.rows[4]?.edges.filter((e) => e.kind === 'end').map((e) => e.from)).toEqual([0, 1]);
  expect(all.checkpoint.lanes).toEqual([]);
});

test('refresh reuses a stable prefix and converged suffix, then appends from the right state', () => {
  const engine = new GraphEngine(),
    commits = documents(2000);
  const first = engine.handle({ id: 1, generation: 'a', method: 'reset', offset: 0, commits });
  if (first.kind !== 'layout') throw new Error('Expected layout');
  const changed = structuredClone(commits);
  // Replace one node and its incoming reference; continuation converges below it.
  changed[749]!.parents = ['replacement'];
  changed[750]!.oid = 'replacement';
  const refresh = engine.handle({
    id: 2,
    generation: 'b',
    baseGeneration: 'a',
    method: 'refresh',
    offset: 0,
    commits: changed,
  });
  if (refresh.kind !== 'layout') throw new Error('Expected layout');
  expect(refresh.offset).toBe(500);
  expect(refresh.reusedTail).toBe(1000);
  const patched = [
    ...first.rows.slice(0, refresh.offset),
    ...refresh.rows,
    ...first.rows.slice(changed.length - refresh.reusedTail),
  ];
  expect(patched).toEqual(allocateLanes(changed).rows);
  const appended = engine.handle({
    id: 3,
    generation: 'b',
    method: 'append',
    offset: 2000,
    commits: [{ ...commits[0]!, oid: 'new orphan', parents: [] }],
  });
  if (appended.kind !== 'layout') throw new Error('Expected layout');
  expect([...patched, ...appended.rows]).toEqual(
    allocateLanes([...changed, { oid: 'new orphan', parents: [] }]).rows,
  );
});

test('refresh handles metadata-only changes, insertions, truncation, repinning and stale generations', () => {
  const engine = new GraphEngine();
  let commits = documents(1200),
    generation = '0';
  let response = engine.handle({ id: 1, generation, method: 'reset', offset: 0, commits });
  if (response.kind !== 'layout') throw new Error('Expected layout');
  let rows = response.rows;
  const update = (next: GraphDocument[], pinnedOid?: string) => {
    response = engine.handle({
      id: 2,
      generation: String(+generation + 1),
      baseGeneration: generation,
      method: 'refresh',
      offset: 0,
      commits: next,
      pinnedOid,
    });
    generation = String(+generation + 1);
    if (response.kind !== 'layout') throw new Error('Expected layout');
    rows = [
      ...rows.slice(0, response.offset),
      ...response.rows,
      ...rows.slice(next.length - response.reusedTail, next.length),
    ];
    expect(rows).toEqual(allocateLanes(next, emptyCheckpoint(pinnedOid)).rows);
    commits = next;
    return response;
  };
  const metadata = structuredClone(commits);
  metadata[3]!.body = 'Replacement text';
  expect(update(metadata)).toMatchObject({ offset: 1200, rows: [] });
  expect(
    engine.handle({ id: 3, generation, method: 'search', query: 'Replacement' }),
  ).toMatchObject({ oids: ['3'] });
  update([{ ...commits[0]!, oid: 'new', parents: ['0'] }, ...commits]);
  update(commits.slice(0, 750));
  update(commits, '500');
  expect(
    engine.handle({
      id: 4,
      generation: 'bad',
      baseGeneration: 'stale',
      method: 'refresh',
      offset: 0,
      commits: [],
    }).kind,
  ).toBe('error');
  update(commits, '500');
  update([]);
});

test('pin reservation ends at its root and does not capture a later unrelated chain', () => {
  const commits = [
    { oid: 'other', parents: ['shared'] },
    { oid: 'pin', parents: [] },
    { oid: 'later', parents: ['shared'] },
    { oid: 'shared', parents: [] },
  ];
  const result = allocateLanes(commits, emptyCheckpoint('pin'));
  expect(result.rows[2]?.edges.find((e) => e.kind === 'merge-in')?.to).toBe(1);
  expect(result.rows[3]?.column).toBe(1);
  expect(result.checkpoint.pinned).toBeUndefined();
});

test('a truncated refresh cannot reuse the previous longer continuation at its final checkpoint', () => {
  const engine = new GraphEngine(),
    commits = documents(2000);
  engine.handle({ id: 1, generation: 'a', method: 'reset', offset: 0, commits });
  const next = structuredClone(commits.slice(0, 1000));
  next[749]!.parents = ['replacement'];
  next[750]!.oid = 'replacement';
  const fresh = engine.handle({
    id: 2,
    generation: 'b',
    baseGeneration: 'a',
    method: 'refresh',
    offset: 0,
    commits: next,
  });
  if (fresh.kind !== 'layout') throw new Error('Expected layout');
  expect(fresh.offset).toBe(500);
  const page = engine.handle({
    id: 3,
    generation: 'b',
    method: 'append',
    offset: 1000,
    commits: commits.slice(1000),
  });
  if (page.kind !== 'layout') throw new Error('Expected layout');
  expect(page.rows).toEqual(allocateLanes([...next, ...commits.slice(1000)]).rows.slice(1000));
});
