import { useEffect, useRef, useState } from 'react';
import type { DeleteRemotePlan } from '@openkraken/ipc-contract';
import { useRepository, waitForBackground } from './store.js';
import { GitProgress } from './git-progress.js';
function DeleteDialog({
  repoId,
  name,
  close,
}: {
  repoId: string;
  name: string;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState('heads');
  const [destination, setDestination] = useState('');
  const [plan, setPlan] = useState<DeleteRemotePlan>();
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const submit = async () => {
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
      const result = await window.openkraken.request(
        plan
          ? { id, method: 'deleteRemote', repoId, plan }
          : {
              id,
              method: 'deleteRemotePreview',
              repoId,
              selection: { name, destination: `refs/${kind}/${destination}` },
            },
      );
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'deleteRemotePreview') setPlan(result.plan);
      if (result.kind === 'remotes') {
        setComplete(true);
        setNotice('Remote ref deleted');
      }
      if (result.kind === 'cancelled')
        setNotice(
          'Cancelled. Review the server again before retrying; it may have received the deletion.',
        );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      if (id && plan && useRepository.getState().snapshot?.repository.id === repoId)
        await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
      setPending(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog"
      aria-label="Delete from remote"
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
        <h2>Delete from remote</h2>
        <p>Remote: {name}</p>
        <label>
          Ref type
          <select
            value={kind}
            disabled={pending || !!plan}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="heads">Branch</option>
            <option value="tags">Tag</option>
          </select>
        </label>
        <label>
          Branch or tag name
          <input
            autoFocus
            required
            maxLength={1000}
            value={destination}
            disabled={pending || !!plan}
            onChange={(event) => setDestination(event.target.value)}
          />
        </label>
        {plan && (
          <section aria-label="Reviewed remote deletion">
            <p>
              Delete <strong>{plan.destination}</strong> at {plan.url}?
            </p>
            <p>
              Server tip: <code>{plan.remoteOid}</code>
            </p>
            <p>
              This removes the server ref. Local branches and tags remain. There is no Undo. Git
              will refuse if the server tip changed since review.
            </p>
          </section>
        )}
        <GitProgress />
        {notice && <p role="status">{notice}</p>}
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
          {plan && (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setPlan(undefined);
                setComplete(false);
                setNotice('');
                setError('');
              }}
            >
              Review again
            </button>
          )}
          {!complete && (
            <button
              disabled={pending || !destination.trim()}
              className={plan ? 'danger' : undefined}
            >
              {plan ? 'Delete reviewed remote ref' : 'Review deletion'}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
export function DeleteRemoteRef({
  repoId,
  name,
  disabled,
  updated,
}: {
  repoId: string;
  name: string;
  disabled: boolean;
  updated: () => void;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <button
        disabled={disabled}
        aria-label={`Delete branch or tag from ${name}`}
        onClick={() => setOpened(true)}
      >
        Delete branch or tag
      </button>
      {opened && (
        <DeleteDialog
          repoId={repoId}
          name={name}
          close={() => {
            setOpened(false);
            updated();
          }}
        />
      )}
    </>
  );
}
