import { expect, test } from 'vitest';
import { GraphEngine, type GraphDocument } from './src/engine.js';
import { allocateLanes, emptyCheckpoint, patchPassages, passageBuckets } from './src/index.js';
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

test('a horizontally scrolled canvas clips passages before styling and keeps crossing edges', () => {
  const rows = allocateLanes(documents(502), emptyCheckpoint(), true).rows;
  rows[499]!.edges = [
    { from: 0, to: 4, kind: 'branch-out', colorIndex: 0, dashed: false, target: '501' },
  ];
  rows[500]!.edges = [];
  const strokes: number[][] = [];
  const context = {
    canvas: { width: 0, height: 0 },
    setTransform() {},
    translate() {},
    clearRect() {},
    setLineDash() {},
    beginPath() {},
    moveTo(x: number, y: number) {
      strokes.push([x, y]);
    },
    lineTo(x: number, y: number) {
      strokes.at(-1)!.push(x, y);
    },
    bezierCurveTo(_a: number, _b: number, _c: number, _d: number, x: number, y: number) {
      strokes.at(-1)!.push(x, y);
    },
    stroke() {},
    fill() {},
    arc() {},
  } as unknown as CanvasRenderingContext2D;
  let offscreenStyles = 0;
  const passages = [4, 3, 0, 2, 1].map((column) => ({
    start: 499,
    end: column === 2 ? 500 : 501,
    column,
    target: '501',
    dashed: false,
    get colorIndex() {
      if (column === 0 || column === 4) offscreenStyles++;
      return column;
    },
  }));
  paintGraph(context, rows, {
    width: 36,
    height: 28,
    scrollTop: 499 * 28 + 7,
    scrollLeft: 36,
    dpr: 2,
    passages: passageBuckets(passages),
  });
  expect(strokes).toEqual([
    [34, -7, 34, 21],
    [54, -7, 54, 21],
    [74, -7, 74, 21],
    [14, 7, 94, 21],
    [34, 21, 34, 49],
    [74, 21, 74, 49],
  ]);
  expect(offscreenStyles).toBe(0);
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

test('wide histories share immutable pass-through edges across the worker transfer boundary', () => {
  const tips = Array.from({ length: 200 }, (_, i) => `side-${i}`);
  const commits = [
    { oid: 'merge', parents: ['0', ...tips] },
    ...Array.from({ length: 1000 }, (_, i) => ({ oid: String(i), parents: [String(i + 1)] })),
  ];
  const result = structuredClone(allocateLanes(commits));
  const unique = new Set(result.rows.flatMap((r) => r.edges));
  // Each pass is immutable for the lifetime of a lane, not a new object per row.
  expect(unique.size).toBeLessThan(3000);
  expect(result.rows[1]!.edges.find((e) => e.target === 'side-0' && e.kind === 'pass')).toBe(
    result.rows[999]!.edges.find((e) => e.target === 'side-0' && e.kind === 'pass'),
  );
});

test('compact worker spans preserve graph geometry across append and checkpoint refresh', () => {
  const engine = new GraphEngine(true),
    commits = documents(1800);
  commits[0]!.parents = ['1', '1200', '1500'];
  const initial = engine.handle({
    id: 1,
    generation: 'a',
    method: 'reset',
    offset: 0,
    commits: commits.slice(0, 1000),
  });
  if (initial.kind !== 'layout') throw new Error('Expected layout');
  const page = engine.handle({
    id: 2,
    generation: 'a',
    method: 'append',
    offset: 1000,
    commits: commits.slice(1000),
  });
  if (page.kind !== 'layout') throw new Error('Expected layout');
  const rows = [...initial.rows, ...page.rows],
    passages = [...initial.passages, ...page.passages];
  expect(rows.every((r) => r.edges.every((e) => e.kind !== 'pass'))).toBe(true);
  const next = structuredClone(commits);
  next[749]!.parents = ['replacement'];
  next[750]!.oid = 'replacement';
  const refreshed = engine.handle({
    id: 3,
    generation: 'b',
    baseGeneration: 'a',
    method: 'refresh',
    offset: 0,
    commits: next,
  });
  if (refreshed.kind !== 'layout') throw new Error('Expected layout');
  expect(refreshed.reusedTail).toBe(800);
  const patched = [
    ...rows.slice(0, refreshed.offset),
    ...refreshed.rows,
    ...rows.slice(next.length - refreshed.reusedTail),
  ];
  const spans = patchPassages(
    passages,
    refreshed.offset,
    refreshed.offset + refreshed.rows.length,
    next.length,
    refreshed.passages,
  );
  const buckets = passageBuckets(spans);
  const expanded = patched.map((row) => ({
    ...row,
    edges: [
      ...row.edges.filter((e) => e.kind === 'end'),
      ...(buckets[Math.floor(row.rowIndex / 500)] ?? [])
        .filter((p) => p.start <= row.rowIndex && p.end > row.rowIndex)
        .map((p) => ({
          from: p.column,
          to: p.column,
          kind: 'pass' as const,
          colorIndex: p.colorIndex,
          target: p.target,
          dashed: p.dashed,
        })),
    ]
      .sort((a, b) => a.from - b.from)
      .concat(row.edges.filter((e) => e.kind !== 'end')),
  }));
  expect(expanded).toEqual(allocateLanes(next).rows);
  expect(patchPassages(spans, 500, 750, 750, []).every((p) => p.end <= 500)).toBe(true);
});

test('search flushes any remaining cooperative indexing batches after a reset', () => {
  const engine = new GraphEngine(true),
    commits = documents(100);
  engine.handle({ id: 1, generation: 'a', method: 'reset', offset: 0, commits });
  expect(engine.indexPending(25)).toBe(true);
  expect(engine.handle({ id: 2, generation: 'a', method: 'search', query: '99' })).toMatchObject({
    oids: ['99'],
  });
  expect(engine.indexPending(25)).toBe(false);
  engine.handle({ id: 3, generation: 'b', method: 'reset', offset: 0, commits: [] });
  expect(engine.indexPending(25)).toBe(false);
  expect(engine.handle({ id: 4, generation: 'b', method: 'search', query: '99' })).toMatchObject({
    oids: [],
  });
});
