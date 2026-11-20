import { useEffect, useState } from 'react';
import type { MergeDraft, MergeDraftScope, ProviderAccount } from '@openkraken/ipc-contract';
import { GitHubMergeDialog } from './pull-merge.js';
import { GitLabMergeDialog } from './gitlab-merge.js';

export function SavedMergeDrafts({ account }: { account: ProviderAccount }) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<MergeDraftScope[]>([]);
  const [selected, setSelected] = useState<{
    scope: MergeDraftScope;
    draft: MergeDraft;
    revision: string;
  }>();
  const [review, setReview] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    let live = true;
    setBusy(true);
    void window.openkraken
      .request({
        id: crypto.randomUUID(),
        method: 'mergeDraftList',
        scope: { accountId: account.id },
      })
      .then((reply) => {
        if (!live) return;
        if (reply.kind !== 'mergeDraftList') throw Error();
        setEntries(reply.entries);
        setError(reply.unreadable ? 'Some saved merge drafts could not be read.' : '');
      })
      .catch(() => {
        if (live) setError('Saved merge drafts could not be listed.');
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [account.id, expanded, refresh]);
  const read = async (scope: MergeDraftScope) => {
    setBusy(true);
    setSelected(undefined);
    setConfirm(false);
    setError('');
    try {
      const reply = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'mergeDraftRead',
        scope,
      });
      if (reply.kind !== 'mergeDraft' || !reply.draft || !reply.revision) throw Error();
      setSelected({ scope, draft: reply.draft, revision: reply.revision });
    } catch {
      setError('This saved merge draft could not be read.');
    } finally {
      setBusy(false);
    }
  };
  const reload = () => {
    setSelected(undefined);
    setConfirm(false);
    setReview(false);
    setRefresh((n) => n + 1);
  };
  const remove = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const reply = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'mergeDraftSave',
        scope: selected.scope,
        revision: selected.revision,
        draft: null,
      });
      if (reply.kind !== 'mergeDraft') throw Error();
      reload();
    } catch {
      setError('Discard failed. Reopen the saved draft to check its current contents.');
    } finally {
      setBusy(false);
    }
  };
  const Dialog = account.provider === 'gitlab' ? GitLabMergeDialog : GitHubMergeDialog;
  const draft = selected?.draft;
  return (
    <>
      <button
        aria-expanded={expanded}
        disabled={busy}
        onClick={() => {
          setExpanded(!expanded);
          setSelected(undefined);
          setConfirm(false);
          setEntries([]);
          setError('');
        }}
      >
        Saved merge drafts
      </button>
      {expanded && (
        <section aria-label="Saved merge drafts">
          {!busy && !error && entries.length === 0 && (
            <p>No saved merge drafts for this account.</p>
          )}
          {entries.map((scope) => (
            <button disabled={busy} key={JSON.stringify(scope)} onClick={() => void read(scope)}>
              {scope.repository.owner}/{scope.repository.name}{' '}
              {account.provider === 'gitlab' ? '!' : '#'}
              {scope.number}
            </button>
          ))}
          {draft && selected && (
            <>
              {draft.uncertain && (
                <p>
                  The provider may have received this merge. Check its current status before another
                  attempt.
                </p>
              )}
              {draft.provider === 'github' ? (
                <>
                  <p>Merge method · {draft.method}</p>
                  {draft.title && <pre aria-label="Saved merge title">{draft.title}</pre>}
                  {draft.message && <pre aria-label="Saved merge message">{draft.message}</pre>}
                </>
              ) : (
                <>
                  <p>
                    Squash commits ·{' '}
                    {draft.selectedSquash === null
                      ? 'Project setting'
                      : draft.selectedSquash
                        ? 'Yes'
                        : 'No'}
                  </p>
                  <p>Remove source branch · {draft.removeSource ? 'Yes' : 'No'}</p>
                  {draft.mergeMessage && (
                    <pre aria-label="Saved merge message">{draft.mergeMessage}</pre>
                  )}
                  {draft.squashMessage && (
                    <pre aria-label="Saved squash message">{draft.squashMessage}</pre>
                  )}
                </>
              )}
              <p>{draft.defaults ? 'Use provider default messages' : 'Use custom messages'}</p>
              <button disabled={busy} onClick={() => setReview(true)}>
                Open merge review
              </button>
              {confirm ? (
                <>
                  <button disabled={busy} onClick={() => void remove()}>
                    Confirm discard
                  </button>
                  <button disabled={busy} onClick={() => setConfirm(false)}>
                    Keep draft
                  </button>
                </>
              ) : (
                <button disabled={busy} onClick={() => setConfirm(true)}>
                  Discard saved merge draft
                </button>
              )}
              {review && (
                <Dialog target={{ ...selected.scope, origin: account.origin }} close={reload} />
              )}
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </section>
      )}
    </>
  );
}
