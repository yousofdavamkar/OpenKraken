import { useEffect, useRef, useState } from 'react';
import type { RemoteOptions, RemoteState } from '@openkraken/ipc-contract';
import { useRepository, waitForBackground } from './store.js';
function RemoteDialog({ repoId, close }: { repoId: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<RemoteState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const load = async () => {
    setPending(true);
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'remotes',
        repoId,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'remotes') {
        setState(result.state);
        setError(undefined);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    dialog.current?.showModal();
    void load();
  }, []);
  const change = async (options: RemoteOptions) => {
    setPending(true);
    setError(undefined);
    let id: string | undefined;
    try {
      if (useRepository.getState().syncing) await waitForBackground();
      if (useRepository.getState().snapshot?.repository.id !== repoId) return;
      if (useRepository.getState().busy)
        throw new Error('Wait for the current operation to finish');
      id = crypto.randomUUID();
      useRepository.setState({ busy: id });
      const result = await window.openkraken.request({ id, method: 'remote', repoId, options });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'remotes') {
        setState(result.state);
        setRemoving(undefined);
        setEditing(undefined);
        setName('');
        setUrl('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      if (id && useRepository.getState().snapshot?.repository.id === repoId)
        await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
      setPending(false);
    }
  };
  const token = state?.token ?? '';
  return (
    <dialog
      ref={dialog}
      className="reference-dialog remote-dialog"
      aria-label="Manage remotes"
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) close();
      }}
    >
      <h2>Manage remotes</h2>
      {state?.remotes.map((remote) => (
        <section key={remote.name} className="remote-entry">
          <h3>{remote.name}</h3>
          <div>
            Fetch:{' '}
            {remote.urls.map((value, i) => (
              <code key={i}>{value}</code>
            ))}
          </div>
          <div>
            Push:{' '}
            {(remote.pushUrls.length ? remote.pushUrls : remote.urls).map((value, i) => (
              <code key={i}>{value}</code>
            ))}
          </div>
          <button
            disabled={pending}
            aria-label={`Edit ${remote.name}`}
            onClick={() => {
              setEditing(remote.name);
              setName(remote.name);
              setUrl('');
              setRemoving(undefined);
            }}
          >
            Edit
          </button>{' '}
          <button
            disabled={pending}
            aria-label={`Remove ${remote.name}`}
            onClick={() => setRemoving(remote.name)}
          >
            Remove
          </button>
        </section>
      ))}
      {removing && (
        <section aria-label="Confirm remote removal">
          <p>Remove {removing} and its local tracking refs?</p>
          <p>The server repository stays intact. This operation has no Undo.</p>
          <button disabled={pending} onClick={() => setRemoving(undefined)}>
            Keep remote
          </button>{' '}
          <button
            className="danger"
            disabled={pending}
            onClick={() => void change({ action: 'remove', name: removing, token })}
          >
            Confirm removal
          </button>
        </section>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!editing) void change({ action: 'add', name, url, token });
        }}
      >
        <h3>{editing ? `Edit ${editing}` : 'Add remote'}</h3>
        <label>
          Remote name
          <input
            value={name}
            disabled={pending}
            maxLength={1024}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Repository URL or path
          <input
            value={url}
            disabled={pending}
            maxLength={32768}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://host/owner/repository.git"
          />
        </label>
        <p>Use your credential helper or SSH agent for authentication.</p>
        {editing ? (
          <div className="dialog-actions">
            <button
              type="button"
              disabled={pending || !name.trim() || name === editing}
              onClick={() => void change({ action: 'rename', name: editing, newName: name, token })}
            >
              Rename remote
            </button>
            <button
              type="button"
              disabled={pending || !url.trim()}
              onClick={() => void change({ action: 'setUrl', name: editing, url, token })}
            >
              Set fetch URL
            </button>
            <button
              type="button"
              disabled={pending || !url.trim()}
              onClick={() =>
                void change({ action: 'setUrl', name: editing, url, push: true, token })
              }
            >
              Set push URL
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setEditing(undefined);
                setName('');
                setUrl('');
              }}
            >
              Cancel edit
            </button>
          </div>
        ) : (
          <button disabled={pending || !state || !name.trim() || !url.trim()}>Add remote</button>
        )}
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button disabled={pending} onClick={() => void load()}>
          Reload remotes
        </button>
        <button disabled={pending} onClick={close}>
          Close
        </button>
      </div>
    </dialog>
  );
}
export function ManageRemotes() {
  const { snapshot, busy, syncing } = useRepository();
  const [opened, setOpened] = useState(false);
  if (!snapshot) return null;
  return (
    <>
      <button disabled={!!busy && !syncing} onClick={() => setOpened(true)}>
        Manage remotes
      </button>
      {opened && (
        <RemoteDialog
          key={snapshot.repository.id}
          repoId={snapshot.repository.id}
          close={() => setOpened(false)}
        />
      )}
    </>
  );
}
