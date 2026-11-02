import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type {
  Request,
  WorkingState,
  WorkingDiff,
  WorkingComparisonOptions,
  DiscardPreview,
  ConflictPreview,
} from '@openkraken/ipc-contract';
import { ConflictEditor } from './conflict-editor.js';
import { OperationPanel } from './operation.js';
import { DiscardDialog } from './discard-dialog.js';
import { WorkingDiffDialog } from './working-diff.js';
import { useRepository, waitForBackground } from './store.js';
const WorkingFileEditor = lazy(() =>
  import('./working-file-editor.js').then((module) => ({ default: module.WorkingFileEditor })),
);
const FileComparisonDialog = lazy(() =>
  import('./file-comparison.js').then((module) => ({ default: module.FileComparisonDialog })),
);
export function WorkingTreePanel() {
  const { snapshot, busy: active, syncing, workingState: state } = useRepository();
  const busy = syncing ? undefined : active;
  const [comparison, setComparison] = useState<WorkingComparisonOptions>();
  const [editorPath, setEditorPath] = useState<string>();
  const [discard, setDiscard] = useState<{ preview: DiscardPreview; paths: string[] }>();
  const [conflict, setConflict] = useState<ConflictPreview>();
  const [preview, setPreview] = useState<WorkingDiff>();
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewSequence = useRef(0);
  const setState = (state: WorkingState) => useRepository.setState({ workingState: state });
  const [message, setMessage] = useState('');
  const [amendText, setAmendText] = useState('');
  const [amend, setAmend] = useState(false);
  const [amendHead, setAmendHead] = useState<string>();
  const [sign, setSign] = useState('default');
  const templateLoaded = useRef(false);
  const draftVersion = useRef(0);
  useEffect(() => {
    if (state && !templateLoaded.current) {
      templateLoaded.current = true;
      setMessage((draft) => draft || state.messageTemplate || '');
    }
  }, [state]);
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
  const mutate = async (request: Request, onSuccess?: () => void) => {
    if (useRepository.getState().syncing) await waitForBackground();
    if (useRepository.getState().snapshot?.repository.id !== repoId) return false;
    if (useRepository.getState().busy) return false;
    let success = false;
    useRepository.setState({ busy: request.id });
    setError(undefined);
    try {
      const result = await window.openkraken.request(request);
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'workingState') {
        setState(result.state);
        success = true;
        onSuccess?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      useRepository.setState({ busy: undefined });
      if (useRepository.getState().snapshot?.repository.id === repoId)
        if (request.method === 'undo')
          await useRepository
            .getState()
            .run({ id: crypto.randomUUID(), method: 'refresh', repoId });
        else await useRepository.getState().refreshStatus(false);
    }
    return success;
  };
  const showDiff = async (pathBytes: string, side: 'worktree' | 'index') => {
    const sequence = ++previewSequence.current;
    setPreviewBusy(true);
    setError(undefined);
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'diff',
        repoId,
        pathBytes,
        side,
      });
      if (sequence !== previewSequence.current) return;
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'diff') setPreview(result.diff);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (sequence === previewSequence.current) setPreviewBusy(false);
    }
  };
  const showConflict = async (pathBytes: string) => {
    setPreviewBusy(true);
    setError(undefined);
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'conflictPreview',
        repoId,
        pathBytes,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'conflictPreview') setConflict(result.preview);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewBusy(false);
    }
  };
  const reviewDiscard = async (paths: string[]) => {
    setPreviewBusy(true);
    setError(undefined);
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'discardPreview',
        repoId,
        paths,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'discardPreview') setDiscard({ preview: result.preview, paths });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewBusy(false);
    }
  };
  const status = state?.status ?? snapshot.status;
  const staged = status.entries.filter((e) => e.kind !== 'untracked' && e.index !== '.');
  const unstaged = status.entries.filter((e) => e.kind === 'untracked' || e.worktree !== '.');
  const files = (action: 'stage' | 'unstage', paths: string[]) =>
    void mutate({ id: crypto.randomUUID(), method: 'files', repoId, action, paths });
  return (
    <section aria-label="Working tree">
      <OperationPanel key={repoId} />
      {conflict && (
        <ConflictEditor
          key={conflict.token}
          document={conflict}
          busy={!!busy}
          error={error}
          close={() => setConflict(undefined)}
          resolve={(options) => {
            void mutate({
              id: crypto.randomUUID(),
              method: 'resolveConflict',
              repoId,
              options,
            }).then((ok) => {
              if (ok) setConflict(undefined);
            });
          }}
        />
      )}

      {discard && (
        <DiscardDialog
          preview={discard.preview}
          busy={!!busy}
          error={error}
          onClose={() => setDiscard(undefined)}
          onCancel={() => void useRepository.getState().cancel()}
          onApply={() => {
            void mutate({
              id: crypto.randomUUID(),
              method: 'discard',
              repoId,
              paths: discard.paths,
              token: discard.preview.token,
            }).then((ok) => {
              if (ok) setDiscard(undefined);
            });
          }}
        />
      )}
      {editorPath && (
        <Suspense fallback={<p role="status">Opening editor…</p>}>
          <WorkingFileEditor
            key={`${repoId}:${editorPath}`}
            repoId={repoId}
            pathBytes={editorPath}
            busy={!!busy}
            error={error}
            onClose={() => {
              setEditorPath(undefined);
              setError(undefined);
            }}
            onSave={(options) =>
              mutate({ id: crypto.randomUUID(), method: 'saveWorkingFile', repoId, options })
            }
          />
        </Suspense>
      )}
      {comparison && (
        <Suspense fallback={<p role="status">Opening comparison…</p>}>
          <FileComparisonDialog
            repoId={repoId}
            options={comparison}
            onClose={() => setComparison(undefined)}
            onSelectLines={() => {
              setComparison(undefined);
              void showDiff(comparison.pathBytes, comparison.side);
            }}
          />
        </Suspense>
      )}
      {preview && (
        <WorkingDiffDialog
          key={preview.token}
          diff={preview}
          busy={!!busy}
          error={error}
          onInspect={() => {
            setComparison({ pathBytes: preview.pathBytes, side: preview.side });
            setPreview(undefined);
          }}
          onClose={() => setPreview(undefined)}
          onApply={(lines) => {
            void mutate({
              id: crypto.randomUUID(),
              method: 'patch',
              repoId,
              options: {
                pathBytes: preview.pathBytes,
                side: preview.side,
                token: preview.token,
                lines,
              },
            }).then((ok) => {
              if (ok) setPreview(undefined);
            });
          }}
        />
      )}
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
                  {entry.kind === 'conflict' && action === 'stage' && (
                    <button
                      disabled={!!busy || previewBusy}
                      aria-label={`Resolve ${entry.path}`}
                      onClick={() => void showConflict(entry.pathBytes)}
                    >
                      Resolve
                    </button>
                  )}
                  <button
                    disabled={!!busy || previewBusy}
                    aria-label={`View ${action === 'stage' ? 'unstaged' : 'staged'} ${entry.path}`}
                    onClick={() =>
                      void showDiff(entry.pathBytes, action === 'stage' ? 'worktree' : 'index')
                    }
                  >
                    View changes
                  </button>{' '}
                  <button
                    disabled={!!busy}
                    aria-label={`${action === 'stage' ? 'Stage' : 'Unstage'} ${entry.path}`}
                    onClick={() => files(action, [entry.pathBytes])}
                  >
                    {action === 'stage' ? 'Stage' : 'Unstage'}
                  </button>{' '}
                  <button
                    disabled={
                      !!busy ||
                      previewBusy ||
                      entry.kind === 'conflict' ||
                      entry.submodule.startsWith('S') ||
                      state?.operation?.kind !== 'none'
                    }
                    aria-label={`Edit ${entry.path}`}
                    onClick={() => {
                      setError(undefined);
                      setEditorPath(entry.pathBytes);
                    }}
                  >
                    Edit file
                  </button>
                  {action === 'stage' && (
                    <button
                      className="danger"
                      aria-label={`Discard ${entry.path}`}
                      disabled={
                        !!busy ||
                        previewBusy ||
                        entry.kind === 'conflict' ||
                        entry.submodule.startsWith('S')
                      }
                      onClick={() => void reviewDiscard([entry.pathBytes])}
                    >
                      Discard
                    </button>
                  )}
                </div>
              ))}
            </section>
          ))}
          <form
            className="commit-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!state) return;
              const submittedVersion = draftVersion.current;
              await mutate(
                {
                  id: crypto.randomUUID(),
                  method: 'commit',
                  repoId,
                  options: {
                    message: amend ? amendText : message,
                    revision: state.revision,
                    amend,
                    ...(sign === 'default' ? {} : { sign: sign === 'on' }),
                  },
                },
                () => {
                  if (draftVersion.current !== submittedVersion) return;
                  setMessage('');
                  setAmendText('');
                  setAmend(false);
                },
              );
            }}
          >
            <label>
              Commit message
              <textarea
                rows={5}
                aria-label="Commit message"
                maxLength={65536}
                value={amend ? amendText : message}
                onChange={(event) => {
                  draftVersion.current++;
                  (amend ? setAmendText : setMessage)(event.target.value);
                }}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={amend}
                disabled={
                  !!busy ||
                  !state?.head.oid ||
                  (!!state.operation &&
                    state.operation.kind !== 'none' &&
                    !state.operation.editStopped)
                }
                onChange={(event) => {
                  draftVersion.current++;
                  setAmend(event.target.checked);
                  if (event.target.checked) {
                    setAmendText(state?.amendMessage ?? '');
                    setAmendHead(state?.head.oid);
                  }
                }}
              />{' '}
              Amend last commit
            </label>
            {amend && amendHead !== state?.head.oid && (
              <p role="alert">HEAD changed. Turn Amend off and on to review the current commit.</p>
            )}
            <label>
              Signing
              <select
                aria-label="Signing"
                value={sign}
                onChange={(event) => setSign(event.target.value)}
              >
                <option value="default">Git setting ({state?.signing ? 'on' : 'off'})</option>
                <option value="on">Sign with configured agent</option>
                <option value="off">Do not sign</option>
              </select>
            </label>
            {state?.commitWarning && <p role="alert">{state.commitWarning}</p>}
            <button
              className="primary"
              disabled={
                !!busy ||
                !state ||
                (!!state.operation &&
                  state.operation.kind !== 'none' &&
                  !(amend && state.operation.editStopped)) ||
                !(amend ? amendText : message).trim() ||
                (!amend && !staged.length) ||
                (amend && amendHead !== state.head.oid)
              }
            >
              {amend ? 'Amend commit' : 'Commit staged changes'}
            </button>
          </form>
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
