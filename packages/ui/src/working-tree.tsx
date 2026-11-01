import { useEffect, useState } from 'react';
import type { Request, WorkingState } from '@openkraken/ipc-contract';
import { useRepository } from './store.js';
export function WorkingTreePanel() {
  const { snapshot, busy } = useRepository();
  const [state, setState] = useState<WorkingState>();
  const [error, setError] = useState<string>();
  const repoId = snapshot?.repository.id,
    cursor = snapshot?.cursor;
  useEffect(() => {
    let live = true;
    if (repoId)
      void window.openkraken
        .request({ id: crypto.randomUUID(), method: 'workingState', repoId })
        .then((result) => {
          if (!live) return;
          if (result.kind === 'workingState') setState(result.state);
          if (result.kind === 'error') setError(result.message);
        })
        .catch((e: unknown) => {
          if (live) setError(String(e));
        });
    return () => {
      live = false;
    };
  }, [repoId, cursor]);
  if (!snapshot || !repoId) return null;
  const mutate = async (request: Request) => {
    if (useRepository.getState().busy) return;
    useRepository.setState({ busy: request.id });
    setError(undefined);
    try {
      const result = await window.openkraken.request(request);
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'workingState') setState(result.state);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      useRepository.setState({ busy: undefined });
      if (useRepository.getState().snapshot?.repository.id === repoId)
        await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
    }
  };
  const status = state?.status ?? snapshot.status;
  const staged = status.entries.filter((e) => e.kind !== 'untracked' && e.index !== '.');
  const unstaged = status.entries.filter((e) => e.kind === 'untracked' || e.worktree !== '.');
  const files = (action: 'stage' | 'unstage', paths: string[]) =>
    void mutate({ id: crypto.randomUUID(), method: 'files', repoId, action, paths });
  return (
    <section aria-label="Working tree">
      <h2>
        Working tree <span>{status.entries.length}</span>
      </h2>
      {snapshot.repository.isBare ? (
        <p className="muted">Bare repository</p>
      ) : (
        <>
          <div className="working-actions">
            <button
              disabled={!!busy || !state?.undo}
              title={state?.undo?.label}
              onClick={() => void mutate({ id: crypto.randomUUID(), method: 'undo', repoId })}
            >
              Undo
            </button>
            <button
              disabled={!!busy || !state?.redo}
              title={state?.redo?.label}
              onClick={() =>
                void mutate({ id: crypto.randomUUID(), method: 'undo', repoId, redo: true })
              }
            >
              Redo
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {(
            [
              ['Unstaged', unstaged, 'stage'],
              ['Staged', staged, 'unstage'],
            ] as const
          ).map(([title, entries, action]) => (
            <section key={title} aria-label={title}>
              <div className="working-heading">
                <h3>
                  {title} ({entries.length})
                </h3>
                <button
                  disabled={!!busy || !entries.length}
                  onClick={() =>
                    files(
                      action,
                      entries.map((e) => e.pathBytes),
                    )
                  }
                >
                  {action === 'stage' ? 'Stage all' : 'Unstage all'}
                </button>
              </div>
              {entries.map((entry) => (
                <div className="working-file" key={entry.pathBytes}>
                  <div className="status-entry">
                    <code className={entry.kind === 'conflict' ? 'conflict' : ''}>
                      {entry.index}
                      {entry.worktree}
                    </code>
                    <span title={entry.path}>
                      {entry.path}
                      {entry.origPath && <small>from {entry.origPath}</small>}
                    </span>
                  </div>
                  <button
                    disabled={!!busy}
                    aria-label={`${action === 'stage' ? 'Stage' : 'Unstage'} ${entry.path}`}
                    onClick={() => files(action, [entry.pathBytes])}
                  >
                    {action === 'stage' ? 'Stage' : 'Unstage'}
                  </button>
                </div>
              ))}
            </section>
          ))}
          {!status.entries.length && (
            <div className="clean">
              <span>✓</span>
              <p>Working tree clean</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
