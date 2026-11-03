import { useEffect, useRef, useState } from 'react';
import type { RepositoryLink } from '@openkraken/ipc-contract';
import { useRepository } from './store.js';

export function RepositoryLinkControl() {
  const [link, setLink] = useState<RepositoryLink | null>(null);
  const [reviewing, setReviewing] = useState<string>();
  const [error, setError] = useState('');
  const [dismissing, setDismissing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRepository((state) => state.busy);
  const run = useRepository((state) => state.run);
  useEffect(() => {
    let live = true;
    let generation = 0;
    const read = async () => {
      const current = ++generation;
      try {
        const result = await window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'repositoryLink',
        });
        if (live && current === generation && result.kind === 'repositoryLink')
          setLink(result.link);
      } catch {
        if (live) setError('The repository link could not be read.');
      }
    };
    const unsubscribe = window.openkraken.subscribe((event) => {
      if (event.type === 'repositoryLinkChanged') void read();
    });
    void read();
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (link?.id === reviewing) dialog.current?.showModal();
  }, [link?.id, reviewing]);
  const dismiss = async () => {
    if (!link || dismissing) return;
    setDismissing(true);
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'repositoryLinkDismiss',
        linkId: link.id,
      });
      if (result.kind !== 'repositoryLink') throw new Error();
      setLink(result.link);
      setReviewing(undefined);
      setError('');
    } catch {
      setError('The repository link could not be dismissed.');
    } finally {
      setDismissing(false);
    }
  };
  if (!link) return null;
  return (
    <>
      <button disabled={!!busy} onClick={() => setReviewing(link.id)}>
        Review repository link
      </button>
      {reviewing === link.id && (
        <dialog
          ref={dialog}
          className="reference-dialog repository-link-dialog"
          aria-label="Open linked repository"
          onCancel={(event) => {
            event.preventDefault();
            void dismiss();
          }}
        >
          <h2>Open linked repository?</h2>
          <p>An external link asks OpenKraken to open this local folder:</p>
          <pre className="repository-link-path">{link.path}</pre>
          <p>Open it only if you recognize and trust this repository.</p>
          {error && <p role="alert">{error}</p>}
          <div className="dialog-actions">
            <button autoFocus disabled={dismissing} onClick={() => void dismiss()}>
              Cancel
            </button>
            <button
              disabled={!!busy || dismissing}
              onClick={() =>
                void run({ id: crypto.randomUUID(), method: 'repositoryLinkOpen', linkId: link.id })
              }
            >
              Open repository
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}
