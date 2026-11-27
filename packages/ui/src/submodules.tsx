import { observeSubmodules } from './submodule-observer.js';
import { subscribeDesktopEvents } from './desktop-events.js';
import { useEffect, useRef, useState } from 'react';
import type {
  SubmoduleState,
  SubmoduleUpdatePreview,
  SubmoduleSyncPreview,
} from '@openkraken/ipc-contract';
import { CommandButton } from './commands.js';
import { useRepository, waitForBackground } from './store.js';

const labels = {
  clean: 'Clean',
  modified: 'Modified',
  'out-of-date': 'Out of date',
  uninitialized: 'Uninitialized',
  conflict: 'Index conflict',
  unavailable: 'Unavailable',
};

function SubmoduleDialog({ repoId, close }: { repoId: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const updateButton = useRef<HTMLButtonElement>(null);
  const cancelReview = useRef<HTMLButtonElement>(null);
  const updateId = useRef<string | undefined>(undefined);
  const reviewed = useRef(false);
  const [review, setReview] = useState<SubmoduleUpdatePreview>();
  const [syncReview, setSyncReview] = useState<SubmoduleSyncPreview>();
  const [synchronizing, setSynchronizing] = useState(false);
  const syncButton = useRef<HTMLButtonElement>(null);
  const cancelSync = useRef<HTMLButtonElement>(null);
  const syncReviewed = useRef(false);
  const refreshFocus = useRef<HTMLButtonElement | null>(null);
  const [allowLocal, setAllowLocal] = useState(false);
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState('');
  const [updating, setUpdating] = useState(false);
  const [state, setState] = useState<SubmoduleState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const observing = !!state && !pending && !review && !syncReview;
  useEffect(() => {
    if (!observing) return;
    return observeSubmodules(
      repoId,
      (next) => setState((previous) => (previous?.revision === next.revision ? previous : next)),
      setRefreshError,
    );
  }, [repoId, observing]);
  useEffect(
    () =>
      subscribeDesktopEvents((event) => {
        if (event.type === 'gitProgress' && event.id === updateId.current) setProgress(event.text);
      }),
    [],
  );
  useEffect(() => {
    if (pending) return;
    if (review) cancelReview.current?.focus();
    else if (reviewed.current) updateButton.current?.focus();
  }, [review, pending]);
  useEffect(() => {
    if (pending || !syncReviewed.current) return;
    if (syncReview) cancelSync.current?.focus();
    else syncButton.current?.focus();
  }, [syncReview, pending]);
  useEffect(() => {
    if (!pending && refreshFocus.current) {
      refreshFocus.current.focus();
      refreshFocus.current = null;
    }
  }, [pending]);
  const load = async () => {
    reviewed.current = false;
    syncReviewed.current = false;
    setRefreshError('');
    setSyncReview(undefined);
    setReview(undefined);
    setNotice('');
    setPending(true);
    setError('');
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'submodules',
        repoId,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'submodules') setState(result.state);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    dialog.current?.showModal();
    void load();
  }, []);
  const open = async (submoduleId: string) => {
    if (!state) return;
    setPending(true);
    setError('');
    await useRepository.getState().run({
      id: crypto.randomUUID(),
      method: 'openSubmodule',
      repoId,
      submoduleId,
      revision: state.revision,
    });
    if (useRepository.getState().snapshot?.repository.id !== repoId) close();
    else {
      setError(useRepository.getState().error ?? 'The submodule could not be opened');
      setPending(false);
    }
  };
  const reviewUpdate = async () => {
    syncReviewed.current = false;
    setPending(true);
    setError('');
    setNotice('');
    setReview(undefined);
    setAllowLocal(false);
    reviewed.current = true;
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'submoduleUpdatePreview',
        repoId,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'submoduleUpdatePreview') setReview(result.preview);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  const reviewSync = async () => {
    setPending(true);
    setError('');
    setNotice('');
    setSyncReview(undefined);
    reviewed.current = false;
    syncReviewed.current = true;
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'submoduleSyncPreview',
        repoId,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'submoduleSyncPreview') setSyncReview(result.preview);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  const synchronize = async () => {
    if (!syncReview) return;
    setPending(true);
    setError('');
    setNotice('');
    try {
      if (useRepository.getState().syncing) await waitForBackground();
      if (useRepository.getState().snapshot?.repository.id !== repoId) return;
      if (useRepository.getState().busy)
        throw new Error('Wait for the current operation to finish');
      const id = crypto.randomUUID();
      updateId.current = id;
      useRepository.setState({ busy: id });
      setSynchronizing(true);
      const result = await window.openkraken.request({
        id,
        method: 'syncSubmodules',
        repoId,
        token: syncReview.token,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'cancelled') throw new Error('URL synchronization cancelled.');
      if (result.kind === 'submodules') {
        setState(result.state);
        setNotice('Submodule URLs synchronized. Files and checked-out commits were retained.');
      }
    } catch (error) {
      setError(
        `${error instanceof Error ? error.message : String(error)} Some URL settings may already have changed. Review again before retrying.`,
      );
    } finally {
      const id = updateId.current;
      updateId.current = undefined;
      setSynchronizing(false);
      setSyncReview(undefined);
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      if (id && useRepository.getState().snapshot?.repository.id === repoId)
        await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
      setPending(false);
    }
  };
  const update = async () => {
    if (!review) return;
    setPending(true);
    setError('');
    setNotice('');
    setProgress('Updating submodules…');
    try {
      if (useRepository.getState().syncing) await waitForBackground();
      if (useRepository.getState().snapshot?.repository.id !== repoId) return;
      if (useRepository.getState().busy)
        throw new Error('Wait for the current operation to finish');
      const id = crypto.randomUUID();
      updateId.current = id;
      useRepository.setState({ busy: id });
      setUpdating(true);
      const result = await window.openkraken.request({
        id,
        method: 'updateSubmodules',
        repoId,
        token: review.token,
        allowLocal,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'cancelled') throw new Error('Update cancelled.');
      if (result.kind === 'submodules') {
        setState(result.state);
        setNotice('Submodules updated to their recorded commits');
      }
    } catch (error) {
      setError(
        `${error instanceof Error ? error.message : String(error)} Some submodules may already have changed. Refresh before retrying.`,
      );
    } finally {
      const id = updateId.current;
      updateId.current = undefined;
      setUpdating(false);
      setReview(undefined);
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      if (id && useRepository.getState().snapshot?.repository.id === repoId)
        await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
      setPending(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog submodules-dialog"
      aria-label="Submodules"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) {
          if (syncReview) setSyncReview(undefined);
          else if (review) setReview(undefined);
          else close();
        }
      }}
    >
      <h2>Submodules</h2>
      <p>
        Each submodule is a separate repository pinned to a commit in its parent’s index. Nested
        checkouts are listed below their parent.
      </p>
      {error && <p role="alert">{error}</p>}
      {observing && !error && refreshError && (
        <p role="alert">Could not refresh submodules. {refreshError}</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {synchronizing && (
        <div>
          <p role="status">Synchronizing submodule URLs…</p>
          <button onClick={() => void useRepository.getState().cancel()}>
            Cancel synchronization
          </button>
        </div>
      )}
      {syncReview && (
        <fieldset disabled={pending}>
          <legend>Review submodule URL synchronization</legend>
          <p>
            Copy URLs from each working checkout’s .gitmodules into registered submodule settings
            and their selected remotes, recursively. This replaces local URL overrides and can
            affect linked worktrees that share configuration.
          </p>
          <p>
            Relative URLs are resolved by Git using each parent’s default remote. Unregistered
            submodules are skipped. This action does not fetch, initialize, stage files or change
            checked-out commits. It has no Undo; cancellation or failure can leave partial URL
            changes.
          </p>
          <ul aria-label="Reviewed submodule URLs">
            {syncReview.entries.map((entry) => (
              <li key={entry.path}>
                <h4>{entry.path}</h4>
                <p className="submodule-path">URL in .gitmodules: {entry.declaredUrl}</p>
                <p className="submodule-path">
                  {entry.registered
                    ? `Current local URL: ${entry.configuredUrl ?? ''}`
                    : 'Not registered locally; skipped'}
                </p>
              </li>
            ))}
          </ul>
          <details>
            <summary>Current URL settings and relative-URL context</summary>
            <ul>
              {syncReview.sources.map((source, index) => (
                <li key={`${source.repository}:${source.setting}:${index}`}>
                  <p className="submodule-path">{source.repository}</p>
                  <p className="submodule-path">
                    {source.setting}: {source.value}
                  </p>
                </li>
              ))}
            </ul>
          </details>
          <div className="dialog-actions">
            <button onClick={() => void synchronize()}>Synchronize URLs</button>
            <button ref={cancelSync} onClick={() => setSyncReview(undefined)}>
              Cancel URL review
            </button>
          </div>
        </fieldset>
      )}
      {updating && (
        <div>
          <p role="status">{progress}</p>
          <button
            onClick={() => {
              if (updateId.current) void window.openkraken.cancel(updateId.current);
            }}
          >
            Cancel update
          </button>
        </div>
      )}
      {review && (
        <fieldset disabled={pending}>
          <legend>Review recursive submodule update</legend>
          <p>
            Initialize missing checkouts and check out each parent’s recorded commit. Nested
            submodules are updated recursively; fetching their commits can reveal additional sources
            that are not listed yet.
          </p>
          <p>
            This may download code from configured sources. It can partially complete before an
            error or cancellation, and has no Undo. Changed, untracked, ignored or unreferenced
            submodule work must be preserved first.
          </p>
          <ul aria-label="Reviewed submodule commits">
            {review.entries.map((entry) => (
              <li key={entry.id}>
                <span className="submodule-path">{entry.path}</span> · {entry.indexOid}{' '}
                {entry.url && <span className="submodule-path">· {entry.url}</span>}
              </li>
            ))}
          </ul>
          <details>
            <summary>Configured sources and URL rewrites</summary>
            <ul>
              {review.sources.map((source, index) => (
                <li key={index}>
                  <p className="submodule-path">{source.repository}</p>
                  <p className="submodule-path">
                    {source.setting}: {source.value}
                  </p>
                </li>
              ))}
            </ul>
          </details>
          <label>
            <input
              type="checkbox"
              checked={allowLocal}
              onChange={(event) => setAllowLocal(event.target.checked)}
            />
            Allow local-file sources
          </label>
          <p>
            Enable only if you trust local paths used by this repository and its nested submodules.
          </p>
          <div className="dialog-actions">
            <button onClick={() => void update()}>Initialize and update</button>
            <button ref={cancelReview} onClick={() => setReview(undefined)}>
              Cancel review
            </button>
          </div>
        </fieldset>
      )}
      {!state && (
        <p role="status">{pending ? 'Loading submodules…' : 'Submodules could not be loaded'}</p>
      )}
      {state?.entries.length === 0 && <p>No submodules are registered in this checkout’s index.</p>}
      <ul aria-label="Registered submodules">
        {state?.entries.map((entry) => (
          <li key={entry.id}>
            <h3 className="submodule-path">{entry.path}</h3>
            <p>
              {labels[entry.state]}
              {entry.changedFiles !== null && entry.changedFiles > 0
                ? ` · ${entry.changedFiles} changed file${entry.changedFiles === 1 ? '' : 's'}`
                : ''}
              {entry.depth > 0 ? ` · Nested level ${entry.depth}` : ''}
            </p>
            {entry.indexOid && (
              <p>
                Recorded commit <code>{entry.indexOid}</code>
              </p>
            )}
            {entry.head && (
              <p>
                Checked-out commit <code>{entry.head}</code>
              </p>
            )}
            {entry.url && <p className="submodule-path">Configured URL: {entry.url}</p>}
            {entry.problem && <p>{entry.problem}</p>}
            <button
              disabled={pending || !!review || !!syncReview || !entry.available}
              onClick={() => void open(entry.id)}
            >
              Open submodule
            </button>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button
          ref={syncButton}
          disabled={pending || !!review || !!syncReview || !state?.entries.length}
          onClick={() => void reviewSync()}
        >
          Review URL sync
        </button>
        <button
          ref={updateButton}
          disabled={pending || !!review || !!syncReview || !state?.entries.length}
          onClick={() => void reviewUpdate()}
        >
          Review update
        </button>
        <button
          disabled={pending || !!review || !!syncReview}
          onClick={(event) => {
            refreshFocus.current = event.currentTarget;
            void load();
          }}
        >
          Refresh submodules
        </button>
        <button disabled={pending} onClick={close}>
          Close
        </button>
      </div>
    </dialog>
  );
}
export function SubmodulesControl() {
  const { snapshot, busy } = useRepository();
  const [open, setOpen] = useState(false);
  return (
    <>
      <CommandButton
        command="repository.submodules"
        disabled={!snapshot || snapshot.repository.isBare || !!busy}
        onClick={() => setOpen(true)}
      >
        Submodules
      </CommandButton>
      {open && snapshot && (
        <SubmoduleDialog
          key={snapshot.repository.id}
          repoId={snapshot.repository.id}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}
