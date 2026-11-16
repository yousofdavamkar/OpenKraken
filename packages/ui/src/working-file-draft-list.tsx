import { useEffect, useRef, useState } from 'react';
import type { NativeDraftEntry } from '@openkraken/ipc-contract';
import { WorkingFileDraftSession } from './working-file-draft.js';

type Entry = { path: string; pathBytes: string; editor?: 'conflict' } | NativeDraftEntry;
const entryKey = (entry: Entry) =>
  entry.editor === 'git' ? 'git:' + entry.promptId : `${entry.editor ?? 'file'}:${entry.pathBytes}`;

export function WorkingFileDraftList({ repoId, onClose }: { repoId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef<WorkingFileDraftSession | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<{ entry: Entry; text: string; revision?: string }>();
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
    try {
      if (entry.editor === 'git') {
        const result = await window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'nativeDraftRead',
          repoId,
          promptId: entry.promptId,
        });
        if (result.kind !== 'nativeDraftText')
          throw new Error(
            result.kind === 'error' ? result.message : 'The saved document could not be read.',
          );
        setSelected({ entry, text: result.text, revision: result.revision });
      } else {
        const session = new WorkingFileDraftSession();
        active.current = session;
        const draft =
          entry.editor === 'conflict'
            ? await session.openConflict(repoId, entry.pathBytes, true)
            : await session.open(repoId, entry.pathBytes, true);
        if (!draft) throw new Error('This draft has already been cleared.');
        setSelected({ entry, text: draft.text });
      }
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
      if (selected.entry.editor === 'git' && selected.revision) {
        const result = await window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'nativeDraftRemove',
          repoId,
          promptId: selected.entry.promptId,
          revision: selected.revision,
        });
        if (result.kind !== 'nativeDraftUpdated')
          throw new Error(
            result.kind === 'error' ? result.message : 'Draft removal was not confirmed.',
          );
      } else await active.current?.close(true);
      setEntries((rows) => rows.filter((row) => entryKey(row) !== entryKey(selected.entry)));
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
          <textarea readOnly aria-label="Recovered file text" rows={14} value={selected.text} />
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
              <li key={entryKey(entry)}>
                <button disabled={busy} onClick={() => void open(entry)}>
                  {entry.path}
                  {entry.editor === 'conflict' && ' (conflict resolution)'}
                  {entry.editor === 'git' &&
                    ` (Git editor, ${new Date(entry.updatedAt).toLocaleString()})`}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </dialog>
  );
}
