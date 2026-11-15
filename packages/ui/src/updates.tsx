import { useEffect, useRef, useState } from 'react';
import type { UpdateState } from '@openkraken/ipc-contract';

const failures: Record<NonNullable<UpdateState['error']>, string> = {
  save: 'The installer could not be saved. Choose a writable location and keep the installer extension.',
  network: 'The update server could not be reached securely. Try checking again.',
  'invalid-release': 'The release signature or validity period could not be verified.',
  rollback: 'The server returned older or conflicting release metadata. The update was rejected.',
  storage: 'Update storage is unavailable or changed outside the app. Restart before trying again.',
  integrity: 'The download did not match the signed release. The incomplete file was discarded.',
  cancelled: 'Update transfer cancelled.',
  timeout: 'The update transfer timed out. Try checking again.',
  'unchanged-image':
    'This release contains the installed AppImage. Check again after the publisher corrects the release.',
  installation:
    'The update could not be prepared or confirmed. Existing recovery files were retained.',
};

function updateStatus(state?: UpdateState): string {
  if (!state) return 'Loading update status…';
  if (state.error) return failures[state.error];
  switch (state.phase) {
    case 'preparing':
      return 'Verifying and preparing the update…';
    case 'restart-ready':
      return 'The update is ready. Waiting for restart approval…';
    case 'installed':
      return 'Update installed. Restarting…';
    case 'disabled':
      return 'This build has no update feed configured.';
    case 'checking':
      return 'Checking the release signature…';
    case 'current':
      return 'You are up to date with the signed release feed.';
    case 'unsupported':
      return `Version ${state.version} has no download for this platform.`;
    case 'available':
      return `Version ${state.version} is available.`;
    case 'downloading':
      return `Downloading version ${state.version}…`;
    case 'verified':
      return `Version ${state.version} download verified. ${state.installId ? 'Ready to install and restart.' : 'Choose where to save the installer.'}`;
    case 'saving':
      return 'Verifying and saving the installer…';
    case 'saved':
      return `Version ${state.version} installer saved.`;
    case 'error':
      return failures.network;
    case 'idle':
      return 'Check for a newer signed release.';
  }
}

