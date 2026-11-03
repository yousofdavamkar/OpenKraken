import { useEffect, useState } from 'react';
import type { RepositoryEvent } from '@openkraken/ipc-contract';
import { AutomaticFetch } from './automatic-fetch.js';
import { useRepository } from './store.js';
const setting = 'openkraken.refreshOnFocus';
function loadFocus() {
  try {
    return localStorage.getItem(setting) !== 'false';
  } catch {
    return true;
  }
}
export function RepositorySync() {
  const { snapshot, watcherMode } = useRepository();
  const [focusRefresh, setFocusRefresh] = useState(loadFocus);
  const repoId = snapshot?.repository.id;
  useEffect(() => {
    if (!repoId) return;
    let stopped = false,
      running = false;
    const domains = new Set<RepositoryEvent['domains'][number]>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!timer && !stopped)
        timer = setTimeout(() => {
          timer = undefined;
          void flush();
        }, 50);
    };
    const flush = async () => {
      if (stopped || running || !domains.size) return;
      const state = useRepository.getState();
      if (state.snapshot?.repository.id !== repoId) return;
      if (state.busy || state.paging) {
        schedule();
        return;
      }
      const full = [...domains].some(
        (domain) => domain !== 'status' && domain !== 'worktreeStatus',
      );
      const updateWorktrees = domains.has('worktreeStatus');
      domains.clear();
      running = true;
      try {
        if (full) await state.run({ id: crypto.randomUUID(), method: 'refresh', repoId }, true);
        else await state.refreshStatus(true, updateWorktrees);
      } finally {
        running = false;
        if (domains.size) schedule();
      }
    };
    const unsubscribe = window.openkraken.subscribe((event) => {
      if (event.type !== 'repositoryChanged' || event.repoId !== repoId) return;
      useRepository.setState({ watcherMode: event.mode });
      for (const domain of event.domains) domains.add(domain);
      schedule();
    });
    const focus = () => {
      if (!focusRefresh || document.querySelector('dialog[open]')) return;
      domains.add('refs');
      schedule();
    };
    window.addEventListener('focus', focus);
    return () => {
      stopped = true;
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('focus', focus);
    };
  }, [repoId, focusRefresh]);
  if (!snapshot) return null;
  return (
    <div className="repository-sync">
      <span
        role="status"
        title={
          watcherMode === 'polling'
            ? 'Native file watching is unavailable. Checking for changes every 750 ms.'
            : 'Watching repository files for changes.'
        }
      >
        {watcherMode === 'polling'
          ? 'Polling for changes'
          : watcherMode === 'native'
            ? 'Watching for changes'
            : 'Starting file watcher…'}
      </span>
      <AutomaticFetch key={snapshot.repository.id} repoId={snapshot.repository.id} />
      <label>
        <input
          type="checkbox"
          checked={focusRefresh}
          onChange={(event) => {
            setFocusRefresh(event.target.checked);
            try {
              localStorage.setItem(setting, String(event.target.checked));
            } catch {
              /* Session preference still applies. */
            }
          }}
        />{' '}
        Refresh on focus
      </label>
    </div>
  );
}
