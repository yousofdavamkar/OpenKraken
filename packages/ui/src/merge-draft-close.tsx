import { useState } from 'react';

export function MergeDraftClose({
  keepEditing,
  save,
  discard,
  close,
}: {
  keepEditing: () => void;
  save: () => Promise<void>;
  discard: () => Promise<void>;
  close: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const finish = async (write: () => Promise<void>) => {
    setBusy(true);
    try {
      await write();
      close();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <>
      <button disabled={busy} onClick={keepEditing}>
        Keep editing
      </button>
      <button disabled={busy} onClick={() => void finish(save)}>
        Save and close
      </button>
      <button disabled={busy} onClick={() => void finish(discard)}>
        Discard draft
      </button>
      {failed && (
        <>
          <p role="alert">The local copy could not be changed. Copy your text before closing.</p>
          <button disabled={busy} onClick={close}>
            Close and leave saved copy
          </button>
        </>
      )}
    </>
  );
}
