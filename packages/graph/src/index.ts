export interface GraphCommit {
  oid: string;
  parents: string[];
  isStash?: boolean;
}
export interface Lane {
  target: string;
  color: number;
  dashed: boolean;
  pending?: boolean;
}
export interface GraphEdge {
  from: number;
  to: number;
  kind: 'pass' | 'start' | 'end' | 'merge-in' | 'branch-out';
  colorIndex: number;
  target: string;
  dashed: boolean;
}
export interface GraphPassage {
  start: number;
  end: number;
  column: number;
  colorIndex: number;
  target: string;
  dashed: boolean;
}
export interface GraphRow {
  oid: string;
  rowIndex: number;
  column: number;
  colorIndex: number;
  edges: GraphEdge[];
}
export interface Checkpoint {
  pinned?: true;
  lanes: (Lane | null)[];
  nextColor: number;
  nextRow: number;
  maxColumns: number;
}
export const emptyCheckpoint = (pinnedOid?: string): Checkpoint => ({
  ...(pinnedOid ? { pinned: true as const } : {}),
  lanes: pinnedOid ? [{ target: pinnedOid, color: 0, dashed: false, pending: true }] : [],
  nextColor: pinnedOid ? 1 : 0,
  nextRow: 0,
  maxColumns: pinnedOid ? 1 : 0,
});
/** Blueprint §4.2. Incoming edges occupy the upper half; parent edges the lower half. */
export function allocateLanes(
  commits: readonly GraphCommit[],
  previous = emptyCheckpoint(),
  compact = false,
) {
  const state: Checkpoint = {
    ...previous,
    lanes: previous.lanes.map((lane) => (lane ? { ...lane } : null)),
  };
  const rows: GraphRow[] = [],
    checkpoints: Checkpoint[] = [];
  const passes = new WeakMap<Lane, GraphEdge>();
  const passages: GraphPassage[] = [];
  const starts = new WeakMap<Lane, number>();
  if (compact)
    for (const lane of state.lanes) if (lane && !lane.pending) starts.set(lane, state.nextRow);
  const finishPassage = (lane: Lane, column: number) => {
    const start = starts.get(lane);
    if (start !== undefined && start < state.nextRow)
      passages.push({
        start,
        end: state.nextRow,
        column,
        colorIndex: lane.color,
        target: lane.target,
        dashed: lane.dashed,
      });
  };
  const targets = new Map<string, Set<number>>();
  let occupied = 0;
  state.lanes.forEach((lane, column) => {
    if (lane) {
      occupied++;
      const columns = targets.get(lane.target) ?? new Set<number>();
      columns.add(column);
      targets.set(lane.target, columns);
    }
  });
  const setLane = (column: number, lane: Lane | null) => {
    const old = state.lanes[column];
    if (old) {
      occupied--;
      const columns = targets.get(old.target)!;
      columns.delete(column);
      if (!columns.size) targets.delete(old.target);
    }
    state.lanes[column] = lane;
    if (lane) {
      occupied++;
      const columns = targets.get(lane.target) ?? new Set<number>();
      columns.add(column);
      targets.set(lane.target, columns);
    }
  };
  const leftmost = (target: string) => {
    let column = Infinity;
    for (const candidate of targets.get(target) ?? []) column = Math.min(column, candidate);
    return column === Infinity ? -1 : column;
  };
  const reserve = (target: string, preferred = 0, dashed = false) => {
    let column = state.lanes.length;
    if (occupied < column) {
      column = state.lanes.indexOf(null, preferred);
      if (column < 0) column = state.lanes.indexOf(null);
    }
    setLane(column, { target, color: state.nextColor++ % 10, dashed });
    return column;
  };
  for (const commit of commits) {
    let column = leftmost(commit.oid);
    const incoming = column >= 0 && !state.lanes[column]?.pending;
    if (column < 0) column = reserve(commit.oid, 0, commit.isStash);
    const colorIndex = state.lanes[column]!.color;
    const edges: GraphEdge[] = [];
    const visitLane = (lane: Lane | null, i: number) => {
      if (!lane || lane.pending) return;
      if (lane.target === commit.oid) {
        if (compact) finishPassage(lane, i);
        if (i !== column || incoming)
          edges.push({
            from: i,
            to: column,
            kind: 'end',
            colorIndex: lane.color,
            target: commit.oid,
            dashed: lane.dashed,
          });
        if (i !== column) setLane(i, null);
      } else if (!compact) {
        let pass = passes.get(lane);
        if (!pass) {
          pass = {
            from: i,
            to: i,
            kind: 'pass',
            colorIndex: lane.color,
            target: lane.target,
            dashed: lane.dashed,
          };
          passes.set(lane, pass);
        }
        edges.push(pass);
      }
    };
    if (compact)
      for (const i of [...(targets.get(commit.oid) ?? [])]) visitLane(state.lanes[i]!, i);
    else state.lanes.forEach(visitLane);
    setLane(column, null);
    const parents = [...new Set(commit.isStash ? commit.parents.slice(0, 1) : commit.parents)];
    if (state.pinned && column === 0 && !parents.length) delete state.pinned;
    parents.forEach((parent, i) => {
      let destination = leftmost(parent);
      // A pinned first parent stays in lane zero even when another lane awaits it.
      // That other lane converges at the parent, preserving its incoming edges.
      const existing = destination >= 0 && !(state.pinned && column === 0 && i === 0);
      if (!existing && i === 0) {
        destination = column;
        setLane(column, { target: parent, color: colorIndex, dashed: !!commit.isStash });
      } else if (!existing) destination = reserve(parent, column + 1, commit.isStash);
      const destinationLane = state.lanes[destination]!;
      if (compact && (!existing || destinationLane.pending))
        starts.set(destinationLane, state.nextRow + 1);
      delete destinationLane.pending;
      edges.push({
        from: column,
        to: destination,
        kind: existing ? 'merge-in' : i === 0 ? 'start' : 'branch-out',
        colorIndex: state.lanes[destination]!.color,
        target: parent,
        dashed: !!commit.isStash,
      });
    });
    state.maxColumns = Math.max(state.maxColumns, state.lanes.length, column + 1);
    while (state.lanes.length && state.lanes.at(-1) === null) state.lanes.pop();
    rows.push({ oid: commit.oid, rowIndex: state.nextRow++, column, colorIndex, edges });
    if (state.nextRow % 500 === 0) checkpoints.push(structuredClone(state));
  }
  if (compact)
    state.lanes.forEach((lane, column) => {
      if (lane && !lane.pending) finishPassage(lane, column);
    });
  return { rows, checkpoint: state, checkpoints, passages };
}

