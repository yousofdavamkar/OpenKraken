import { useEffect, useState } from 'react';
import type { PullDraftScope, ProviderAccount } from '@openkraken/ipc-contract';
import { PullCreationDialog } from './pull-create.js';

export function SavedPullDrafts({ account }: { account: ProviderAccount }) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<PullDraftScope[]>();
  const [selected, setSelected] = useState<PullDraftScope>();
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    let live = true;
    void window.openkraken
      .request({
        id: crypto.randomUUID(),
        method: 'pullDraftList',
        scope: { accountId: account.id },
      })
      .then((result) => {
        if (!live) return;
        if (result.kind !== 'pullDraftList')
          throw Error(
            result.kind === 'error' ? result.message : 'Saved creation drafts could not be listed.',
          );
        setEntries(result.entries);
        setError(result.unreadable ? 'Some local drafts could not be read.' : '');
      })
      .catch((reason: unknown) => {
        if (live)
          setError(
            reason instanceof Error ? reason.message : 'Saved creation drafts could not be listed.',
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
        Saved creation drafts
      </button>
      {expanded && (
        <section aria-label="Saved creation drafts">
          {entries?.length === 0 && <p>No saved creation drafts for this account.</p>}
          {entries?.map((entry) => (
            <button key={JSON.stringify(entry)} onClick={() => setSelected(entry)}>
              {entry.repository.owner}/{entry.repository.name}
            </button>
          ))}
          {error && <p role="alert">{error}</p>}
        </section>
      )}
      {selected && (
        <PullCreationDialog
          key={JSON.stringify(selected)}
          target={{
            provider: account.provider,
            origin: account.origin,
            accountId: account.id,
            repository: selected.repository,
          }}
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
