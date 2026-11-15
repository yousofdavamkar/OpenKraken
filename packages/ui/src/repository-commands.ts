import { useMemo } from 'react';
import fuzzysort from 'fuzzysort';
import { soloRefView } from './history-model.js';
import { useRepository } from './store.js';

export interface PaletteItem {
  key: string;
  label: string;
  description: string;
  available: boolean;
  execute: () => boolean;
}

export function diffButtonId(repoId: string, side: 'index' | 'worktree', pathBytes: string) {
  return `file-diff-${repoId}-${side}-${pathBytes}`;
}

type Target =
  | { kind: 'branch'; name: string; search: string }
  | { kind: 'file'; side: 'worktree' | 'index'; pathBytes: string; search: string };
const limit = 50;

export function useRepositoryCommands(category: string, query: string) {
  const repoId = useRepository((state) => state.snapshot?.repository.id);
  const refs = useRepository((state) =>
    category === 'Branches' ? state.snapshot?.refs : undefined,
  );
  const entries = useRepository((state) =>
    category === 'Changed files'
      ? (state.workingState?.status ?? state.snapshot?.status)?.entries
      : undefined,
  );
  const busy = useRepository((state) => !!state.busy);
  const candidates = useMemo(() => {
    const targets: Target[] = [];
    for (const ref of refs ?? []) {
      if ((ref.kind === 'local' || ref.kind === 'remote') && ref.objectType === 'commit')
        targets.push({ kind: 'branch', name: ref.name, search: ref.shortName });
    }
    for (const entry of entries ?? []) {
      if (entry.kind === 'untracked' || entry.worktree !== '.')
        targets.push({
          kind: 'file',
          side: 'worktree',
          pathBytes: entry.pathBytes,
          search: entry.path,
        });
      if (entry.kind !== 'untracked' && entry.index !== '.')
        targets.push({
          kind: 'file',
          side: 'index',
          pathBytes: entry.pathBytes,
          search: entry.path,
        });
    }
    return targets;
  }, [refs, entries]);
  const { targets, total } = useMemo(() => {
    const term = query.trim();
    if (!term) return { targets: candidates.slice(0, limit), total: candidates.length };
    const matches = fuzzysort.go(term, candidates, {
      key: (target) =>
        target.kind === 'branch' && term.startsWith('refs/') ? target.name : target.search,
      limit,
      threshold: 0.1,
    });
    return { targets: matches.map((match) => match.obj), total: matches.total };
  }, [candidates, query]);

  if (!repoId) return { items: [], total: 0, repoId };
  const items: PaletteItem[] = targets.map((target) => {
    if (target.kind === 'branch')
      return {
        key: target.name,
        label: `Show only ${target.search} in graph`,
        description: target.name,
        available: !busy,
        execute: () => {
          const { snapshot, busy, setView } = useRepository.getState();
          if (
            !snapshot ||
            snapshot.repository.id !== repoId ||
            busy ||
            !snapshot.refs.some((ref) => ref.name === target.name && ref.objectType === 'commit')
          )
            return false;
          document.getElementById('commit-history')?.focus();
          if (snapshot.view.soloRef !== target.name)
            void setView(soloRefView(snapshot.view, target.name));
          return true;
        },
      };
    const id = diffButtonId(repoId, target.side, target.pathBytes);
    return {
      key: id,
      label: `View ${target.side === 'index' ? 'staged' : 'unstaged'} ${target.search}`,
      description: 'Working tree changes',
      available: !busy,
      execute: () => {
        if (useRepository.getState().snapshot?.repository.id !== repoId) return false;
        const button = document.getElementById(id);
        if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
        button.focus();
        button.click();
        return true;
      },
    };
  });
  return { items, total, repoId };
}
