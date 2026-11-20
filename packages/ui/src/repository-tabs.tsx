import { useEffect, useState } from 'react';
import { useRepository } from './store.js';

type Tab = { repoId: string; name: string; path: string };

const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * One tab per repository opened in this window. Switching reopens the repository
 * through the main process, which accepts only repositories it opened itself.
 */
export function RepositoryTabs({ busy, openNew }: { busy: boolean; openNew: () => void }) {
  const { snapshot, run } = useRepository();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const active = snapshot?.repository.id;
  const activePath = snapshot?.repository.path;
  useEffect(() => {
    if (!active || !activePath) return;
    setTabs((current) =>
      current.some((tab) => tab.repoId === active)
        ? current
        : [...current, { repoId: active, name: nameOf(activePath), path: activePath }],
    );
  }, [active, activePath]);
  const select = (repoId: string) => {
    if (repoId === active || busy) return;
    void run({ id: crypto.randomUUID(), method: 'reopenRepository', repoId });
  };
  const close = (repoId: string) => {
    const index = tabs.findIndex((tab) => tab.repoId === repoId);
    const remaining = tabs.filter((tab) => tab.repoId !== repoId);
    setTabs(remaining);
    if (repoId === active) {
      const next = remaining[Math.min(index, remaining.length - 1)];
      if (next) select(next.repoId);
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
                onClick={() => close(tab.repoId)}
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
    </nav>
  );
}
