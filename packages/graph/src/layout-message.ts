import type { GraphResponse } from './engine.js';
import type { GraphEdge, GraphRow } from './index.js';

type Layout = Extract<GraphResponse, { kind: 'layout' }>;
type PackedLayout = Omit<Layout, 'rows' | 'kind'> & {
  kind: 'packed-layout';
  ids: string[];
  nodes: Uint32Array<ArrayBuffer>;
  edges: Uint32Array<ArrayBuffer>;
};
export type WorkerResponse = Exclude<GraphResponse, Layout> | PackedLayout;

const kinds = ['pass', 'start', 'end', 'merge-in', 'branch-out'] as const;
const nodeWidth = 4;
const edgeWidth = 6;

// Each node records its exclusive edge end. Row indices run consecutively from offset,
// including partial refresh replies that reuse a prefix or suffix in the renderer.
export function packLayout({ rows, ...layout }: Layout): PackedLayout {
  const nodes = new Uint32Array(rows.length * nodeWidth);
  const edges = new Uint32Array(rows.reduce((sum, row) => sum + row.edges.length, 0) * edgeWidth);
  const ids: string[] = [];
  const indices = new Map<string, number>();
  const indexForId = (id: string) => {
    let value = indices.get(id);
    if (value === undefined) {
      value = ids.length;
      ids.push(id);
      indices.set(id, value);
    }
    return value;
  };
  let nodeWord = 0,
    edgeWord = 0;
  for (const row of rows) {
    nodes[nodeWord++] = indexForId(row.oid);
    nodes[nodeWord++] = row.column;
    nodes[nodeWord++] = row.colorIndex;
    for (const edge of row.edges) {
      edges[edgeWord++] = edge.from;
      edges[edgeWord++] = edge.to;
      edges[edgeWord++] = kinds.indexOf(edge.kind);
      edges[edgeWord++] = edge.colorIndex;
      edges[edgeWord++] = indexForId(edge.target);
      edges[edgeWord++] = Number(edge.dashed);
    }
    nodes[nodeWord++] = edgeWord;
  }
  return { ...layout, kind: 'packed-layout', ids, nodes, edges };
}

export function unpackLayout({ nodes, edges, ids, ...layout }: PackedLayout): Layout {
  const rows: GraphRow[] = [];
  let edgeWord = 0;
  for (let nodeWord = 0; nodeWord < nodes.length; nodeWord += nodeWidth) {
    const rowEdges: GraphEdge[] = [];
    const end = nodes[nodeWord + 3]!;
    for (; edgeWord < end; edgeWord += edgeWidth) {
      rowEdges.push({
        from: edges[edgeWord]!,
        to: edges[edgeWord + 1]!,
        kind: kinds[edges[edgeWord + 2]!]!,
        colorIndex: edges[edgeWord + 3]!,
        target: ids[edges[edgeWord + 4]!]!,
        dashed: !!edges[edgeWord + 5],
      });
    }
    rows.push({
      oid: ids[nodes[nodeWord]!]!,
      rowIndex: layout.offset + rows.length,
      column: nodes[nodeWord + 1]!,
      colorIndex: nodes[nodeWord + 2]!,
      edges: rowEdges,
    });
  }
  return { ...layout, kind: 'layout', rows };
}
