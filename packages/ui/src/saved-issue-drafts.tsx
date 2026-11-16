import { useEffect, useState } from 'react';
import type { IssueDraftScope, ProviderAccount } from '@openkraken/ipc-contract';
import { IssueActionDialog, issueActionLabel } from './issue-actions.js';

export function SavedIssueDrafts({ account }: { account: ProviderAccount }) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<IssueDraftScope[]>();
  const [selected, setSelected] = useState<IssueDraftScope>();
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    let live = true;
    void window.openkraken
      .request({
        id: crypto.randomUUID(),
        method: 'issueDraftList',
        scope: { accountId: account.id },
      })
      .then((result) => {
        if (!live) return;
        if (result.kind !== 'issueDraftList')
          throw Error(
            result.kind === 'error' ? result.message : 'Saved issue drafts could not be listed.',
          );
        setEntries(result.entries);
        setError(result.unreadable ? 'Some local drafts could not be read.' : '');
      })
      .catch((reason: unknown) => {
        if (live)
          setError(
            reason instanceof Error ? reason.message : 'Saved issue drafts could not be listed.',
          );
      });
    return () => {
      live = false;
    };
  }, [expanded, account.id, refresh]);
  return (
    <>
      <button
        aria-expanded={expanded}
        onClick={() => {
          setExpanded(!expanded);
          setEntries(undefined);
          setError('');
        }}
      >
        Saved issue drafts
      </button>
      {expanded && (
        <section aria-label="Saved issue drafts">
          {entries?.length === 0 && <p>No saved issue drafts for this account.</p>}
          {entries?.map((entry) => (
            <button key={JSON.stringify(entry)} onClick={() => setSelected(entry)}>
              {entry.repository.owner}/{entry.repository.name} · {issueActionLabel(entry.intent)}
            </button>
          ))}
          {error && <p role="alert">{error}</p>}
        </section>
      )}
      {selected && (
        <IssueActionDialog
          key={JSON.stringify(selected)}
          target={{
            provider: account.provider,
            origin: account.origin,
            accountId: account.id,
            repository: selected.repository,
          }}
          intent={selected.intent}
          close={() => {
            setSelected(undefined);
            setEntries(undefined);
            setRefresh((n) => n + 1);
          }}
        />
      )}
    </>
  );
}
