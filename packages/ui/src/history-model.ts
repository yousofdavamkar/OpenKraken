import type { Commit, Ref, Snapshot } from '@openkraken/ipc-contract';
export interface DisplayCommit extends Commit {
  kind: 'commit' | 'wip' | 'conflict';
}
export function projectCommits(
  commits: Commit[],
  snapshot: Snapshot,
  firstPage = false,
): DisplayCommit[] {
  const result: DisplayCommit[] = [];
  const dirty = snapshot.status.entries.length > 0;
  const conflict = snapshot.status.entries.some((e) => e.kind === 'conflict');
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
  for (const commit of commits) {
    if (dirty && commit.oid === snapshot.repository.head.oid) result.push(synthetic());
    result.push({ ...commit, kind: 'commit' });
  }
  return result;
}
export function refBadges(refs: Ref[]) {
  const groups = new Map<string, { label: string; names: string[]; kind: string }[]>();
  for (const ref of refs) {
    const oid = ref.peeled ?? ref.target;
    const label =
      ref.kind === 'remote' ? ref.shortName.split('/').slice(1).join('/') : ref.shortName;
    const kind = ref.kind === 'local' || ref.kind === 'remote' ? 'branch' : ref.kind;
    const badges = groups.get(oid) ?? [];
    const existing = badges.find((b) => b.label === label && b.kind === kind);
    if (existing) existing.names.push(ref.name);
    else badges.push({ label, kind, names: [ref.name] });
    groups.set(oid, badges);
  }
  return groups;
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
