import { useEffect, useRef, useState } from 'react';
import type { SubmoduleState } from '@openkraken/ipc-contract';
import { CommandButton } from './commands.js';
import { useRepository } from './store.js';

const labels = {
  clean: 'Clean',
  modified: 'Modified',
  'out-of-date': 'Out of date',
  uninitialized: 'Uninitialized',
  conflict: 'Index conflict',
  unavailable: 'Unavailable',
};
function SubmoduleDialog({ repoId, close }: { repoId: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<SubmoduleState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    setPending(true);
    setError('');
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'submodules',
        repoId,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'submodules') setState(result.state);
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
  const open = async (submoduleId: string) => {
    if (!state) return;
    setPending(true);
    setError('');
    await useRepository.getState().run({
      id: crypto.randomUUID(),
      method: 'openSubmodule',
      repoId,
      submoduleId,
      revision: state.revision,
    });
    if (useRepository.getState().snapshot?.repository.id !== repoId) close();
    else {
      setError(useRepository.getState().error ?? 'The submodule could not be opened');
      setPending(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog submodules-dialog"
      aria-label="Submodules"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) close();
      }}
    >
      <h2>Submodules</h2>
      <p>
        Each submodule is a separate repository pinned to a commit in its parent’s index. Nested
        checkouts are listed below their parent.
      </p>
      {error && <p role="alert">{error}</p>}
      {!state && (
        <p role="status">{pending ? 'Loading submodules…' : 'Submodules could not be loaded'}</p>
      )}
      {state?.entries.length === 0 && <p>No submodules are registered in this checkout’s index.</p>}
      <ul aria-label="Registered submodules">
        {state?.entries.map((entry) => (
          <li key={entry.id}>
            <h3 className="submodule-path">{entry.path}</h3>
            <p>
              {labels[entry.state]}
              {entry.changedFiles !== null && entry.changedFiles > 0
                ? ` · ${entry.changedFiles} changed file${entry.changedFiles === 1 ? '' : 's'}`
                : ''}
              {entry.depth > 0 ? ` · Nested level ${entry.depth}` : ''}
            </p>
            {entry.indexOid && (
              <p>
                Recorded commit <code>{entry.indexOid}</code>
              </p>
            )}
            {entry.head && (
              <p>
                Checked-out commit <code>{entry.head}</code>
              </p>
            )}
            {entry.url && <p className="submodule-path">Configured URL: {entry.url}</p>}
            {entry.problem && <p>{entry.problem}</p>}
            <button disabled={pending || !entry.available} onClick={() => void open(entry.id)}>
              Open submodule
            </button>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button disabled={pending} onClick={() => void load()}>
          Refresh submodules
        </button>
        <button disabled={pending} onClick={close}>
          Close
        </button>
      </div>
    </dialog>
  );
}
export function SubmodulesControl() {
  const { snapshot, busy } = useRepository();
  const [open, setOpen] = useState(false);
  return (
    <>
      <CommandButton
        command="repository.submodules"
        disabled={!snapshot || snapshot.repository.isBare || !!busy}
        onClick={() => setOpen(true)}
      >
        Submodules
      </CommandButton>
      {open && snapshot && (
        <SubmoduleDialog repoId={snapshot.repository.id} close={() => setOpen(false)} />
      )}
    </>
  );
}
