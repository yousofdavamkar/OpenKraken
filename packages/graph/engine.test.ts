import { expect, test } from 'vitest';
import { GraphEngine, type GraphDocument } from './src/engine.js';
import { allocateLanes } from './src/index.js';
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
