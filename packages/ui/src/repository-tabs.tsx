import { useEffect, useState } from 'react';
import type { RepositoryTab, RepositoryTabsState } from '@openkraken/ipc-contract';
import { useRepository } from './store.js';

const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const warnings: Record<NonNullable<RepositoryTabsState['warning']>, string> = {
  unreadable: 'Saved tabs could not be read. Tabs from this session will not be restored.',
  corrupt: 'Saved tabs were damaged and have been reset. A copy is kept in the profile.',
  unsaved: 'Tabs could not be saved. They may not be restored after a restart.',
};

/**
 * One tab per repository opened in this window. The main process records each opened
 * repository and lists the saved tabs again after a restart; selecting a tab reopens its
 * repository by id only, so the renderer never supplies a path.
 */
export function RepositoryTabs({ busy, openNew }: { busy: boolean; openNew: () => void }) {
  const { snapshot, run } = useRepository();
  const [tabs, setTabs] = useState<RepositoryTab[]>([]);
  const [warning, setWarning] = useState<RepositoryTabsState['warning']>(null);
  const active = snapshot?.repository.id;
  const activePath = snapshot?.repository.path;
  const select = (repoId: string) => {
    if (repoId === useRepository.getState().snapshot?.repository.id) return;
    if (useRepository.getState().busy) return;
    void run({ id: crypto.randomUUID(), method: 'reopenRepository', repoId });
  };
  useEffect(() => {
    let current = true;
    void window.openkraken
      .request({ id: crypto.randomUUID(), method: 'repositoryTabsRead' })
      .then((result) => {
        if (!current || result.kind !== 'repositoryTabs') return;
        const { state } = result;
        setWarning(state.warning);
        setTabs((opened) => [
          ...state.tabs,
          ...opened.filter((tab) => !state.tabs.some((saved) => saved.repoId === tab.repoId)),
        ]);
        // Saved tabs are listed but not opened: a click reopens one (ADR 0134).
      })
      .catch(() => {
        if (current) setWarning('unreadable');
      });
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    if (!active || !activePath) return;
    setTabs((current) =>
      current.some((tab) => tab.repoId === active)
        ? current
        : [...current, { repoId: active, name: nameOf(activePath), path: activePath }],
    );
  }, [active, activePath]);
  const close = async (repoId: string) => {
    const index = tabs.findIndex((tab) => tab.repoId === repoId);
    const remaining = tabs.filter((tab) => tab.repoId !== repoId);
    setTabs(remaining);
    if (repoId === active) {
      const next = remaining[Math.min(index, remaining.length - 1)];
      if (next) select(next.repoId);
    }
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'repositoryTabClose',
        repoId,
      });
      if (result.kind === 'repositoryTabs') setWarning(result.state.warning);
    } catch {
      setWarning('unsaved');
    }
  };
  return (
    <nav className="repo-tabs" aria-label="Repository tabs">
      {tabs.length === 0 && <span className="repo-tab active">New Tab</span>}
      {tabs.map((tab) => {
        const current = tab.repoId === active;
        return (
          <span key={tab.repoId} className={`repo-tab${current ? ' active' : ''}`} title={tab.path}>
            <button
              type="button"
              className="repo-tab-select"
              aria-current={current ? 'page' : undefined}
              aria-label={`Repository tab ${tab.name}`}
              disabled={busy && !current}
              onClick={() => select(tab.repoId)}
            >
              <span className="repo-tab-icon" aria-hidden="true" />
              {tab.name}
            </button>
            {(tabs.length > 1 || !current) && (
              <button
                type="button"
                className="repo-tab-close"
                aria-label={`Close tab ${tab.name}`}
                disabled={busy}
                onClick={() => void close(tab.repoId)}
              >
                ×
              </button>
            )}
          </span>
        );
      })}
      <button
        type="button"
        className="repo-tab-new"
        aria-label="New tab"
        title="Open another repository in a new tab"
        disabled={busy}
        onClick={openNew}
      >
        +
      </button>
      {warning && (
        <span className="repo-tabs-warning" role="status" title={warnings[warning]}>
          <span aria-hidden="true">!</span>
          <span className="sr-only">{warnings[warning]}</span>
        </span>
      )}
    </nav>
  );
}
