import { useEffect, useRef, useState } from 'react';
import type { UpdateState } from '@openkraken/ipc-contract';

const failures: Record<NonNullable<UpdateState['error']>, string> = {
  network: 'The update server could not be reached securely. Try checking again.',
  'invalid-release': 'The release signature or validity period could not be verified.',
  rollback: 'The server returned older or conflicting release metadata. The update was rejected.',
  storage: 'Update storage is unavailable or changed outside the app. Restart before trying again.',
  integrity: 'The download did not match the signed release. The incomplete file was discarded.',
  cancelled: 'Update transfer cancelled.',
  timeout: 'The update transfer timed out. Try checking again.',
  installation:
    'The update could not be prepared or confirmed. Existing recovery files were retained.',
};

function UpdatesDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<UpdateState>();
  const [error, setError] = useState('');
  const [dispatching, setDispatching] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = await window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'updatesRead',
        });
        if (result.kind !== 'updates') throw new Error('Unavailable');
        if (!stopped) {
          setState(result.state);
        }
      } catch {
        if (!stopped) setError('Update status is unavailable.');
      }
      if (!stopped) timer = setTimeout(() => void read(), 500);
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  const act = async (
    method: 'updatesCheck' | 'updatesCancel' | 'updatesDownload' | 'updatesInstall',
    format?: UpdateState['selected'],
  ) => {
    setDispatching(true);
    setError('');
    try {
      const result =
        method === 'updatesInstall' && state?.installId
          ? await window.openkraken.request({
              id: crypto.randomUUID(),
              method,
              installId: state.installId,
            })
          : method === 'updatesDownload' && format
            ? await window.openkraken.request({ id: crypto.randomUUID(), method, format })
            : await window.openkraken.request({
                id: crypto.randomUUID(),
                method: method === 'updatesCancel' ? method : 'updatesCheck',
              });
      if (result.kind === 'error') {
        setError(result.message);
        return;
      }
      if (result.kind !== 'updates') throw new Error('Unavailable');
      setState(result.state);
    } catch {
      setError('The update request could not be completed.');
    } finally {
      setDispatching(false);
    }
  };
  const running =
    state?.phase === 'checking' || state?.phase === 'downloading' || state?.phase === 'preparing';
  const status = !state
    ? 'Loading update status…'
    : state.phase === 'preparing'
      ? 'Verifying and preparing the update…'
      : state.phase === 'restart-ready'
        ? 'The update is ready. Waiting for restart approval…'
        : state.phase === 'installed'
          ? 'Update installed. Restarting…'
          : state.phase === 'disabled'
            ? 'This build has no update feed configured.'
            : state.phase === 'checking'
              ? 'Checking the release signature…'
              : state.phase === 'current'
                ? 'You are up to date with the signed release feed.'
                : state.phase === 'unsupported'
                  ? `Version ${state.version} has no download for this platform.`
                  : state.phase === 'available'
                    ? `Version ${state.version} is available.`
                    : state.phase === 'downloading'
                      ? `Downloading version ${state.version}…`
                      : state.phase === 'verified'
                        ? `Version ${state.version} download verified. ${state.installId ? 'Ready to install and restart.' : 'Installation is not available in this build.'}`
                        : state.phase === 'error'
                          ? failures[state.error ?? 'network']
                          : 'Check for a newer signed release.';
  return (
    <dialog
      ref={dialog}
      className="reference-dialog updates-dialog"
      aria-label="App updates"
      onCancel={onClose}
    >
      <h2>App updates</h2>
      <p>
        Checking contacts the release server. Repository contents and account information are not
        sent.
      </p>
      <p role="status">{status}</p>
      {error && <p role="alert">{error}</p>}
      {state?.phase === 'downloading' && (
        <progress
          aria-label="Download progress"
          value={state.downloaded}
          max={state.artifacts.find((artifact) => artifact.format === state.selected)?.size ?? 1}
        />
      )}
      {running && <p>Transfers continue while this dialog is closed.</p>}
      <div className="dialog-actions">
        {state?.phase === 'verified' && state.installId && (
          <button disabled={dispatching} onClick={() => void act('updatesInstall')}>
            Install and restart
          </button>
        )}
        {state?.phase === 'available' &&
          state.artifacts.map((artifact) => (
            <button
              key={artifact.format}
              disabled={dispatching}
              onClick={() => void act('updatesDownload', artifact.format)}
            >
              Download {artifact.format}
            </button>
          ))}
        {running ? (
          <button
            disabled={dispatching && state?.phase !== 'preparing'}
            onClick={() => void act('updatesCancel')}
          >
            Cancel transfer
          </button>
        ) : (
          <button
            disabled={
              dispatching ||
              !state ||
              ['disabled', 'restart-ready', 'installed'].includes(state.phase) ||
              state.error === 'storage'
            }
            onClick={() => void act('updatesCheck')}
          >
            Check for updates
          </button>
        )}
        <button autoFocus onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}

export function UpdatesControl() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Updates</button>
      {open && <UpdatesDialog onClose={() => setOpen(false)} />}
    </>
  );
}
