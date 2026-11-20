import { Welcome, completeWelcomeGuide } from './welcome.js';
import { Activity, ActivityToast } from './activity.js';
import { DiagnosticsControl } from './diagnostics.js';
import { UpdatesControl } from './updates.js';
import { RepositoryLinkControl } from './repository-link.js';
import { themeReady } from './theme.js';
import { CommandButton, CommandControls, CommandProvider } from './commands.js';
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { TerminalHandle, TerminalSession } from './terminal.js';
const TerminalPanel = lazy(() => import('./terminal.js'));
import { createRoot } from 'react-dom/client';
import { AvatarSettings } from './avatars.js';
import { Appearance } from './appearance.js';
import { CrashReporting } from './crash-reporting.js';
import { reportRendererFailure } from './report-failure.js';
import { RepositorySync } from './repository-sync.js';
import { WorkingTreePanel } from './working-tree.js';
import { History } from './history.js';
import { NewReferences } from './references.js';
import { GitProgress } from './git-progress.js';
import { CloneDialog } from './clone.js';
import { Issues } from './issues.js';
import { PullRequests } from './pull-requests.js';
import { ProviderAccountsControl } from './providers.js';
import { Authentication } from './authentication.js';
import { GitEditors } from './git-editor.js';
import { Stashes } from './stashes.js';
import { WorktreesControl } from './worktrees.js';
import { LfsControl } from './lfs.js';
import { SubmodulesControl } from './submodules.js';
import { Push } from './push.js';
import { Reset } from './reset.js';
import { Integration } from './integration.js';
import { InteractiveRebaseControl } from './interactive-rebase.js';
import { CommitFilesPanel } from './commit-files.js';
import { Pull } from './pull.js';
import { ManageRemotes } from './remotes.js';
import { ReferenceDropActions } from './reference-drop.js';
import { ReferenceSidebar } from './reference-sidebar.js';
import { useRepository } from './store.js';
import './style.css';
function App() {
  useEffect(() => {
    void window.openkraken
      .request({ id: crypto.randomUUID(), method: 'updatesStarted' })
      .catch(() => {});
  }, []);
  const {
    snapshot,
    busy: active,
    syncing,
    paging,
    detail,
    setDetail,
    error,
    run,
    cancel,
  } = useRepository();
  const busy = syncing ? undefined : active;
  const [init, setInit] = useState(false);
  const repositoryOpen = !!snapshot;
  useEffect(() => {
    if (repositoryOpen) completeWelcomeGuide();
  }, [repositoryOpen]);
  const [clone, setClone] = useState(false);
  const openClone = () => {
    useRepository.setState({ error: undefined });
    setClone(true);
  };
  const branchInput = useRef<HTMLInputElement>(null);
  const initLauncher = useRef<HTMLElement | null>(null);
  const beginInit = () => {
    initLauncher.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setInit(true);
    branchInput.current?.focus();
  };
  const [branch, setBranch] = useState('main');
  const [terminal, setTerminal] = useState<TerminalSession>();
  const [terminalHidden, setTerminalHidden] = useState(false);
  const terminalHandle = useRef<TerminalHandle>(null);
  async function chooseFolder(method: 'open' | 'init', launcher: Element | null) {
    const cursor = snapshot?.cursor;
    const id = crypto.randomUUID();
    await run(method === 'open' ? { id, method } : { id, method, branch });
    if (!(launcher instanceof HTMLElement)) return;
    // The picker can temporarily disable its launcher or remove the branch form.
    // Wait for React to enable the controls again, and respect any new focus.
    requestAnimationFrame(() => {
      if (
        useRepository.getState().snapshot?.cursor === cursor &&
        launcher.isConnected &&
        document.activeElement === document.body
      )
        launcher.focus();
    });
  }
  const open = () => void chooseFolder('open', document.activeElement);
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
          <RepositoryLinkControl />
          <CommandControls />
          <Appearance />
          <CrashReporting />
          <Activity />
          <DiagnosticsControl />
          <UpdatesControl />
          <AvatarSettings />
          <CommandButton command="repository.clone" disabled={!!busy} onClick={openClone}>
            Clone
          </CommandButton>
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
          <WorktreesControl key={`worktrees:${snapshot?.repository.id}`} />
          <SubmodulesControl key={`submodules:${snapshot?.repository.id}`} />
          <LfsControl key={`lfs:${snapshot?.repository.id}`} />
          <CommandButton
            command="repository.terminal"
            disabled={!snapshot}
            onClick={() => {
              if (!terminal && snapshot)
                setTerminal({
                  id: crypto.randomUUID(),
                  repoId: snapshot.repository.id,
                  path: snapshot.repository.path,
                });
              setTerminalHidden(false);
              terminalHandle.current?.focus();
            }}
          >
            Terminal
          </CommandButton>
          <CommandButton command="repository.open" onClick={open} disabled={!!busy}>
            Open repository
          </CommandButton>
          <CommandButton
            command="repository.init"
            onClick={() => (init ? setInit(false) : beginInit())}
            disabled={!!busy}
          >
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
          {(busy || paging) && <button onClick={() => void cancel()}>Cancel</button>}
        </div>
      </header>
      {clone && <CloneDialog close={() => setClone(false)} />}
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
            void chooseFolder('init', initLauncher.current);
          }}
        >
          <label>
            Initial branch{' '}
            <input
              ref={branchInput}
              autoFocus
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              required
              maxLength={200}
            />
          </label>
          <button disabled={!!busy}>Choose folder and initialize</button>
          <button
            type="button"
            onClick={() => {
              setInit(false);
              initLauncher.current?.focus();
            }}
          >
            Cancel initialization
          </button>
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
            <ReferenceSidebar />
            <section className="history">
              <div className="panel-title">
                <h2>History</h2>
                <span id="history-commit-count" data-testid="commit-count">
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
          {terminal && (
            <Suspense fallback={<div role="status">Loading terminal…</div>}>
              <TerminalPanel
                ref={terminalHandle}
                session={terminal}
                hidden={terminalHidden}
                onHide={() => setTerminalHidden(true)}
                onClose={() => setTerminal(undefined)}
              />
            </Suspense>
          )}
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
        <Welcome
          actions={{
            open,
            clone: openClone,
            init: beginInit,
          }}
          busy={!!busy}
        />
      )}
      <ActivityToast />
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
  componentDidCatch() {
    reportRendererFailure('unhandled-exception');
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
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  void themeReady.then(() => {
    root.render(
      <ErrorBoundary>
        <CommandProvider>
          <App />
        </CommandProvider>
      </ErrorBoundary>,
    );
  });
  // The desktop checks this after document load. Theme reads can finish later.
  container.setAttribute('data-openkraken-entry-loaded', '');
}
