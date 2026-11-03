import { useEffect, useRef, useState } from 'react';
import type {
  Worktree,
  WorktreeAction,
  WorktreeAdd,
  WorktreeState,
  WorktreePrunePreview,
} from '@openkraken/ipc-contract';
import { CommandButton } from './commands.js';
import { useRepository, waitForBackground } from './store.js';

function WorktreeDialog({ repoId, close }: { repoId: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const actionTrigger = useRef<HTMLButtonElement>(null);
  const actionCancel = useRef<HTMLButtonElement>(null);
  const lockReason = useRef<HTMLInputElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const pruneButton = useRef<HTMLButtonElement>(null);
  const pruneCancel = useRef<HTMLButtonElement>(null);
  const [pruneReview, setPruneReview] = useState<WorktreePrunePreview>();
  const [state, setState] = useState<WorktreeState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [review, setReview] = useState<{
    entry: Worktree;
    action: WorktreeAction['action'];
    revision: string;
  }>();
  const [reason, setReason] = useState('');
  const snapshot = useRepository((store) => store.snapshot);
  const [mode, setMode] = useState<WorktreeAdd['mode']>('new');
  const [branch, setBranch] = useState('');
  const [oid, setOid] = useState(snapshot?.repository.head.oid ?? '');
  const branches = snapshot?.refs.filter((ref) => ref.kind === 'local') ?? [];
  useEffect(() => {
    if (pending) return;
    if (pruneReview) pruneCancel.current?.focus();
    else if (review?.action === 'lock') lockReason.current?.focus();
    else if (review) actionCancel.current?.focus();
    else if (actionTrigger.current) {
      if (actionTrigger.current.isConnected) actionTrigger.current.focus();
      else refreshButton.current?.focus();
    }
  }, [review, pruneReview, pending]);
  const load = async () => {
    setReview(undefined);
    setPruneReview(undefined);
    setNotice('');
    setPending(true);
    setError('');
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'worktrees',
        repoId,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'worktrees') setState(result.state);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    dialog.current?.showModal();
    void load();
  }, []);
  const open = async (worktreeId: string) => {
    if (!state) return;
    setPending(true);
    setError('');
    await useRepository.getState().run({
      id: crypto.randomUUID(),
      method: 'openWorktree',
      repoId,
      worktreeId,
      revision: state.revision,
    });
    if (useRepository.getState().snapshot?.repository.id !== repoId) close();
    else {
      setError(useRepository.getState().error ?? 'The worktree could not be opened');
      setPending(false);
    }
  };
  const create = async () => {
    if (!state) return;
    setPruneReview(undefined);
    setPending(true);
    setError('');
    setNotice('');
    let id: string | undefined;
    try {
      if (useRepository.getState().syncing) await waitForBackground();
      if (useRepository.getState().snapshot?.repository.id !== repoId) return;
      if (useRepository.getState().busy)
        throw new Error('Wait for the current operation to finish');
      id = crypto.randomUUID();
      useRepository.setState({ busy: id });
      const options: WorktreeAdd =
        mode === 'detached'
          ? { revision: state.revision, mode, oid }
          : { revision: state.revision, mode, oid, branch };
      const result = await window.openkraken.request({
        id,
        method: 'addWorktree',
        repoId,
        options,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'worktrees') {
        setState(result.state);
        setBranch('');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      if (id && useRepository.getState().snapshot?.repository.id === repoId)
        await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
      setPending(false);
    }
  };
  const reviewPrune = async () => {
    setPending(true);
    setError('');
    setNotice('');
    setReview(undefined);
    setPruneReview(undefined);
    actionTrigger.current = pruneButton.current;
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'worktreePrunePreview',
        repoId,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'worktreePrunePreview') setPruneReview(result.preview);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  const prune = async () => {
    if (!pruneReview) return;
    setPending(true);
    setError('');
    setNotice('');
    let id: string | undefined;
    try {
      if (useRepository.getState().syncing) await waitForBackground();
      if (useRepository.getState().snapshot?.repository.id !== repoId) return;
      if (useRepository.getState().busy)
        throw new Error('Wait for the current operation to finish');
      id = crypto.randomUUID();
      useRepository.setState({ busy: id });
      const result = await window.openkraken.request({
        id,
        method: 'pruneWorktrees',
        repoId,
        token: pruneReview.token,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'worktrees') {
        setState(result.state);
        setPruneReview(undefined);
        setNotice('Stale worktree registrations cleaned up');
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      if (id && useRepository.getState().snapshot?.repository.id === repoId)
        await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
      setPending(false);
    }
  };
  const act = async () => {
    if (!review) return;
    setPending(true);
    setError('');
    setNotice('');
    let id: string | undefined;
    try {
      if (useRepository.getState().syncing) await waitForBackground();
      if (useRepository.getState().snapshot?.repository.id !== repoId) return;
      if (useRepository.getState().busy)
        throw new Error('Wait for the current operation to finish');
      id = crypto.randomUUID();
      useRepository.setState({ busy: id });
      const selection = { worktreeId: review.entry.id, revision: review.revision };
      const options: WorktreeAction =
        review.action === 'lock'
          ? { ...selection, action: 'lock', reason }
          : { ...selection, action: review.action };
      const result = await window.openkraken.request({
        id,
        method: 'worktreeAction',
        repoId,
        options,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'worktrees') {
        setState(result.state);
        setReview(undefined);
        setNotice(
          review.action === 'lock'
            ? 'Worktree locked'
            : review.action === 'unlock'
              ? 'Worktree unlocked'
              : 'Worktree removed',
        );
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      if (id && useRepository.getState().snapshot?.repository.id === repoId)
        await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
      setPending(false);
    }
  };
  const chooseAction = (
    entry: Worktree,
    action: WorktreeAction['action'],
    trigger: HTMLButtonElement,
  ) => {
    if (!state) return;
    setError('');
    setNotice('');
    setReason('');
    setPruneReview(undefined);
    actionTrigger.current = trigger;
    setReview({ entry, action, revision: state.revision });
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog worktrees-dialog"
      aria-label="Worktrees"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) close();
      }}
    >
      <h2>Worktrees</h2>
      <p>Each worktree has its own checked-out branch and working files.</p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!state && (
        <p role="status">{pending ? 'Loading worktrees…' : 'Worktrees could not be loaded'}</p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <fieldset disabled={pending || !state}>
          <legend>Create worktree</legend>
          <label>
            Checkout
            <select
              value={mode}
              onChange={(event) => {
                const value = event.target.value as WorktreeAdd['mode'];
                setMode(value);
                setBranch('');
                setOid(snapshot?.repository.head.oid ?? '');
              }}
            >
              <option value="new">New branch</option>
              <option value="existing">Existing branch</option>
              <option value="detached">Detached HEAD</option>
            </select>
          </label>
          {mode === 'new' && (
            <label>
              New branch name
              <input
                required
                maxLength={1024}
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
              />
            </label>
          )}
          {mode === 'existing' && (
            <label>
              Existing branch
              <select
                required
                value={branch}
                onChange={(event) => {
                  setBranch(event.target.value);
                  setOid(
                    branches.find((ref) => ref.shortName === event.target.value)?.target ?? '',
                  );
                }}
              >
                <option value="">Choose a branch</option>
                {branches.map((ref) => (
                  <option
                    key={ref.name}
                    value={ref.shortName}
                    disabled={state?.entries.some((entry) => entry.branch === ref.name)}
                  >
                    {ref.shortName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Starting commit
            <input
              required
              value={oid}
              maxLength={64}
              pattern="[0-9a-f]{40}|[0-9a-f]{64}"
              readOnly={mode === 'existing'}
              onChange={(event) => setOid(event.target.value)}
            />
          </label>
          {!snapshot?.repository.head.oid && <p>Create a commit before adding a worktree.</p>}
          <p>Choose an empty folder. Your current checkout stays on its branch.</p>
          <button disabled={!oid || (mode !== 'detached' && !branch)}>
            Choose folder and create worktree
          </button>
        </fieldset>
      </form>
      {review && (
        <fieldset disabled={pending} aria-label="Review worktree action">
          <legend>
            {review.action === 'remove'
              ? 'Remove worktree?'
              : review.action === 'lock'
                ? 'Lock worktree?'
                : 'Unlock worktree?'}
          </legend>
          <p className="worktree-path">{review.entry.path}</p>
          <p>
            {review.entry.branch ?? 'Detached HEAD'} · {review.entry.head?.slice(0, 12)}
          </p>
          {review.action === 'lock' && (
            <>
              <p>Prevent this checkout from being removed or pruned while it is offline.</p>
              <label>
                Lock reason
                <input
                  ref={lockReason}
                  value={reason}
                  maxLength={1024}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
            </>
          )}
          {review.action === 'unlock' && (
            <p>This allows Git to remove or prune the checkout. Its files stay in place.</p>
          )}
          {review.action === 'remove' && (
            <p>
              This deletes the checkout folder. Branches are retained. Removal is refused if there
              are changed, untracked or ignored files, or detached commits without a retaining
              branch or tag.
            </p>
          )}
          <div className="dialog-actions">
            <button onClick={() => void act()}>
              {review.action === 'remove'
                ? 'Confirm removal'
                : review.action === 'lock'
                  ? 'Confirm lock'
                  : 'Confirm unlock'}
            </button>
            <button
              ref={actionCancel}
              onClick={() => {
                setReview(undefined);
                setError('');
              }}
            >
              Cancel action
            </button>
          </div>
        </fieldset>
      )}
      {pruneReview && (
        <fieldset disabled={pending} aria-label="Review worktree cleanup">
          <legend>Clean up stale registrations?</legend>
          <p>
            Cleanup removes the stale registration records shown below, including their index and
            reflog recovery data. Branches and checkout folders remain. Reconnect or lock offline
            checkouts you still need before cleanup.
          </p>
          {pruneReview.candidates.length > 0 && (
            <ul aria-label="Checkouts in cleanup">
              {pruneReview.candidates.map((entry) => (
                <li key={entry.id}>
                  <p className="worktree-path">{entry.path}</p>
                  <p>
                    {entry.branch ?? 'Detached HEAD'} · <code>{entry.head}</code>
                  </p>
                </li>
              ))}
            </ul>
          )}
          {pruneReview.report ? (
            <pre className="worktree-prune-report" aria-label="Git cleanup report">
              {pruneReview.report}
            </pre>
          ) : (
            <p>No stale worktree registrations need cleanup.</p>
          )}
          <div className="dialog-actions">
            <button disabled={!pruneReview.report} onClick={() => void prune()}>
              Confirm cleanup
            </button>
            <button
              ref={pruneCancel}
              onClick={() => {
                setPruneReview(undefined);
                setError('');
              }}
            >
              Cancel cleanup
            </button>
          </div>
        </fieldset>
      )}
      <ul aria-label="Registered worktrees">
        {state?.entries.map((entry) => (
          <li key={entry.id}>
            <strong>
              {entry.branch?.replace(/^refs\/heads\//, '') ??
                (entry.bare ? 'Bare repository' : 'Detached HEAD')}
            </strong>
            <p className="worktree-path">{entry.path}</p>
            {entry.head && <code>{entry.head.slice(0, 12)}</code>}
            <p>
              {entry.main ? 'Main · ' : ''}
              {entry.current ? 'Current · ' : ''}
              {entry.changedFiles === null
                ? entry.bare
                  ? 'No working files'
                  : 'Status unavailable'
                : entry.changedFiles === 0
                  ? 'Clean'
                  : `${entry.changedFiles} changed file${entry.changedFiles === 1 ? '' : 's'}`}
            </p>
            {entry.locked && <p>Locked{entry.lockReason ? ` · ${entry.lockReason}` : ''}</p>}
            {entry.prunable && <p>Prunable{entry.pruneReason ? ` · ${entry.pruneReason}` : ''}</p>}
            {entry.problem && <p>{entry.problem}</p>}
            <button
              disabled={pending || entry.current || !entry.available}
              onClick={() => void open(entry.id)}
            >
              Open worktree
            </button>
            {!entry.main && (
              <div className="dialog-actions">
                <button
                  disabled={pending}
                  onClick={(event) =>
                    chooseAction(entry, entry.locked ? 'unlock' : 'lock', event.currentTarget)
                  }
                >
                  {entry.locked ? 'Unlock worktree' : 'Lock worktree'}
                </button>
                <button
                  disabled={
                    pending ||
                    entry.current ||
                    entry.locked ||
                    !entry.available ||
                    entry.changedFiles !== 0
                  }
                  onClick={(event) => chooseAction(entry, 'remove', event.currentTarget)}
                >
                  Remove worktree
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button ref={pruneButton} disabled={pending || !state} onClick={() => void reviewPrune()}>
          Review cleanup
        </button>
        <button ref={refreshButton} disabled={pending} onClick={() => void load()}>
          Refresh worktrees
        </button>
        <button disabled={pending} onClick={close}>
          Close
        </button>
      </div>
    </dialog>
  );
}

export function WorktreesControl() {
  const { snapshot, busy } = useRepository();
  const [open, setOpen] = useState(false);
  return (
    <>
      <CommandButton
        command="repository.worktrees"
        disabled={!snapshot || !!busy}
        onClick={() => setOpen(true)}
      >
        Worktrees
      </CommandButton>
      {open && snapshot && (
        <WorktreeDialog repoId={snapshot.repository.id} close={() => setOpen(false)} />
      )}
    </>
  );
}