function UpdatesDialog({
  onClose,
  onState,
}: {
  onClose: () => void;
  onState: (state: UpdateState) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<UpdateState>();
  const [error, setError] = useState('');
  const [dispatching, setDispatching] = useState(false);
  const [pendingAutomatic, setPendingAutomatic] = useState<boolean | null>(null);
  const preferenceChange = useRef(0);
  const savingAutomatic = pendingAutomatic !== null;
  useEffect(() => {
    dialog.current?.showModal();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const generation = preferenceChange.current;
      try {
        const result = await window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'updatesRead',
        });
        if (result.kind !== 'updates') throw new Error('Unavailable');
        if (!stopped && generation === preferenceChange.current) {
          setState(result.state);
          onState(result.state);
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
  }, [onState]);
  const saveAutomatic = async (enabled: boolean) => {
    if (!state) return;
    preferenceChange.current++;
    setPendingAutomatic(enabled);
    setError('');
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'updatesAutomatic',
        enabled,
        revision: state.automatic.revision,
      });
      if (result.kind === 'error') {
        setError(result.message);
        return;
      }
      if (result.kind !== 'updates') throw new Error('Unavailable');
      setState(result.state);
      onState(result.state);
    } catch {
      setError('Automatic update settings could not be saved.');
    } finally {
      preferenceChange.current++;
      setPendingAutomatic(null);
    }
  };
  const act = async (
    method:
      | 'updatesCheck'
      | 'updatesCancel'
      | 'updatesDownload'
      | 'updatesSave'
      | 'updatesInstall'
      | 'updatesDismissRecovery',
    format?: UpdateState['selected'],
  ) => {
    setDispatching(true);
    setError('');
    try {
      const id = crypto.randomUUID();
      let result;
      switch (method) {
        case 'updatesInstall':
          if (!state?.installId) return;
          result = await window.openkraken.request({ id, method, installId: state.installId });
          break;
        case 'updatesSave':
          if (!state?.saveId) return;
          result = await window.openkraken.request({ id, method, saveId: state.saveId });
          break;
        case 'updatesDownload':
          if (!format) return;
          result = await window.openkraken.request({ id, method, format });
          break;
        default:
          result = await window.openkraken.request({ id, method });
      }
      if (result.kind === 'error') {
        setError(result.message);
        return;
      }
      if (result.kind !== 'updates') throw new Error('Unavailable');
      setState(result.state);
      onState(result.state);
    } catch {
      setError('The update request could not be completed.');
    } finally {
      setDispatching(false);
    }
  };
  const running = state && ['checking', 'downloading', 'preparing', 'saving'].includes(state.phase);
  const status = updateStatus(state);
  return (
    <dialog
      ref={dialog}
      className="reference-dialog updates-dialog"
      aria-label="App updates"
      onCancel={onClose}
    >
      <h2>App updates</h2>
      {state?.channel === 'beta' && <p>Beta channel · This build receives prerelease updates.</p>}
      <p>
        Checking contacts the release server. Repository contents and account information are not
        sent.
      </p>
      {state?.automatic.host && (
        <div className="automatic-updates">
          <label>
            <input
              type="checkbox"
              checked={pendingAutomatic ?? state.automatic.enabled}
              disabled={
                savingAutomatic ||
                !!state.automatic.warning ||
                state.error === 'storage' ||
                ['preparing', 'restart-ready', 'installed'].includes(state.phase)
              }
              onChange={(event) => void saveAutomatic(event.target.checked)}
            />{' '}
            Automatically check every 10 hours
          </label>
          <p>
            Checks contact {state.automatic.host} while OpenKraken is open. Downloads and
            installation require your action.
          </p>
          {savingAutomatic && <p>Saving update preference…</p>}
          {state.automatic.warning && (
            <p role="alert">
              Automatic checks stopped because their settings are unavailable or changed. Restart
              and review the setting before enabling them again.
            </p>
          )}
        </div>
      )}
      <p role="status">{status}</p>
      {state?.recovery === 'restored' && (
        <div className="automatic-updates">
          <p role="alert">An update failed to start and the previous version was restored.</p>
          <button disabled={dispatching} onClick={() => void act('updatesDismissRecovery')}>
            Dismiss recovery notice
          </button>
        </div>
      )}
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
        {state?.phase === 'verified' && state.saveId && (
          <button disabled={dispatching} onClick={() => void act('updatesSave')}>
            Save installer…
          </button>
        )}
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
            disabled={dispatching && state?.phase !== 'preparing' && state?.phase !== 'saving'}
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
  const [state, setState] = useState<UpdateState>();
  useEffect(() => {
    if (open) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = await window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'updatesRead',
        });
        if (!stopped && result.kind === 'updates') {
          setState(result.state);
          if (result.state.automatic.enabled) timer = setTimeout(() => void read(), 30_000);
        }
      } catch {
        /* Keep the Updates button available if status cannot be read. */
      }
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [open, state?.automatic.enabled]);
  const available =
    state?.recovery === 'restored'
      ? 'An update failed to start; the previous version was restored'
      : state?.version &&
          ['available', 'downloading', 'verified', 'preparing', 'restart-ready'].includes(
            state.phase,
          )
        ? `OpenKraken ${state.version} is available`
        : undefined;
  return (
    <>
      <button
        aria-label="Updates"
        aria-describedby={available ? 'update-available-notice' : undefined}
        title={available}
        onClick={() => setOpen(true)}
      >
        Updates{available && <span aria-hidden="true"> •</span>}
      </button>
      <span id="update-available-notice" className="sr-only" aria-live="polite">
        {available}
      </span>
      {open && <UpdatesDialog onClose={() => setOpen(false)} onState={setState} />}
    </>
  );
}
