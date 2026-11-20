import type { GraphRow, GraphPassage } from './index.js';
export const ROW_HEIGHT = 28;
export const LANE_WIDTH = 20;
export const GRAPH_PADDING = 14;
export const palette = [
  '#79dfc3',
  '#b2a2f7',
  '#e9b96a',
  '#74bef5',
  '#eb91b5',
  '#a9d778',
  '#f4a27a',
  '#84d9e3',
  '#c7b2a5',
  '#d5d981',
];
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  dashed: boolean;
}
export function rowSegments(
  row: GraphRow,
  top: number,
  colors: readonly string[] = palette,
): Segment[] {
  return row.edges.map((edge) => ({
    x1: GRAPH_PADDING + edge.from * LANE_WIDTH,
    x2: GRAPH_PADDING + edge.to * LANE_WIDTH,
    y1:
      top +
      (edge.kind === 'start' || edge.kind === 'merge-in' || edge.kind === 'branch-out'
        ? ROW_HEIGHT / 2
        : 0),
    y2: top + (edge.kind === 'end' ? ROW_HEIGHT / 2 : ROW_HEIGHT),
    color: colors[edge.colorIndex % colors.length]!,
    dashed: edge.dashed,
  }));
}
/** Viewport-sized backing store; row coordinates use the same scroll offset as DOM cells. */
export function paintGraph(
  ctx: CanvasRenderingContext2D,
  rows: readonly GraphRow[],
  options: {
    width: number;
    height: number;
    scrollTop: number;
    scrollLeft?: number;
    dpr: number;
    matches?: ReadonlySet<string>;
    selected?: ReadonlySet<string>;
    synthetic?: ReadonlySet<string>;
    passages?: readonly (readonly GraphPassage[])[];
    colors?: readonly string[];
    background?: string;
  },
) {
  const { width, height, scrollTop, dpr } = options;
  const colors = options.colors?.length ? options.colors : palette;
  const pixelWidth = Math.ceil(width * dpr),
    pixelHeight = Math.ceil(height * dpr);
  if (ctx.canvas.width !== pixelWidth) ctx.canvas.width = pixelWidth;
  if (ctx.canvas.height !== pixelHeight) ctx.canvas.height = pixelHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const left = options.scrollLeft ?? 0;
  const clipLeft = left - 2;
  const clipRight = left + width + 2;
  ctx.translate(-left, 0);
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT));
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT));
  let bucket = -1;
  let visiblePassages: GraphPassage[] = [];
  for (let i = first; i < end; i++) {
    const row = rows[i]!;
    const y = row.rowIndex * ROW_HEIGHT - scrollTop;
    ctx.globalAlpha = options.matches && !options.matches.has(row.oid) ? 0.22 : 1;
    const segments = rowSegments(row, y, colors);
    const split = row.edges.findIndex((e) => !['end', 'pass'].includes(e.kind));
    const outgoing = segments.splice(split < 0 ? segments.length : split);
    const rowBucket = Math.floor(i / 500);
    if (rowBucket !== bucket) {
      bucket = rowBucket;
      visiblePassages =
        options.passages?.[bucket]?.filter((p) => {
          const x = GRAPH_PADDING + p.column * LANE_WIDTH;
          return x >= clipLeft && x <= clipRight && p.start < end && p.end > first;
        }) ?? [];
    }
    for (const p of visiblePassages) {
      if (p.start <= i && p.end > i)
        segments.push({
          x1: GRAPH_PADDING + p.column * LANE_WIDTH,
          x2: GRAPH_PADDING + p.column * LANE_WIDTH,
          y1: y,
          y2: y + ROW_HEIGHT,
          color: colors[p.colorIndex % colors.length]!,
          dashed: p.dashed,
        });
    }
    segments.sort((a, b) => a.x1 - b.x1);
    segments.push(...outgoing);
    for (const segment of segments) {
      if (
        Math.max(segment.x1, segment.x2) < clipLeft ||
        Math.min(segment.x1, segment.x2) > clipRight
      )
        continue;
      ctx.strokeStyle = segment.color;
      ctx.setLineDash(segment.dashed ? [3, 3] : []);
      ctx.beginPath();
      ctx.moveTo(segment.x1, segment.y1);
      if (segment.x1 === segment.x2) ctx.lineTo(segment.x2, segment.y2);
      else {
        const mid = (segment.y1 + segment.y2) / 2;
        ctx.bezierCurveTo(segment.x1, mid, segment.x2, mid, segment.x2, segment.y2);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(
      GRAPH_PADDING + row.column * LANE_WIDTH,
      y + ROW_HEIGHT / 2,
      options.selected?.has(row.oid) ? 5 : 3.5,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = options.synthetic?.has(row.oid)
      ? (options.background ?? '#10151e')
      : colors[row.colorIndex % colors.length]!;
    ctx.strokeStyle = colors[row.colorIndex % colors.length]!;
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
