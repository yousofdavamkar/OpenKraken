import { useEffect, useRef, useState } from 'react';
import type { LfsState } from '@openkraken/ipc-contract';
import { CommandButton } from './commands.js';
import { useRepository } from './store.js';

function LfsDialog({ repoId, close }: { repoId: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<LfsState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(200);
  const owners = new Map<string, string[]>();
  for (const lock of state?.locks ?? []) {
    const existing = owners.get(lock.path);
    if (existing) existing.push(lock.owner ?? 'Unknown owner');
    else owners.set(lock.path, [lock.owner ?? 'Unknown owner']);
  }
  const load = async () => {
    setPending(true);
    setError('');
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'lfsState',
        repoId,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'lfsState') setState(result.state);
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
  return (
    <dialog
      ref={dialog}
      className="reference-dialog lfs-dialog"
      aria-label="Git LFS"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) close();
      }}
    >
      <h2>Git LFS</h2>
      <p>
        Large files are stored as pointers in Git. This view inspects local files and cached locks
        without downloading objects or contacting a lock server.
      </p>
      {error && <p role="alert">{error}</p>}
      {pending && <p role="status">Reading local LFS state…</p>}
      {state && !state.available && (
        <p>
          Git LFS is not available to OpenKraken. Install Git LFS, then restart OpenKraken and
          refresh. Pointer comparisons remain available.
        </p>
      )}
      {state?.available && (
        <>
          <p>{state.version}</p>
          <h3>Tracked files</h3>
          {!state.files.length && (
            <p>No LFS pointers were found in the current checkout’s index or HEAD.</p>
          )}
          <ul aria-label="LFS tracked files">
            {state.files.slice(0, visible).map((file) => (
              <li key={`${file.path}:${file.oid}`}>
                <h4>{file.path}</h4>
                <p>
                  {file.size.toLocaleString()} bytes · SHA-256 <code>{file.oid}</code>
                </p>
                <p>
                  {file.checkout ? 'Full content checked out' : 'Pointer or missing working file'} ·{' '}
                  {file.downloaded ? 'Object available locally' : 'Object missing locally'}
                </p>
                <p>
                  {owners.has(file.path)
                    ? `Cached lock: ${owners.get(file.path)!.join(', ')}`
                    : 'No cached lock'}{' '}
                  · Server lock state unknown
                </p>
              </li>
            ))}
          </ul>
          <h3>Cached locks</h3>
          <p>
            These are the last locks cached by Git LFS. Server ownership may have changed; an empty
            cache does not establish that files are unlocked.
          </p>
          {state.lockError && <p role="alert">Cached locks could not be read: {state.lockError}</p>}
          {!state.lockError && !state.locks.length && <p>No cached locks.</p>}
          <ul aria-label="Cached LFS locks">
            {state.locks.slice(0, visible).map((lock) => (
              <li key={lock.id}>
                <h4>{lock.path}</h4>
                <p>
                  {lock.owner ?? 'Unknown owner'}
                  {lock.lockedAt ? ` · ${lock.lockedAt}` : ''}
                </p>
              </li>
            ))}
          </ul>
          {(state.files.length > visible || state.locks.length > visible) && (
            <button onClick={() => setVisible(visible + 200)}>Show more LFS entries</button>
          )}
        </>
      )}
      <div className="dialog-actions">
        <button disabled={pending} onClick={() => void load()}>
          Refresh local state
        </button>
        <button disabled={pending} onClick={close}>
          Close
        </button>
      </div>
    </dialog>
  );
}
export function LfsControl() {
  const { snapshot, busy } = useRepository();
  const [open, setOpen] = useState(false);
  return (
    <>
      <CommandButton
        command="repository.lfs"
        disabled={!snapshot || snapshot.repository.isBare || !!busy}
        onClick={() => setOpen(true)}
      >
        Git LFS
      </CommandButton>
      {open && snapshot && (
        <LfsDialog repoId={snapshot.repository.id} close={() => setOpen(false)} />
      )}
    </>
  );
}
