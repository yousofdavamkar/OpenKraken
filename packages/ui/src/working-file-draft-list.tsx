import { useEffect, useRef, useState } from 'react';
import type { WorkingFileDraft } from '@openkraken/ipc-contract';
import { WorkingFileDraftSession } from './working-file-draft.js';

type Entry = { path: string; pathBytes: string };
export function WorkingFileDraftList({ repoId, onClose }: { repoId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef<WorkingFileDraftSession | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<{ entry: Entry; draft: WorkingFileDraft }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    let live = true;
    void window.openkraken
      .request({ id: crypto.randomUUID(), method: 'workingDraftList', repoId })
      .then((result) => {
        if (!live) return;
        if (result.kind !== 'workingDraftList')
          throw new Error(result.kind === 'error' ? result.message : 'Could not list file drafts.');
        setEntries(result.entries);
        if (result.unreadable) setError('Some local draft files could not be read.');
      })
      .catch((error: unknown) => {
        if (live) setError(String(error));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
      void active.current?.close(false).catch(() => {});
    };
  }, [repoId]);
  const open = async (entry: Entry) => {
    setBusy(true);
    setError('');
    const session = new WorkingFileDraftSession();
    active.current = session;
    try {
      const draft = await session.open(repoId, entry.pathBytes, true);
      if (!draft) throw new Error('This draft has already been cleared.');
      setSelected({ entry, draft });
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await active.current?.close(true);
      setEntries((rows) => rows.filter((row) => row.pathBytes !== selected.entry.pathBytes));
      active.current = null;
      setSelected(undefined);
      setConfirm(false);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog"
      aria-label="Saved file drafts"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2>{selected ? selected.entry.path : 'Saved file drafts'}</h2>
        <button disabled={busy} onClick={onClose}>
          Close
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Loading…</p>}
      {selected ? (
        <>
          <textarea
            readOnly
            aria-label="Recovered file text"
            rows={14}
            value={selected.draft.text}
          />
          {confirm ? (
            <div className="dialog-actions">
              <p>Discard this saved draft?</p>
              <button disabled={busy} onClick={() => setConfirm(false)}>
                Keep draft
              </button>
              <button disabled={busy} onClick={() => void discard()}>
                Confirm discard
              </button>
            </div>
          ) : (
            <button disabled={busy} onClick={() => setConfirm(true)}>
              Discard draft
            </button>
          )}
        </>
      ) : (
        <>
          {!busy && !entries.length && !error && <p>No saved file drafts for this checkout.</p>}
          <ul>
            {entries.map((entry) => (
              <li key={entry.pathBytes}>
                <button disabled={busy} onClick={() => void open(entry)}>
                  {entry.path}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </dialog>
  );
}
