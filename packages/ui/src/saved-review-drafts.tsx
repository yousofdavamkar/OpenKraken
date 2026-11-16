import { useEffect, useRef, useState } from 'react';
import type {
  ProviderCommentTarget,
  ReviewDraft,
  ReviewDraftScope,
} from '@openkraken/ipc-contract';

type Scope = ReviewDraftScope | Pick<ReviewDraftScope, 'accountId'>;
type Entry = { scope: ReviewDraftScope; target: Target };
type Target = ProviderCommentTarget | null;
function label(target: Target) {
  if (!target) return 'Pull-request review';
  if (target.kind === 'reply') return `Reply to thread #${target.commentId}`;
  return `${target.path} · ${target.side} line ${target.line}`;
}
function DraftList({ scope, close }: { scope: Scope; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [entries, setEntries] = useState<Entry[]>();
  const [preview, setPreview] = useState<
    Entry & {
      draft: ReviewDraft;
      revision: string;
    }
  >();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [initial] = useState(scope);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let live = true;
    void window.openkraken
      .request({ id: crypto.randomUUID(), method: 'reviewDraftList', scope: initial })
      .then((result) => {
        if (!live) return;
        if (result.kind !== 'reviewDraftList') throw new Error('Saved drafts could not be listed.');
        setEntries(result.entries);
        if (result.unreadable) setError('Some local drafts could not be read.');
      })
      .catch(() => {
        if (live) setError('Saved drafts could not be listed.');
      });
    return () => {
      live = false;
    };
  }, [initial, attempt]);
  const open = async ({ scope, target }: Entry) => {
    setBusy(true);
    setPreview(undefined);
    setConfirm(false);
    setError('');
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'reviewDraftRead',
        scope,
        target,
      });
      if (result.kind !== 'reviewDraft' || !result.revision || !result.draft) throw new Error();
      setPreview({ scope, target, draft: result.draft, revision: result.revision });
    } catch {
      setError('This draft could not be opened.');
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'reviewDraftSave',
        scope: preview.scope,
        target: preview.target,
        revision: preview.revision,
        draft: null,
      });
      if (result.kind !== 'reviewDraft') throw new Error();
      setPreview(undefined);
      setConfirm(false);
      setEntries(undefined);
      setAttempt((n) => n + 1);
    } catch {
      setError('Discard failed. Reopen the draft to check its current contents.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog"
      aria-label="Saved review drafts"
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) close();
      }}
    >
      <h2>Saved review drafts</h2>
      {'repository' in initial && (
        <p>
          {initial.repository.owner}/{initial.repository.name} #{initial.number}
        </p>
      )}
      {entries?.length === 0 && (
        <p>
          {'repository' in initial
            ? 'No saved drafts for this pull request.'
            : 'No saved review drafts for this account.'}
        </p>
      )}
      {entries?.map((entry) => (
        <button key={JSON.stringify(entry)} disabled={busy} onClick={() => void open(entry)}>
          {!('repository' in initial) &&
            `${entry.scope.repository.owner}/${entry.scope.repository.name} #${entry.scope.number} · `}
          {label(entry.target)}
        </button>
      ))}
      {preview && (
        <>
          <p>
            {preview.draft.event.replaceAll('_', ' ')} · {preview.draft.source.head}
          </p>
          {preview.draft.uncertain && <p>The provider may have received this submission.</p>}
          <textarea aria-label="Saved review text" readOnly value={preview.draft.body} />
          {confirm ? (
            <button disabled={busy} onClick={() => void discard()}>
              Confirm discard
            </button>
          ) : (
            <button disabled={busy} onClick={() => setConfirm(true)}>
              Discard draft
            </button>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy} onClick={close}>
        Close
      </button>
    </dialog>
  );
}
export function SavedReviewDrafts({ scope }: { scope: Scope }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Saved review drafts</button>
      {open && <DraftList scope={scope} close={() => setOpen(false)} />}
    </>
  );
}
