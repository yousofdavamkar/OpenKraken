import { useEffect, useRef, useState } from 'react';
import type { AppearancePreferences } from '@openkraken/ipc-contract';
import { CommandButton } from './commands.js';
import { acceptAppearance } from './theme.js';
function AppearanceDialog({
  initial,
  onClose,
}: {
  initial: AppearancePreferences;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState(initial);
  const [mode, setMode] = useState(initial.mode);
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
        method: 'appearanceSave',
        revision: state.revision,
        mode,
      });
      if (result.kind !== 'appearancePreferences')
        throw new Error(
          result.kind === 'error' ? result.message : 'Appearance could not be saved.',
        );
      acceptAppearance(result.state);
      setState(result.state);
      setSaved(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog appearance-dialog"
      aria-label="Appearance"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <h2>Appearance</h2>
      <label>
        Color theme
        <select
          value={mode}
          disabled={saving}
          onChange={(event) => {
            setMode(event.target.value as AppearancePreferences['mode']);
            setSaved(false);
          }}
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="system">System</option>
        </select>
      </label>
      {mode === 'system' && <p>Follow your device’s light or dark preference.</p>}
      {state.warning && (
        <p role="alert">
          {state.warning === 'corrupt'
            ? 'Saved settings are damaged. Apply will preserve a backup before repairing them.'
            : 'Saved settings cannot be read. Check the settings file and restart before saving.'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">Appearance saved.</p>}
      <div className="dialog-actions">
        <button disabled={saving} onClick={onClose}>
          Close
        </button>
        <button disabled={saving || state.warning === 'unreadable'} onClick={() => void save()}>
          Apply
        </button>
      </div>
    </dialog>
  );
}
export function Appearance() {
  const [state, setState] = useState<AppearancePreferences>();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const open = async () => {
    if (opening || document.querySelector('dialog[open]')) return;
    setOpening(true);
    setError('');
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'appearancePreferences',
      });
      if (result.kind !== 'appearancePreferences')
        throw new Error('Appearance could not be loaded. Try again.');
      acceptAppearance(result.state);
      if (!document.querySelector('dialog[open]')) setState(result.state);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpening(false);
    }
  };
  return (
    <>
      <CommandButton command="app.appearance" disabled={opening} onClick={() => void open()}>
        Appearance
      </CommandButton>
      {error && <span role="alert">{error}</span>}
      {state && <AppearanceDialog initial={state} onClose={() => setState(undefined)} />}
    </>
  );
}
