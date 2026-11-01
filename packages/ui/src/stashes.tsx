import { useEffect, useRef, useState } from 'react';
import type { StashState, WorkingState, StashActionOptions } from '@openkraken/ipc-contract';
import { useRepository, waitForBackground } from './store.js';
function StashDialog({
  repoId,
  initial,
  close,
}: {
  repoId: string;
  initial: WorkingState;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [work, setWork] = useState(initial);
  const [stashes, setStashes] = useState<StashState>();
  const [selected, setSelected] = useState(
    new Set(initial.status.entries.map((entry) => entry.pathBytes)),
  );
  const [message, setMessage] = useState('');
  const [untracked, setUntracked] = useState(false);
  const [staged, setStaged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState('');
  const [restoreIndex, setRestoreIndex] = useState(false);
  const [dropping, setDropping] = useState<Extract<StashActionOptions, { action: 'drop' }>>();
  const [editing, setEditing] = useState<Extract<StashActionOptions, { action: 'rename' }>>();

  const load = async () => {
    const result = await window.openkraken.request({
      id: crypto.randomUUID(),
      method: 'stashes',
      repoId,
    });
    if (result.kind === 'error') throw new Error(result.message);
    if (result.kind === 'stashes') setStashes(result.state);
  };
  useEffect(() => {
    dialog.current?.showModal();
    void load().catch((e: unknown) => setError(String(e)));
  }, []);
  const entries = work.status.entries.filter(
    (entry) => (untracked || entry.kind !== 'untracked') && (!staged || entry.index !== '.'),
  );
  const paths = entries
    .filter((entry) => staged || selected.has(entry.pathBytes))
    .map((entry) => entry.pathBytes);
  const submit = async (action?: StashActionOptions) => {
    setPending(true);
    setError(undefined);
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
        action
          ? { id, method: 'stashAction', repoId, options: action }
          : {
              id,
              method: 'stashPush',
              repoId,
              options: {
                revision: work.revision,
                message,
                includeUntracked: untracked,
                stagedOnly: staged,
                ...(staged ? {} : { paths }),
              },
            },
      );
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'stashAction') {
        setWork(result.state);
        setStashes(result.stashes);
        useRepository.setState({ workingState: result.state });
        setSelected(new Set(result.state.status.entries.map((entry) => entry.pathBytes)));
        setDropping(undefined);
        setEditing(undefined);
        setNotice(
          result.warning ??
            (action?.action === 'rename'
              ? 'Stash message updated'
              : action?.action === 'drop'
                ? 'Stash removed'
                : 'Stash applied'),
        );
      }
      if (result.kind === 'workingState') {
        setWork(result.state);
        useRepository.setState({ workingState: result.state });
        setMessage('');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      if (id && useRepository.getState().snapshot?.repository.id === repoId)
        await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
      await load().catch(() => {});
      setPending(false);
    }
  };
  const reload = async () => {
    setDropping(undefined);
    setEditing(undefined);
    setPending(true);
    setError(undefined);
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'workingState',
        repoId,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'workingState') {
        setWork(result.state);
        setSelected(new Set(result.state.status.entries.map((entry) => entry.pathBytes)));
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog stash-dialog"
      aria-label="Stashes"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) close();
      }}
    >
      <h2>Stashes</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          Stash message
          <input
            value={message}
            maxLength={4096}
            disabled={pending}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={untracked}
            disabled={pending || staged}
            onChange={(event) => setUntracked(event.target.checked)}
          />{' '}
          Include untracked files
        </label>
        <label>
          <input
            type="checkbox"
            checked={staged}
            disabled={pending}
            onChange={(event) => {
              setStaged(event.target.checked);
              if (event.target.checked) setUntracked(false);
            }}
          />{' '}
          All staged changes only
        </label>
        <fieldset disabled={pending}>
          <legend>{staged ? 'All staged files' : 'Selected files'}</legend>
          {entries.map((entry) => (
            <label key={entry.pathBytes}>
              <input
                type="checkbox"
                aria-label={`Stash ${entry.path}`}
                checked={staged || selected.has(entry.pathBytes)}
                disabled={staged}
                onChange={(event) =>
                  setSelected((previous) => {
                    const next = new Set(previous);
                    if (event.target.checked) next.add(entry.pathBytes);
                    else next.delete(entry.pathBytes);
                    return next;
                  })
                }
              />{' '}
              {entry.path}
            </label>
          ))}
          {!entries.length && <p>No matching changes.</p>}
        </fieldset>
        <p>Undo restores your workspace and keeps the saved stash.</p>
        <button disabled={pending || !paths.length}>Stash selected files</button>
      </form>
      <h3>Saved stashes</h3>
      <label>
        <input
          type="checkbox"
          checked={restoreIndex}
          disabled={pending}
          onChange={(event) => setRestoreIndex(event.target.checked)}
        />{' '}
        Restore staged state when applying
      </label>
      <p>
        Apply and pop use Git's merge behavior and have no workspace Undo. A conflicted pop keeps
        its stash.
      </p>
      {stashes?.entries.map((entry) => {
        const selection = { selector: entry.selector, oid: entry.oid, token: stashes.token };
        return (
          <section className="stash-entry" key={entry.selector}>
            <strong>{entry.selector}</strong>
            <p>{entry.subject}</p>
            <code>{entry.oid}</code>
            <div className="dialog-actions">
              <button
                disabled={pending}
                aria-label={`Apply ${entry.selector}`}
                onClick={() => void submit({ action: 'apply', ...selection, restoreIndex })}
              >
                Apply
              </button>
              <button
                disabled={pending}
                aria-label={`Apply and remove ${entry.selector}`}
                onClick={() => void submit({ action: 'pop', ...selection, restoreIndex })}
              >
                Apply and remove
              </button>
              <button
                disabled={pending}
                aria-label={`Rename ${entry.selector}`}
                onClick={() => {
                  setEditing({ action: 'rename', ...selection, message: entry.subject });
                  setDropping(undefined);
                }}
              >
                Rename
              </button>
              <button
                disabled={pending}
                aria-label={`Drop ${entry.selector}`}
                onClick={() => {
                  setDropping({ action: 'drop', ...selection });
                  setEditing(undefined);
                }}
              >
                Drop
              </button>
            </div>
          </section>
        );
      })}
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(editing);
          }}
        >
          <label>
            New stash message
            <input
              value={editing.message}
              disabled={pending}
              maxLength={4096}
              required
              onChange={(event) => setEditing({ ...editing, message: event.target.value })}
            />
          </label>
          <p>Renaming preserves the saved trees and moves this stash to the top.</p>
          <button disabled={pending || !editing.message.trim()}>Save stash message</button>{' '}
          <button type="button" disabled={pending} onClick={() => setEditing(undefined)}>
            Cancel rename
          </button>
        </form>
      )}
      {dropping && (
        <section aria-label="Confirm stash drop">
          <p>Drop {dropping.selector}? This removes the saved copy and has no Undo.</p>
          <code>{dropping.oid}</code>
          <div className="dialog-actions">
            <button disabled={pending} onClick={() => setDropping(undefined)}>
              Keep stash
            </button>
            <button className="danger" disabled={pending} onClick={() => void submit(dropping)}>
              Confirm drop
            </button>
          </div>
        </section>
      )}
      {notice && <p role="status">{notice}</p>}
      {stashes && !stashes.entries.length && <p>No saved stashes.</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button disabled={pending} onClick={() => void reload()}>
          Reload
        </button>
        <button disabled={pending} onClick={close}>
          Close
        </button>
      </div>
    </dialog>
  );
}
export function Stashes() {
  const { snapshot, workingState, busy, syncing } = useRepository();
  const [opened, setOpened] = useState<WorkingState>();
  if (!snapshot || snapshot.repository.isBare) return null;
  return (
    <>
      <button
        disabled={!workingState || (!!busy && !syncing)}
        onClick={() => setOpened(workingState)}
      >
        Stashes
      </button>
      {opened && (
        <StashDialog
          key={snapshot.repository.id}
          repoId={snapshot.repository.id}
          initial={opened}
          close={() => setOpened(undefined)}
        />
      )}
    </>
  );
}
