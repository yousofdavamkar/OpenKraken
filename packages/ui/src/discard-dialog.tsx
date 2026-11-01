import { useEffect, useRef } from 'react';
import type { DiscardPreview } from '@openkraken/ipc-contract';
export function DiscardDialog({
  preview,
  busy,
  error,
  onApply,
  onClose,
  onCancel,
}: {
  preview: DiscardPreview;
  busy: boolean;
  error?: string;
  onApply: () => void;
  onClose: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="working-diff discard-review"
      aria-label="Discard working changes"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <h2>Discard these working changes?</h2>
      <p>
        Tracked files return to their staged contents. Untracked files move to application trash.
        Undo can restore the backed-up contents.
      </p>
      <ul>
        {preview.paths.map((path) => (
          <li key={path}>
            <code>{path}</code>
          </li>
        ))}
      </ul>
      <p>
        {preview.bytes.toLocaleString()} bytes will be backed up. Files are checked again before
        discarding.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="diff-actions">
        {busy ? (
          <button onClick={onCancel}>Cancel operation</button>
        ) : (
          <button onClick={onClose}>Keep changes</button>
        )}
        <button className="danger" disabled={busy} onClick={onApply}>
          Discard changes
        </button>
      </div>
    </dialog>
  );
}
