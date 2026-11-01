import React, { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Commit } from '@openkraken/ipc-contract';
import { useRepository } from './store.js';
import './style.css';
const dateFormatter = new Intl.DateTimeFormat();
function History({ commits }: { commits: Commit[] }) {
  const viewport = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: commits.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => 28,
    overscan: 10,
  });
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        performance.mark('repository-painted');
        if (performance.getEntriesByName('repository-open-start').length)
          performance.measure(
            'repository-first-paint',
            'repository-open-start',
            'repository-painted',
          );
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [commits]);
  return (
    <div
      className="history-scroll"
      ref={viewport}
      role="table"
      aria-label="Commit history"
      aria-rowcount={commits.length}
    >
      <div className="history-space" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map((item) => {
          const commit = commits[item.index]!;
          return (
            <div
              className="commit-row"
              key={commit.oid}
              role="row"
              aria-rowindex={item.index + 1}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <code role="cell">{commit.oid.slice(0, 8)}</code>
              <span role="cell" className="commit-subject" title={commit.body}>
                {commit.isStash && <b className="badge">stash</b>}
                {commit.parents.length > 1 && <b className="badge">merge</b>}
                {commit.summary || '(empty message)'}
              </span>
              <span role="cell" className="author">
                {commit.author.name}
              </span>
              <time role="cell">{dateFormatter.format(commit.author.time * 1000)}</time>
            </div>
          );
        })}
      </div>
      {!commits.length && (
        <p className="empty">No commits yet. This repository is ready for its first commit.</p>
      )}
    </div>
  );
}
function App() {
  const { snapshot, busy, error, run, cancel } = useRepository();
  const [init, setInit] = useState(false);
  const [branch, setBranch] = useState('main');
  const open = () => void run({ id: crypto.randomUUID(), method: 'open' });
  const head = snapshot?.repository.head;
  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">
            ◈
          </span>{' '}
          OpenKraken <span className="edition">LOCAL GIT CLIENT</span>
        </div>
        <div className="toolbar">
          <button onClick={open} disabled={!!busy}>
            Open repository
          </button>
          <button onClick={() => setInit(!init)} disabled={!!busy}>
            Initialize
          </button>
          {snapshot && (
            <button
              onClick={() =>
                void run({
                  id: crypto.randomUUID(),
                  method: 'refresh',
                  repoId: snapshot.repository.id,
                })
              }
              disabled={!!busy}
            >
              Refresh
            </button>
          )}
          {busy && <button onClick={() => void cancel()}>Cancel</button>}
        </div>
      </header>
      {init && (
        <form
          className="init-form"
          onSubmit={(event) => {
            event.preventDefault();
            setInit(false);
            void run({ id: crypto.randomUUID(), method: 'init', branch });
          }}
        >
          <label>
            Initial branch{' '}
            <input
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              required
              maxLength={200}
            />
          </label>
          <button disabled={!!busy}>Choose folder and initialize</button>
        </form>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {snapshot ? (
        <>
          <div className="repo-heading">
            <div>
              <h1>{snapshot.repository.path.split(/[\\/]/).filter(Boolean).at(-1)}</h1>
              <p title={snapshot.repository.path}>{snapshot.repository.path}</p>
            </div>
            <span className="head" data-testid="head">
              {head?.kind === 'branch'
                ? head.ref.replace('refs/heads/', '')
                : `Detached · ${head?.oid.slice(0, 8)}`}
              {!head?.oid && ' · unborn'}
            </span>
          </div>
          <main>
            <aside className="refs">
              <h2>
                References <span>{snapshot.refs.length}</span>
              </h2>
              {(['local', 'remote', 'tag', 'stash', 'other'] as const).map((kind) => {
                const refs = snapshot.refs.filter((r) => r.kind === kind);
                return refs.length ? (
                  <section key={kind}>
                    <h3>
                      {
                        {
                          local: 'Branches',
                          remote: 'Remotes',
                          tag: 'Tags',
                          stash: 'Stashes',
                          other: 'Other refs',
                        }[kind]
                      }
                    </h3>
                    {refs.map((ref) => (
                      <div
                        className={`ref ${ref.isHead ? 'current' : ''}`}
                        key={ref.name}
                        title={`${ref.name}\n${ref.target}`}
                      >
                        <span>
                          {ref.isHead ? '● ' : ''}
                          {ref.shortName}
                        </span>
                        {ref.upstream && (
                          <small>
                            {ref.upstream.gone
                              ? 'gone'
                              : `↑${ref.upstream.ahead} ↓${ref.upstream.behind}`}
                          </small>
                        )}
                      </div>
                    ))}
                  </section>
                ) : null;
              })}
            </aside>
            <section className="history">
              <div className="panel-title">
                <h2>History</h2>
                <span data-testid="commit-count">
                  {snapshot.commits.length.toLocaleString()} commits
                  {snapshot.hasMore ? ' · first page' : ''}
                </span>
              </div>
              <div className="column-head">
                <span>COMMIT</span>
                <span>MESSAGE</span>
                <span>AUTHOR</span>
                <span>DATE</span>
              </div>
              <History commits={snapshot.commits} />
            </section>
            <aside className="status">
              <h2>
                Working tree <span>{snapshot.status.entries.length}</span>
              </h2>
              {snapshot.repository.isBare ? (
                <p className="muted">Bare repository</p>
              ) : snapshot.status.entries.length ? (
                snapshot.status.entries.map((entry) => (
                  <div className="status-entry" key={entry.pathBytes}>
                    <code className={entry.kind === 'conflict' ? 'conflict' : ''}>
                      {entry.index}
                      {entry.worktree}
                    </code>
                    <span title={entry.path}>
                      {entry.path}
                      {entry.origPath && <small>from {entry.origPath}</small>}
                    </span>
                  </div>
                ))
              ) : (
                <div className="clean">
                  <span>✓</span>
                  <p>Working tree clean</p>
                </div>
              )}
              <p className="status-key">Left: index · Right: working tree</p>
            </aside>
          </main>
          <footer>
            <span>
              {snapshot.repository.state === 'clean' ? 'Ready' : snapshot.repository.state}
              {snapshot.repository.isShallow ? ' · shallow history' : ''}
              {snapshot.repository.isSparse ? ' · sparse checkout' : ''}
            </span>
            <span>
              {snapshot.status.upstream
                ? `${snapshot.status.upstream} · ↑${snapshot.status.ahead} ↓${snapshot.status.behind}`
                : 'Local repository'}
            </span>
          </footer>
        </>
      ) : (
        <main className="welcome">
          <div>
            <span className="welcome-icon" aria-hidden="true">
              ◈
            </span>
            <p className="eyebrow">YOUR REPOSITORY, IN VIEW</p>
            <h1>A clear view of your history.</h1>
            <p>
              Explore branches, inspect your working tree,
              <br />
              and follow the commits that brought you here.
            </p>
            <button className="primary" onClick={open} disabled={!!busy}>
              Open a repository
            </button>
            <small>Uses Git installed on your computer · No account required</small>
          </div>
        </main>
      )}
      {busy && (
        <div className="activity" role="status">
          Reading repository…
        </div>
      )}
    </div>
  );
}
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div role="alert" className="error">
        Unable to display repository: {this.state.error}
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
