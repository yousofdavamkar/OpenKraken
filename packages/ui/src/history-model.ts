import {
  graphRefVisibility,
  type Commit,
  type GraphView,
  type Ref,
  type Snapshot,
} from '@openkraken/ipc-contract';
export function soloRefView(view: GraphView, name: string): GraphView {
  return {
    ...view,
    soloRef: name,
    hiddenRefs: view.hiddenRefs.filter((ref) => ref !== name),
    pinnedRef: view.pinnedRef === name ? name : undefined,
  };
}

export interface DisplayCommit extends Commit {
  kind: 'commit' | 'wip' | 'conflict' | 'worktree';
}
const hasConflict = (status: Snapshot['status']) =>
  status.entries.some((entry) => entry.kind === 'conflict');

export function sameWorkingPaths(before: Snapshot['status'], after: Snapshot['status']) {
  return (
    before.entries.length === after.entries.length &&
    before.entries.every((entry, index) => entry.path === after.entries[index]!.path)
  );
}
export function workingRowKind(status: Snapshot['status']) {
  return status.entries.length ? (hasConflict(status) ? 'conflict' : 'wip') : undefined;
}

export function workingRow(snapshot: Snapshot): DisplayCommit {
  const conflict = hasConflict(snapshot.status);
  return {
    oid: `${conflict ? 'conflict' : 'wip'}:${snapshot.repository.id}`,
    parents: snapshot.repository.head.oid ? [snapshot.repository.head.oid] : [],
    author: { name: 'Working tree', email: '', time: 0, tzOffsetMin: 0 },
    committer: { name: '', email: '', time: 0, tzOffsetMin: 0 },
    summary: conflict
      ? 'Resolve working-tree conflicts'
      : `${snapshot.status.entries.length} uncommitted changes`,
    body: snapshot.status.entries.map((e) => e.path).join('\n'),
    isStash: false,
    kind: conflict ? 'conflict' : 'wip',
  };
}

export function projectCommits(
  commits: Commit[],
  snapshot: Snapshot,
  firstPage = false,
): DisplayCommit[] {
  const result: DisplayCommit[] = [];
  const dirty = snapshot.status.entries.length > 0;
  const worktrees = new Map<string | undefined, DisplayCommit[]>();
  for (const entry of snapshot.worktrees?.entries ?? []) {
    if (entry.current || entry.bare) continue;
    if (
      snapshot.view.soloRef
        ? entry.branch !== snapshot.view.soloRef
        : entry.branch && snapshot.view.hiddenRefs.includes(entry.branch)
    )
      continue;
    const state =
      !entry.available || entry.changedFiles === null
        ? 'Status unavailable'
        : entry.changedFiles === 0
          ? 'Clean'
          : `${entry.changedFiles} uncommitted change${entry.changedFiles === 1 ? '' : 's'}`;
    const branch = entry.branch?.replace(/^refs\/heads\//, '') ?? 'Detached HEAD';
    const summary = `${state}${entry.locked ? ' · Locked' : ''} · ${branch} · ${entry.path}`;
    const row: DisplayCommit = {
      oid: `worktree:${entry.id}`,
      parents: entry.head ? [entry.head] : [],
      author: { name: 'Worktree', email: '', time: 0, tzOffsetMin: 0 },
      committer: { name: '', email: '', time: 0, tzOffsetMin: 0 },
      summary,
      body: [summary, entry.head, entry.lockReason, entry.pruneReason, entry.problem]
        .filter(Boolean)
        .join('\n'),
      isStash: false,
      kind: 'worktree',
    };
    worktrees.set(entry.head, [...(worktrees.get(entry.head) ?? []), row]);
  }
  if (firstPage && !snapshot.repository.head.oid && dirty) result.push(workingRow(snapshot));
  if (firstPage) result.push(...(worktrees.get(undefined) ?? []));
  for (const commit of commits) {
    if (dirty && commit.oid === snapshot.repository.head.oid) result.push(workingRow(snapshot));
    result.push(...(worktrees.get(commit.oid) ?? []));
    result.push({ ...commit, kind: 'commit' });
  }
  return result;
}
export function refsByTarget(refs: readonly Ref[], view: GraphView = { hiddenRefs: [] }) {
  const isVisible = graphRefVisibility(view);
  const targets = new Map<string, Ref | Ref[]>();
  for (const ref of refs) {
    if (!isVisible(ref.name)) continue;
    const oid = ref.peeled ?? ref.target;
    const bucket = targets.get(oid);
    if (!bucket) targets.set(oid, ref);
    else if (Array.isArray(bucket)) bucket.push(ref);
    else targets.set(oid, [bucket, ref]);
  }
  return {
    size: targets.size,
    get(oid: string) {
      const bucket = targets.get(oid);
      if (!bucket || Array.isArray(bucket)) return bucket;
      // Allocate a stable badge list only when this single target is displayed.
      const list = [bucket];
      targets.set(oid, list);
      return list;
    },
  };
}

interface RefBadge {
  label: string;
  kind: string;
  names: string[];
  nameCount: number;
}

// Keep counting names on the displayed badges after the preview fills.
export function groupRefBadges(refs: readonly Ref[], limit = Infinity) {
  const badges: RefBadge[] = [];
  const byKind = new Map<string, Map<string, RefBadge>>();
  let overflow = false;
  for (const ref of refs) {
    const kind = ref.kind === 'local' || ref.kind === 'remote' ? 'branch' : ref.kind;
    let labels = byKind.get(kind);
    if (!labels) {
      if (badges.length >= limit) {
        overflow = true;
        continue;
      }
      labels = new Map();
      byKind.set(kind, labels);
    }
    let label = ref.shortName;
    if (ref.kind === 'remote') {
      const separator = label.indexOf('/');
      label = separator < 0 ? '' : label.slice(separator + 1);
    }
    const badge = labels.get(label);
    if (badge) {
      badge.nameCount++;
      if (badge.names.length < limit) badge.names.push(ref.name);
      else overflow = true;
    } else if (badges.length < limit) {
      const added = { label, kind, names: [ref.name], nameCount: 1 };
      labels.set(label, added);
      badges.push(added);
    } else {
      overflow = true;
    }
  }
  return { badges, overflow };
}
export interface Selection {
  focus?: string;
  focusIndex?: number;
  anchor?: string;
  anchorIndex?: number;
  selected: string[];
}
// Positions survive appends. A refresh or a working-tree row can move the OID.
export function locateRow(rows: readonly { oid: string }[], oid?: string, hint?: number) {
  if (oid === undefined) return -1;
  if (hint !== undefined && rows[hint]?.oid === oid) return hint;
  return rows.findIndex((row) => row.oid === oid);
}

export function selectRow(
  rows: readonly { oid: string }[],
  selection: Selection,
  oid: string,
  mode: 'single' | 'toggle' | 'range' = 'single',
  position?: number,
): Selection {
  const index = locateRow(rows, oid, position);
  if (index < 0) return selection;
  if (mode === 'range') {
    const anchor = Math.max(
      0,
      locateRow(
        rows,
        selection.anchor ?? selection.focus ?? oid,
        selection.anchorIndex ?? selection.focusIndex ?? index,
      ),
    );
    return {
      focus: oid,
      focusIndex: index,
      anchor: rows[anchor]!.oid,
      anchorIndex: anchor,
      selected: rows.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).map((r) => r.oid),
    };
  }
  if (mode === 'toggle')
    return {
      focus: oid,
      focusIndex: index,
      anchor: oid,
      anchorIndex: index,
      selected: selection.selected.includes(oid)
        ? selection.selected.filter((id) => id !== oid)
        : [...selection.selected, oid],
    };
  return singleSelection(oid, index);
}

