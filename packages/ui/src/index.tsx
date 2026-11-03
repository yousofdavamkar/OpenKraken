import { themeReady } from './theme.js';
import { CommandButton, CommandControls, CommandProvider } from './commands.js';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AvatarSettings } from './avatars.js';
import { Appearance } from './appearance.js';
import { RepositorySync } from './repository-sync.js';
import { WorkingTreePanel } from './working-tree.js';
import { History } from './history.js';
import { NewReferences, ReferenceActions } from './references.js';
import { GitProgress } from './git-progress.js';
import { Clone } from './clone.js';
import { Issues } from './issues.js';
import { PullRequests } from './pull-requests.js';
import { ProviderAccountsControl } from './providers.js';
import { Authentication } from './authentication.js';
import { GitEditors } from './git-editor.js';
import { Stashes } from './stashes.js';
import { Push } from './push.js';
import { Reset } from './reset.js';
import { Integration } from './integration.js';
import { InteractiveRebaseControl } from './interactive-rebase.js';
import { CommitFilesPanel } from './commit-files.js';
import { Pull } from './pull.js';
import { ManageRemotes } from './remotes.js';
import { ReferenceDropActions, referenceDragProps } from './reference-drop.js';
import { RefControls } from './ref-controls.js';
import { useRepository } from './store.js';
import './style.css';
function App() {
  const {
    snapshot,
    busy: active,
    syncing,
    paging,
    searching,
    detail,
    setDetail,
    error,
    run,
    cancel,
    setView,
  } = useRepository();
  const busy = syncing ? undefined : active;
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
          <CommandControls />
          <Appearance />
          <AvatarSettings />
          <Clone />
          <ProviderAccountsControl />
          <PullRequests />
          <Issues />
          <NewReferences />
          <ManageRemotes />
          <Pull />
          <Integration />
          <InteractiveRebaseControl />
          <Reset />
          <Push />
          <Stashes />
          <CommandButton command="repository.open" onClick={open} disabled={!!busy}>
            Open repository
          </CommandButton>
          <CommandButton command="repository.init" onClick={() => setInit(!init)} disabled={!!busy}>
            Initialize
          </CommandButton>
          {snapshot && (
            <CommandButton
              command="repository.refresh"
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
            </CommandButton>
          )}
          {(busy || paging || searching) && <button onClick={() => void cancel()}>Cancel</button>}
        </div>
      </header>
      <GitProgress />
      <Authentication />
      <GitEditors />
      <ReferenceDropActions key={snapshot?.repository.id} />
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
          <RepositorySync />
          <main>
            <aside className="refs">
              <h2>
                References <span>{snapshot.refs.length}</span>
              </h2>
              {(snapshot.view.hiddenRefs.length > 0 ||
                snapshot.view.soloRef ||
                snapshot.view.pinnedRef) && (
                <div className="view-summary" aria-label="Active graph view">
                  {snapshot.view.hiddenRefs.length > 0 && (
                    <p>{snapshot.view.hiddenRefs.length} hidden refs</p>
                  )}
                  {snapshot.view.soloRef && <p>Solo: {snapshot.view.soloRef}</p>}
                  {snapshot.view.pinnedRef && <p>Pinned: {snapshot.view.pinnedRef}</p>}
                  <button disabled={!!busy} onClick={() => void setView({ hiddenRefs: [] })}>
                    Reset graph view
                  </button>
                </div>
              )}
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
                        className={`ref ${ref.isHead ? 'current' : ''} ${snapshot.view.hiddenRefs.includes(ref.name) ? 'hidden-ref' : ''}`}
                        key={ref.name}
                        {...referenceDragProps(ref, snapshot.repository.id, !!busy)}
                        title={`${ref.name}\n${ref.target}`}
                      >
                        <div className="ref-label">
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
                        <RefControls reference={ref} />
                        <ReferenceActions reference={ref} />
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
                  {snapshot.hasMore ? ' · more available' : ''}
                </span>
              </div>
              <History />
            </section>
            <aside className="status">
              {detail && (
                <section className="commit-detail" aria-label="Commit details">
                  <button onClick={() => setDetail()}>Close details</button>
                  <h2>{detail.summary}</h2>
                  <code>{detail.oid}</code>
                  <p>
                    {detail.author.name} {detail.author.email}
                  </p>
                  <pre>{detail.body}</pre>
                  {/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(detail.oid) && (
                    <CommitFilesPanel
                      key={`${snapshot.repository.id}:${detail.oid}`}
                      repoId={snapshot.repository.id}
                      oid={detail.oid}
                    />
                  )}
                </section>
              )}

              <WorkingTreePanel key={snapshot.repository.id} />
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
void themeReady.then(() => {
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
      <CommandProvider>
        <App />
      </CommandProvider>
    </ErrorBoundary>,
  );
});
