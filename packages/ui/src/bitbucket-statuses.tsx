import { useEffect, useMemo, useState } from 'react';
import type {
  ProviderBitbucketStatusesOptions,
  ProviderBitbucketStatusesPage,
} from '@openkraken/ipc-contract';
import { useProviderPoll } from './provider-polling.js';

const labels = {
  INPROGRESS: 'In progress',
  SUCCESSFUL: 'Successful',
  FAILED: 'Failed',
  STOPPED: 'Stopped',
};
export function BitbucketStatuses({
  accountId,
  options,
}: {
  accountId: string;
  options: Omit<ProviderBitbucketStatusesOptions, 'page'>;
}) {
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<ProviderBitbucketStatusesPage>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const request = useMemo(
    () => ({
      method: 'providerBitbucketPullStatuses' as const,
      accountId,
      options: { ...options, page },
    }),
    [accountId, options, page],
  );
  useEffect(() => {
    const id = crypto.randomUUID();
    let mounted = true;
    setBusy(true);
    setData(undefined);
    setError('');
    void window.openkraken
      .request({ ...request, id })
      .then((result) => {
        if (!mounted) return;
        if (result.kind === 'providerBitbucketPullStatuses') setData(result.page);
        else
          setError(result.kind === 'error' ? result.message : 'Build checks could not be loaded.');
      })
      .catch(() => {
        if (mounted) setError('Build checks could not be loaded.');
      })
      .finally(() => {
        if (mounted) setBusy(false);
      });
    return () => {
      mounted = false;
      void window.openkraken.cancel(id);
    };
  }, [request, attempt]);
  useProviderPoll(busy, `${page}/${attempt}`, async (read) => {
    const result = await read(request);
    if (result.kind !== 'providerBitbucketPullStatuses')
      throw new Error('Build checks could not be refreshed.');
    return {
      commit: () => {
        setData(result.page);
        setError('');
      },
    };
  });
  return (
    <section aria-label="Bitbucket build checks">
      <h4>Build checks</h4>
      {busy && <p role="status">Loading build checks…</p>}
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p role="status">
            {data.statuses.length
              ? `Build checks on page ${page}: ${data.statuses.length}`
              : page === 1
                ? 'No build checks reported.'
                : 'No build checks on this page.'}
          </p>
          <ul>
            {data.statuses.map((status, index) => (
              <li key={index}>
                <strong>{status.name || status.key}</strong>
                {status.name && status.name !== status.key && ` (${status.key})`} ·{' '}
                {labels[status.state]}
                {status.refname && (
                  <>
                    {' '}
                    · <code>{status.refname}</code>
                  </>
                )}
                {status.updatedAt && (
                  <>
                    {' '}
                    ·{' '}
                    <time dateTime={status.updatedAt}>
                      {new Date(status.updatedAt).toLocaleString()}
                    </time>
                  </>
                )}
                {status.description && <p>{status.description}</p>}
              </li>
            ))}
          </ul>
          {data.limited && <p>Reached the 100-page limit.</p>}
        </>
      )}
      {page > 1 && (
        <button disabled={busy} onClick={() => setPage(page - 1)}>
          Previous checks
        </button>
      )}
      {data?.nextPage && (
        <button disabled={busy} onClick={() => setPage(data.nextPage!)}>
          Next checks
        </button>
      )}
      <button disabled={busy} onClick={() => setAttempt((value) => value + 1)}>
        {error ? 'Retry checks' : 'Refresh checks'}
      </button>
    </section>
  );
}
