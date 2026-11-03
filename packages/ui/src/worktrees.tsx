import { useEffect, useRef, useState } from 'react';
import type { WorktreeAdd, WorktreeState } from '@openkraken/ipc-contract';
import { CommandButton } from './commands.js';
import { useRepository, waitForBackground } from './store.js';

function WorktreeDialog({ repoId, close }: { repoId: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<WorktreeState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const snapshot = useRepository((store) => store.snapshot);
  const [mode, setMode] = useState<WorktreeAdd['mode']>('new');
  const [branch, setBranch] = useState('');
  const [oid, setOid] = useState(snapshot?.repository.head.oid ?? '');
  const branches = snapshot?.refs.filter((ref) => ref.kind === 'local') ?? [];
  const load = async () => {
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
    setPending(true);
    setError('');
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
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button disabled={pending} onClick={() => void load()}>
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
