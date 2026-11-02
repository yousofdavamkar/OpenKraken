import { useEffect, useRef, useState } from 'react';
import type { ResetPreview, ResetSelection, Snapshot } from '@openkraken/ipc-contract';
import { useRepository, waitForBackground } from './store.js';
function ResetDialog({
  snapshot,
  selected,
  close,
}: {
  snapshot: Snapshot;
  selected?: string;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const choices = snapshot.refs.filter(
    (ref) => ref.objectType === 'commit' || ref.peeledType === 'commit',
  );
  const [target, setTarget] = useState(selected ?? choices[0]?.peeled ?? choices[0]?.target ?? '');
  const [mode, setMode] = useState<ResetSelection['mode']>('soft');
  const [preview, setPreview] = useState<ResetPreview>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const execute = async (apply: boolean) => {
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
      const selection = { mode, target };
      const result = await window.openkraken.request(
        apply && preview
          ? { id, method: 'reset', repoId, selection, token: preview.token }
          : { id, method: 'resetPreview', repoId, selection },
      );
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'resetPreview') setPreview(result.preview);
      if (result.kind === 'cancelled')
        setError('Reset cancelled. Review the current state before trying again.');
      success = apply && result.kind === 'workingState';
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setPreview(undefined);
    } finally {
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      if (apply && id && useRepository.getState().snapshot?.repository.id === repoId)
        await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
      setPending(false);
      if (success) close();
    }
  };
  return (
    <dialog
      ref={dialog}
      aria-label="Reset current branch"
      className="reference-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) close();
      }}
    >
      <h2>Reset current branch</h2>
      <label>
        Target commit
        <select
          value={target}
          disabled={pending}
          onChange={(event) => {
            setTarget(event.target.value);
            setPreview(undefined);
          }}
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
        Target: <code>{target}</code>
      </p>
      <label>
        Reset mode
        <select
          value={mode}
          disabled={pending}
          onChange={(event) => {
            const mode = event.target.value;
            if (mode === 'soft' || mode === 'mixed' || mode === 'hard') {
              setMode(mode);
              setPreview(undefined);
            }
          }}
        >
          <option value="soft">Soft — keep staged and working changes</option>
          <option value="mixed">Mixed — reset staging, keep working files</option>
          <option value="hard">Hard — replace staging and working files</option>
        </select>
      </label>
      <p>
        {mode === 'hard'
          ? 'Discard working changes and replace files with the target tree. Files that would be overwritten are backed up for Undo.'
          : mode === 'mixed'
            ? 'Move HEAD and reset the index to the target. Working files remain as they are.'
            : 'Move HEAD to the target. Staged contents and working files remain as they are.'}
      </p>
      {preview && (
        <section aria-label="Reset review">
          <p>
            Reviewed {preview.head.kind === 'branch' ? preview.head.ref.slice(11) : 'detached HEAD'}
            : <code>{preview.head.oid}</code>
          </p>
          {mode === 'hard' && (
            <p>
              Backup: {preview.files} paths, {preview.bytes.toLocaleString()} bytes. Undo is
              available unless newer changes make restoration unsafe.
            </p>
          )}
        </section>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        {pending && (
          <button onClick={() => void useRepository.getState().cancel()}>Cancel operation</button>
        )}
        <button disabled={pending} onClick={close}>
          Close
        </button>
        <button disabled={pending || !target} onClick={() => void execute(!!preview)}>
          {preview ? 'Reset reviewed state' : 'Review reset'}
        </button>
      </div>
    </dialog>
  );
}
export function Reset() {
  const { snapshot, workingState, busy, syncing, detail, selection } = useRepository();
  const [review, setReview] = useState<{ snapshot: Snapshot; selected?: string }>();
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
        onClick={() =>
          setReview({
            snapshot,
            selected:
              selected && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(selected) ? selected : undefined,
          })
        }
      >
        Reset
      </button>
      {review && <ResetDialog {...review} close={() => setReview(undefined)} />}
    </>
  );
}
