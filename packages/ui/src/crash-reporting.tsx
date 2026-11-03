import { useEffect, useRef, useState } from 'react';
import type { CrashReportingState } from '@openkraken/ipc-contract';

function ReportingDialog({
  initial,
  onClose,
}: {
  initial: CrashReportingState;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'crashReportingSave',
        enabled,
        revision: state.revision,
      });
      if (result.kind !== 'crashReporting')
        throw new Error(
          result.kind === 'error' ? result.message : 'Crash reporting settings could not be saved.',
        );
      setState(result.state);
      setSaved(true);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Crash reporting settings could not be saved.',
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog crash-reporting-dialog"
      aria-label="Crash reporting"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <h2>Crash reporting</h2>
      <p>
        Off by default. You can choose to send summaries of process crashes and unhandled JavaScript
        failures.
      </p>
      <p>
        After an interrupted session, the next launch can send one unclean-exit summary. This can
        include a force-quit or power loss; it does not establish that the app crashed. Normal
        shutdown and opting out clear the local session marker.
      </p>
      <p>
        Reports contain only the app version, operating system, architecture, process type and
        failure category. They contain no code, paths, names, emails, logs, memory dumps or account
        data.
      </p>
      {state.destination ? (
        <p>
          Destination: <strong>{state.destination}</strong>. The receiver can see your IP address.
        </p>
      ) : (
        <p>This build has no crash-report destination. No reports are sent.</p>
      )}
      <p>
        At most five reports are attempted per launch. Failed reports are discarded. Turning this
        off stops new reports and cancels pending requests; reports already received cannot be
        withdrawn.
      </p>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving || !state.destination || !!state.warning}
          onChange={(event) => {
            setEnabled(event.target.checked);
            setSaved(false);
          }}
        />
        Send crash summaries
      </label>
      {state.warning && (
        <p role="alert">
          Saved reporting state cannot be verified. Reporting is off. Check the reporting settings
          and session data, then restart before enabling it.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">Crash reporting is {state.enabled ? 'on' : 'off'}.</p>}
      <div className="dialog-actions">
        <button
          onClick={() => void save()}
          disabled={saving || !state.destination || !!state.warning}
        >
          Apply
        </button>
        <button onClick={onClose} disabled={saving}>
          Close
        </button>
      </div>
    </dialog>
  );
}

export function CrashReporting() {
  const [state, setState] = useState<CrashReportingState>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const open = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'crashReporting',
      });
      if (result.kind !== 'crashReporting')
        throw new Error('Crash reporting settings could not be read.');
      setState(result.state);
    } catch {
      setError('Crash reporting settings could not be read. Restart to retry.');
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <button onClick={() => void open()} disabled={loading}>
        Crash reporting
      </button>
      {error && <span role="alert">{error}</span>}
      {state && <ReportingDialog initial={state} onClose={() => setState(undefined)} />}
    </>
  );
}
