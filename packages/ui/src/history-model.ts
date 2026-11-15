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

export function sameWorkingRow(before: Snapshot['status'], after: Snapshot['status']) {
  return (
    before.entries.length === after.entries.length &&
    before.entries.every((entry, index) => entry.path === after.entries[index]!.path) &&
    hasConflict(before) === hasConflict(after)
  );
}
export function projectCommits(
  commits: Commit[],
  snapshot: Snapshot,
  firstPage = false,
): DisplayCommit[] {
  const result: DisplayCommit[] = [];
  const dirty = snapshot.status.entries.length > 0;
  const conflict = hasConflict(snapshot.status);
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
  const synthetic = (): DisplayCommit => ({
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
  });
  if (firstPage && !snapshot.repository.head.oid && dirty) result.push(synthetic());
  if (firstPage) result.push(...(worktrees.get(undefined) ?? []));
  for (const commit of commits) {
    if (dirty && commit.oid === snapshot.repository.head.oid) result.push(synthetic());
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
  anchor?: string;
  selected: string[];
}
export function selectRow(
  rows: readonly { oid: string }[],
  selection: Selection,
  oid: string,
  mode: 'single' | 'toggle' | 'range' = 'single',
): Selection {
  const index = rows.findIndex((r) => r.oid === oid);
  if (index < 0) return selection;
  if (mode === 'range') {
    const anchor = Math.max(
      0,
      rows.findIndex((r) => r.oid === (selection.anchor ?? selection.focus ?? oid)),
    );
    return {
      focus: oid,
      anchor: rows[anchor]!.oid,
      selected: rows.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).map((r) => r.oid),
    };
  }
  if (mode === 'toggle')
    return {
      focus: oid,
      anchor: oid,
      selected: selection.selected.includes(oid)
        ? selection.selected.filter((id) => id !== oid)
        : [...selection.selected, oid],
    };
  return { focus: oid, anchor: oid, selected: [oid] };
}
export function navigationTarget(
  rows: readonly DisplayCommit[],
  focus: string | undefined,
  key: string,
  shift: boolean,
  head?: string,
  upstream?: string,
): string | undefined {
  if (!rows.length) return;
  const index = Math.max(
    0,
    rows.findIndex((r) => r.oid === focus),
  );
  if (key.toLowerCase() === 'h') return shift ? upstream : head;
  if (key === 'Home') return rows[0]!.oid;
  if (key === 'End') return rows.at(-1)!.oid;
  if (shift && key === 'ArrowDown') return rows[index]!.parents[0];
  if (shift && key === 'ArrowUp')
    return rows.slice(0, index).findLast((r) => r.parents.includes(rows[index]!.oid))?.oid;
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
  return delta ? rows[Math.max(0, Math.min(rows.length - 1, index + delta))]!.oid : undefined;
}

/** Excluded ref shortcuts must not page through an unrelated history looking for a missing tip. */
export function refNavigationTargets(snapshot: Snapshot, rows: readonly { oid: string }[]) {
  const view = snapshot.view,
    head = snapshot.repository.head;
  const visible = (name: string) =>
    view.soloRef ? name === view.soloRef : !view.hiddenRefs.includes(name);
  const headRef =
    head.kind === 'branch' ? snapshot.refs.find((r) => r.name === head.ref) : undefined;
  const upstream = snapshot.refs.find((r) => r.name === headRef?.upstream?.ref);
  const loaded = (oid?: string) => !!oid && rows.some((r) => r.oid === oid);
  return {
    head:
      loaded(head.oid) || (head.kind === 'branch' ? visible(head.ref) : !view.soloRef)
        ? head.oid
        : undefined,
    upstream:
      upstream && (visible(upstream.name) || loaded(upstream.target)) ? upstream.target : undefined,
  };
}
