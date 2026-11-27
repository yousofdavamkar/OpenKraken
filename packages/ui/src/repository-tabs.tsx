import { useEffect, useState } from 'react';
import type { RepositoryTab, RepositoryTabsState } from '@openkraken/ipc-contract';
import { CommandButton } from './commands.js';
import { useRepository } from './store.js';

const maxClosed = 16;
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
  // Tabs closed in this session, most recent last, for Reopen closed tab.
  const [closed, setClosed] = useState<RepositoryTab[]>([]);
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
    if (!active) return;
    document
      .querySelector(`.repo-tab-select[aria-current="page"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs]);
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
    if (index < 0) return;
    const remaining = tabs.filter((tab) => tab.repoId !== repoId);
    setTabs(remaining);
    setClosed((current) =>
      [...current.filter((tab) => tab.repoId !== repoId), tabs[index]!].slice(-maxClosed),
    );
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
  const activeIndex = tabs.findIndex((tab) => tab.repoId === active);
  const cycle = (step: number) => {
    if (tabs.length < 2) return;
    const from = activeIndex < 0 ? (step > 0 ? -1 : 0) : activeIndex;
    select(tabs[(from + step + tabs.length) % tabs.length]!.repoId);
  };
  const reopen = () => {
    const tab = closed.at(-1);
    if (!tab) return;
    setClosed(closed.slice(0, -1));
    setTabs((current) =>
      current.some((item) => item.repoId === tab.repoId) ? current : [...current, tab],
    );
    select(tab.repoId);
  };
  return (
    <nav className="repo-tabs" aria-label="Repository tabs">
      {/* Keyboard and palette targets for the tab commands; they are not tab stops. */}
      <span hidden>
        <CommandButton
          command="tabs.close"
          tabIndex={-1}
          disabled={busy || activeIndex < 0 || tabs.length < 2}
          onClick={() => active && void close(active)}
        >
          Close tab
        </CommandButton>
        <CommandButton
          command="tabs.next"
          tabIndex={-1}
          disabled={busy || tabs.length < 2}
          onClick={() => cycle(1)}
        >
          Next tab
        </CommandButton>
        <CommandButton
          command="tabs.previous"
          tabIndex={-1}
          disabled={busy || tabs.length < 2}
          onClick={() => cycle(-1)}
        >
          Previous tab
        </CommandButton>
        <CommandButton
          command="tabs.reopen"
          tabIndex={-1}
          disabled={busy || closed.length === 0}
          onClick={reopen}
        >
          Reopen closed tab
        </CommandButton>
      </span>
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
      <CommandButton
        command="tabs.new"
        type="button"
        className="repo-tab-new"
        aria-label="New tab"
        disabled={busy}
        onClick={openNew}
      >
        +
      </CommandButton>
      {warning && (
        <span className="repo-tabs-warning" role="status" title={warnings[warning]}>
          <span aria-hidden="true">!</span>
          <span className="sr-only">{warnings[warning]}</span>
        </span>
      )}
    </nav>
  );
}
