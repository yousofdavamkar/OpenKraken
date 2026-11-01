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
export function allocateLanes(commits: readonly GraphCommit[], previous = emptyCheckpoint()) {
  const state: Checkpoint = {
    ...previous,
    lanes: previous.lanes.map((lane) => (lane ? { ...lane } : null)),
  };
  const rows: GraphRow[] = [],
    checkpoints: Checkpoint[] = [];
  const reserve = (target: string, preferred = 0, dashed = false) => {
    let column = state.lanes.findIndex((lane, i) => i >= preferred && !lane);
    if (column < 0) column = state.lanes.findIndex((lane) => !lane);
    if (column < 0) column = state.lanes.length;
    state.lanes[column] = { target, color: state.nextColor++ % 10, dashed };
    return column;
  };
  for (const commit of commits) {
    let column = state.lanes.findIndex((lane) => lane?.target === commit.oid);
    const incoming = column >= 0 && !state.lanes[column]?.pending;
    if (column < 0) column = reserve(commit.oid, 0, commit.isStash);
    const colorIndex = state.lanes[column]!.color;
    const edges: GraphEdge[] = [];
    state.lanes.forEach((lane, i) => {
      if (!lane || lane.pending) return;
      if (lane.target === commit.oid) {
        if (i !== column || incoming)
          edges.push({
            from: i,
            to: column,
            kind: 'end',
            colorIndex: lane.color,
            target: commit.oid,
            dashed: lane.dashed,
          });
        if (i !== column) state.lanes[i] = null;
      } else
        edges.push({
          from: i,
          to: i,
          kind: 'pass',
          colorIndex: lane.color,
          target: lane.target,
          dashed: lane.dashed,
        });
    });
    state.lanes[column] = null;
    const parents = [...new Set(commit.isStash ? commit.parents.slice(0, 1) : commit.parents)];
    if (state.pinned && column === 0 && !parents.length) delete state.pinned;
    parents.forEach((parent, i) => {
      let destination = state.lanes.findIndex((lane) => lane?.target === parent);
      // A pinned first parent stays in lane zero even when another lane awaits it.
      // That other lane converges at the parent, preserving its incoming edges.
      const existing = destination >= 0 && !(state.pinned && column === 0 && i === 0);
      if (!existing && i === 0) {
        destination = column;
        state.lanes[column] = { target: parent, color: colorIndex, dashed: !!commit.isStash };
      } else if (!existing) destination = reserve(parent, column + 1, commit.isStash);
      delete state.lanes[destination]!.pending;
      edges.push({
        from: column,
        to: destination,
        kind: existing ? 'merge-in' : i === 0 ? 'start' : 'branch-out',
        colorIndex: state.lanes[destination]!.color,
        target: parent,
        dashed: !!commit.isStash,
      });
    });
    state.maxColumns = Math.max(
      state.maxColumns,
      state.lanes.length,
      column + 1,
      ...edges.map((e) => Math.max(e.from, e.to) + 1),
    );
    while (state.lanes.length && state.lanes.at(-1) === null) state.lanes.pop();
    rows.push({ oid: commit.oid, rowIndex: state.nextRow++, column, colorIndex, edges });
    if (state.nextRow % 500 === 0) checkpoints.push(structuredClone(state));
  }
  return { rows, checkpoint: state, checkpoints };
}