export function singleSelection(oid: string, index: number): Selection {
  return { focus: oid, focusIndex: index, anchor: oid, anchorIndex: index, selected: [oid] };
}
// Loaded positions stay numeric. A parent or ref tip can require another page.
export function navigationTarget(
  rows: readonly DisplayCommit[],
  focused: number,
  key: string,
  shift: boolean,
  head?: string,
  upstream?: string,
): number | string | undefined {
  if (!rows.length) return;
  if (key.toLowerCase() === 'h') return shift ? upstream : head;
  if (key === 'Home') return 0;
  if (key === 'End') return rows.length - 1;
  const index = Math.max(0, focused);
  if (shift && key === 'ArrowDown') return rows[index]!.parents[0];
  if (shift && key === 'ArrowUp') {
    const parent = rows[index]!.oid;
    for (let i = index - 1; i >= 0; i--) if (rows[i]!.parents.includes(parent)) return i;
    return;
  }
  const delta =
    key === 'ArrowDown'
      ? 1
      : key === 'ArrowUp'
        ? -1
        : key === 'PageDown'
          ? 20
          : key === 'PageUp'
            ? -20
            : 0;
  return delta ? Math.max(0, Math.min(rows.length - 1, index + delta)) : undefined;
}

/** Excluded ref shortcuts must not page through an unrelated history looking for a missing tip. */
export function refNavigationTargets(snapshot: Snapshot, rows: readonly { oid: string }[]) {
  const view = snapshot.view,
    head = snapshot.repository.head;
  const visible = (name: string) =>
    view.soloRef ? name === view.soloRef : !view.hiddenRefs.includes(name);
  const headRef =
    head.kind === 'branch' ? snapshot.refs.find((r) => r.name === head.ref) : undefined;
  const upstreamRef = headRef?.upstream?.ref;
  const upstream = upstreamRef ? snapshot.refs.find((r) => r.name === upstreamRef) : undefined;
  let upstreamCommit: string | undefined;
  if (upstream?.objectType === 'commit') upstreamCommit = upstream.target;
  else if (upstream?.peeledType === 'commit') upstreamCommit = upstream.peeled;
  const loaded = (oid?: string) => !!oid && rows.some((r) => r.oid === oid);
  return {
    head:
      (head.kind === 'branch' ? visible(head.ref) : !view.soloRef) || loaded(head.oid)
        ? head.oid
        : undefined,
    upstream:
      upstream && (visible(upstream.name) || loaded(upstreamCommit)) ? upstreamCommit : undefined,
  };
}
