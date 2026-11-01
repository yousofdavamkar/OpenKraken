import { useEffect, useRef, useState } from 'react';
import type { Ref, ReferenceOptions } from '@openkraken/ipc-contract';
import { useRepository, waitForBackground } from './store.js';
async function executeReference(repoId: string, options: ReferenceOptions) {
  if (useRepository.getState().syncing) await waitForBackground();
  if (useRepository.getState().snapshot?.repository.id !== repoId) return false;
  if (useRepository.getState().busy) return false;
  const id = crypto.randomUUID();
  useRepository.setState({ busy: id });
  try {
    const result = await window.openkraken.request({ id, method: 'reference', repoId, options });
    if (result.kind === 'error') throw new Error(result.message);
    if (result.kind === 'workingState') useRepository.setState({ workingState: result.state });
    return result.kind === 'workingState';
  } finally {
    useRepository.setState({ busy: undefined });
    if (useRepository.getState().snapshot?.repository.id === repoId)
      await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
  }
}
type Action = 'createBranch' | 'createTag' | 'deleteTag' | 'renameBranch';
function ReferenceDialog({
  action,
  target,
  reference,
  close,
}: {
  action: Action;
  target: string;
  reference?: Ref;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { snapshot, busy: active, syncing } = useRepository();
  const busy = syncing ? undefined : active;
  const [name, setName] = useState(reference?.shortName ?? '');
  const [message, setMessage] = useState('');
  const [sign, setSign] = useState(false);
  const [error, setError] = useState<string>();
  const title =
    action === 'createBranch'
      ? 'Create branch'
      : action === 'createTag'
        ? 'Create tag'
        : action === 'renameBranch'
          ? 'Rename branch'
          : 'Delete tag';
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const submit = async () => {
    if (!snapshot) return;
    const repoId = snapshot.repository.id;
    const options: ReferenceOptions =
      action === 'renameBranch'
        ? { action, name: reference!.shortName, newName: name, expected: target }
        : action === 'deleteTag'
          ? { action, name, expected: target }
          : action === 'createBranch'
            ? { action, name, target }
            : { action, name, target, ...(message ? { message } : {}), sign };
    setError(undefined);
    let success = false;
    try {
      success = await executeReference(repoId, options);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    if (success) close();
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>{title}</h2>
        {action === 'deleteTag' ? (
          <p>
            Delete local tag <strong>{name}</strong>? Undo can restore it. This does not delete a
            remote tag.
          </p>
        ) : (
          <label>
            {action === 'createBranch' || action === 'renameBranch' ? 'Branch name' : 'Tag name'}
            <input
              autoFocus
              required
              maxLength={1024}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={!!busy}
            />
          </label>
        )}
        <p>
          {action === 'deleteTag' ? 'Reviewed tag object' : 'Target commit'}: <code>{target}</code>
        </p>
        {action === 'createTag' && (
          <>
            <label>
              Tag annotation (optional)
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={65536}
                rows={5}
                disabled={!!busy}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={sign}
                disabled={!!busy || !message.trim()}
                onChange={(event) => setSign(event.target.checked)}
              />{' '}
              Sign tag with configured agent
            </label>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={close} disabled={!!busy}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!!busy || !name.trim() || (sign && !message.trim())}
            className={action === 'deleteTag' ? 'danger' : undefined}
          >
            {title}
          </button>
        </div>
      </form>
    </dialog>
  );
}
export function NewReferences() {
  const { snapshot, detail, selection, busy: active, syncing } = useRepository();
  const busy = syncing ? undefined : active;
  const [action, setAction] = useState<Action>();
  const [target, setTarget] = useState('');
  if (!snapshot) return null;
  const selected = detail?.oid ?? selection.focus;
  const oid =
    selected && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(selected)
      ? selected
      : snapshot.repository.head.oid;
  const show = (action: Action) => {
    if (oid) {
      setTarget(oid);
      setAction(action);
    }
  };
  return (
    <>
      <button disabled={!!busy || !oid} onClick={() => show('createBranch')}>
        New branch
      </button>
      <button disabled={!!busy || !oid} onClick={() => show('createTag')}>
        New tag
      </button>
      {action && (
        <ReferenceDialog action={action} target={target} close={() => setAction(undefined)} />
      )}
    </>
  );
}
export function ReferenceActions({ reference }: { reference: Ref }) {
  const { busy: active, syncing, snapshot } = useRepository();
  const busy = syncing ? undefined : active;
  const [error, setError] = useState<string>();
  const [reviewed, setReviewed] = useState<Ref>();
  if (reference.kind === 'local' && snapshot && !snapshot.repository.isBare)
    return (
      <>
        <button
          disabled={!!busy || reference.isHead}
          aria-label={`Switch to ${reference.shortName}`}
          onClick={() => {
            setError(undefined);
            void executeReference(snapshot.repository.id, {
              action: 'checkoutBranch',
              name: reference.shortName,
              expected: reference.target,
            }).catch((error: unknown) =>
              setError(error instanceof Error ? error.message : String(error)),
            );
          }}
        >
          {reference.isHead ? 'Current' : 'Switch'}
        </button>
        <button
          disabled={!!busy}
          aria-label={`Rename branch ${reference.shortName}`}
          onClick={() => setReviewed(reference)}
        >
          Rename
        </button>
        {reviewed && (
          <ReferenceDialog
            action="renameBranch"
            reference={reviewed}
            target={reviewed.target}
            close={() => setReviewed(undefined)}
          />
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </>
    );
  if (reference.kind !== 'tag') return null;
  return (
    <>
      <button
        disabled={!!busy}
        aria-label={`Delete tag ${reference.shortName}`}
        onClick={() => setReviewed(reference)}
      >
        Delete
      </button>
      {reviewed && (
        <ReferenceDialog
          action="deleteTag"
          reference={reviewed}
          target={reviewed.target}
          close={() => setReviewed(undefined)}
        />
      )}
    </>
  );
}
