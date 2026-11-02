import { useEffect, useRef, useState } from 'react';
import type { Snapshot, StartOperation, WorkingState } from '@openkraken/ipc-contract';
import { useRepository, waitForBackground } from './store.js';
import { GitProgress } from './git-progress.js';
function IntegrationDialog({
  snapshot,
  state,
  selected,
  close,
}: {
  snapshot: Snapshot;
  state: WorkingState;
  selected?: string;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<'merge' | 'rebase'>('merge');
  const [mode, setMode] = useState<'ff' | 'no-ff' | 'squash'>('ff');
  const choices = snapshot.refs.filter(
    (ref) => ref.objectType === 'commit' || ref.peeledType === 'commit',
  );
  const [target, setTarget] = useState(selected ?? choices[0]?.peeled ?? choices[0]?.target ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const submit = async () => {
    const repoId = snapshot.repository.id;
    setPending(true);
    setError('');
    let id: string | undefined;
    let success = false;
    try {
      if (useRepository.getState().syncing) await waitForBackground();
      if (useRepository.getState().snapshot?.repository.id !== repoId) return;
      if (useRepository.getState().busy)
        throw new Error('Wait for the current operation to finish');
      id = crypto.randomUUID();
      useRepository.setState({ busy: id });
      const options: StartOperation =
        kind === 'merge'
          ? { kind, mode, target, revision: state.revision }
          : { kind, target, revision: state.revision };
      const result = await window.openkraken.request({
        id,
        method: 'startOperation',
        repoId,
        options,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'cancelled')
        setError('Operation cancelled. Close this dialog to review the refreshed Git state.');
      success = result.kind === 'workingState';
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      if (id && useRepository.getState().snapshot?.repository.id === repoId)
        await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
      setPending(false);
      if (success) close();
    }
  };
  return (
    <dialog
      ref={dialog}
      aria-label="Merge or rebase"
      className="reference-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>Merge or rebase</h2>
        <p>
          Current {state.head.kind === 'branch' ? state.head.ref.slice(11) : 'detached HEAD'}:{' '}
          <code>{state.head.oid}</code>
        </p>
        <label>
          Operation
          <select
            disabled={pending}
            value={kind}
            onChange={(event) => setKind(event.target.value === 'merge' ? 'merge' : 'rebase')}
          >
            <option value="merge">Merge</option>
            <option value="rebase">Rebase current branch</option>
          </select>
        </label>
        <label>
          Target commit
          <select
            disabled={pending}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            {selected && <option value={selected}>Selected commit {selected.slice(0, 12)}</option>}
            {choices.map((ref) => (
              <option key={ref.name} value={ref.peeled ?? ref.target}>
                {ref.shortName}
              </option>
            ))}
          </select>
        </label>
        <p>
          Reviewed target: <code>{target}</code>
        </p>
        {kind === 'merge' && (
          <label>
            Merge mode
            <select
              disabled={pending}
              value={mode}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'ff' || value === 'no-ff' || value === 'squash') setMode(value);
              }}
            >
              <option value="ff">Fast-forward when possible</option>
              <option value="no-ff">Always create a merge commit</option>
              <option value="squash">Squash into staged changes</option>
            </select>
          </label>
        )}
        <p>
          {kind === 'rebase'
            ? 'Replay the current branch on the target commit. This changes commit IDs.'
            : mode === 'squash'
              ? 'Stage the combined changes for you to review and commit.'
              : 'Integrate the target into the current branch.'}
        </p>
        <p>
          Commit or stash tracked edits first. If conflicts occur, close this dialog to resolve them
          or abort the operation.
        </p>
        <GitProgress />
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          {pending && (
            <button type="button" onClick={() => void useRepository.getState().cancel()}>
              Cancel operation
            </button>
          )}
          <button type="button" disabled={pending} onClick={close}>
            Close
          </button>
          <button disabled={pending || !target}>Start {kind}</button>
        </div>
      </form>
    </dialog>
  );
}
export function Integration() {
  const { snapshot, workingState, detail, selection, busy, syncing } = useRepository();
  const [review, setReview] = useState<{
    snapshot: Snapshot;
    state: WorkingState;
    selected?: string;
  }>();
  if (!snapshot || snapshot.repository.isBare) return null;
  const selected = detail?.oid ?? selection.focus;
  return (
    <>
      <button
        disabled={
          (!!busy && !syncing) ||
          !workingState?.head.oid ||
          (!!workingState.operation && workingState.operation.kind !== 'none')
        }
        onClick={() => {
          if (workingState)
            setReview({
              snapshot,
              state: workingState,
              selected:
                selected && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(selected) ? selected : undefined,
            });
        }}
      >
        Merge or rebase
      </button>
      {review && <IntegrationDialog {...review} close={() => setReview(undefined)} />}
    </>
  );
}