/** Clip old spans around the changed interval, preserving an unchanged prefix/suffix. */
export function patchPassages(
  previous: Iterable<GraphPassage>,
  offset: number,
  end: number,
  totalRows: number,
  replacement: readonly GraphPassage[],
): GraphPassage[] {
  const result: GraphPassage[] = [];
  for (const p of previous) {
    const before = Math.min(p.end, offset, totalRows);
    if (p.start < before) result.push(before === p.end ? p : { ...p, end: before });
    const after = Math.max(p.start, end),
      until = Math.min(p.end, totalRows);
    if (after < until)
      result.push(after === p.start && until === p.end ? p : { ...p, start: after, end: until });
  }
  return [...result, ...replacement];
}

/** Each viewport consults only the overlapping 500-row buckets, regardless of history length. */
export function passageBuckets(passages: readonly GraphPassage[], previous: GraphPassage[][] = []) {
  if (!passages.length) return previous;
  const buckets = previous.slice();
  for (const p of passages) {
    for (let i = Math.floor(p.start / 500); i <= Math.floor((p.end - 1) / 500); i++) {
      if (buckets[i] === previous[i]) buckets[i] = previous[i]?.slice() ?? [];
      buckets[i]!.push(p);
    }
  }
  return buckets;
}

/** A long passage belongs to several buckets. Clip it only once during a refresh. */
function* originalPassages(buckets: GraphPassage[][]) {
  for (let i = 0; i < buckets.length; i++)
    for (const p of buckets[i] ?? []) if (Math.floor(p.start / 500) === i) yield p;
}

export function refreshPassageBuckets(
  previous: GraphPassage[][],
  offset: number,
  end: number,
  totalRows: number,
  replacement: readonly GraphPassage[],
) {
  if (offset === 0 && end === totalRows) return passageBuckets(replacement);
  return passageBuckets(
    patchPassages(originalPassages(previous), offset, end, totalRows, replacement),
  );
}
