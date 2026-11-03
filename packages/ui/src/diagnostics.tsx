import { useEffect, useRef, useState } from 'react';
import type { DiagnosticsState } from '@openkraken/ipc-contract';

function DiagnosticsDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const records = useRef<HTMLTextAreaElement>(null);
  const [state, setState] = useState<DiagnosticsState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async (clear = false) => {
    setBusy(true);
    setError('');
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: clear ? 'diagnosticsClear' : 'diagnosticsRead',
      });
      if (result.kind !== 'diagnostics') throw new Error('Local diagnostics are unavailable.');
      setState(result.state);
    } catch {
      setError('Diagnostic logs could not be read or completely cleared.');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    dialog.current?.showModal();
    void load();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="reference-dialog diagnostics-dialog"
      aria-label="Local diagnostics"
      onCancel={onClose}
    >
      <h2>Local diagnostics</h2>
      <p>
        These logs stay on this computer and are never uploaded automatically. Three rotating files
        retain up to 768 records.
      </p>
      <p>
        Records contain app and runtime information, operation names, durations, outcomes and fixed
        failure categories. Repository contents, paths, URLs, credentials and native output are
        excluded.
      </p>
      {state?.warning && (
        <p role="alert">
          Diagnostic storage is{' '}
          {state.warning === 'changed' ? 'changed outside the app' : 'unavailable'}. Logging has
          stopped for this session. Files that could not be safely updated were left in place.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {state && (
        <p role="status">
          {state.entries.length} retained records · {state.dropped} omitted this session
        </p>
      )}
      <textarea
        ref={records}
        aria-label="Diagnostic records"
        readOnly
        spellCheck={false}
        value={state ? JSON.stringify(state.entries, null, 2) : ''}
      />
      <div className="dialog-actions">
        <button
          disabled={busy || !state?.entries.length}
          onClick={() => {
            records.current?.focus();
            records.current?.select();
          }}
        >
          Select records to copy
        </button>
        <button disabled={busy} onClick={() => void load()}>
          Refresh
        </button>
        <button disabled={busy || !state || !!state.warning} onClick={() => void load(true)}>
          Clear logs
        </button>
        <button autoFocus onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}

export function DiagnosticsControl() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Diagnostics</button>
      {open && <DiagnosticsDialog onClose={() => setOpen(false)} />}
    </>
  );
}
