import { useEffect, useMemo, useState } from 'react';
import type {
  ProviderBitbucketStatusesOptions,
  ProviderBitbucketMergeabilityOptions,
  Result,
} from '@openkraken/ipc-contract';
import { useProviderPoll } from './provider-polling.js';

const labels = {
  INPROGRESS: 'In progress',
  SUCCESSFUL: 'Successful',
  FAILED: 'Failed',
  STOPPED: 'Stopped',
};
type CheckRequest =
  | {
      method: 'providerBitbucketPullStatuses';
      accountId: string;
      options: ProviderBitbucketStatusesOptions;
    }
  | {
      method: 'providerBitbucketPullMergeability';
      accountId: string;
      options: ProviderBitbucketMergeabilityOptions;
    };
function useBitbucketChecks(request: CheckRequest, version: number) {
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<Extract<Result, { kind: CheckRequest['method'] }>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
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
        if (result.kind === request.method) setData(result);
        else setError(result.kind === 'error' ? result.message : 'Checks could not be loaded.');
      })
      .catch(() => {
        if (mounted) setError('Checks could not be loaded.');
      })
      .finally(() => {
        if (mounted) setBusy(false);
      });
    return () => {
      mounted = false;
      void window.openkraken.cancel(id);
    };
  }, [request, attempt]);
  useProviderPoll(busy, `${version}/${attempt}`, async (read) => {
    const result = await read(request);
    if (result.kind !== request.method) throw new Error('Checks could not be refreshed.');
    return {
      commit: () => {
        setData(result);
        setError('');
      },
    };
  });
  return { result: data, busy, error, refresh: () => setAttempt((value) => value + 1) };
}
export function BitbucketStatuses({
  accountId,
  options,
}: {
  accountId: string;
  options: Omit<ProviderBitbucketStatusesOptions, 'page'>;
}) {
  const [page, setPage] = useState(1);
  const request = useMemo(
    () => ({
      method: 'providerBitbucketPullStatuses' as const,
      accountId,
      options: { ...options, page },
    }),
    [accountId, options, page],
  );
  const { result, busy, error, refresh } = useBitbucketChecks(request, page);
  const data = result?.kind === 'providerBitbucketPullStatuses' ? result.page : undefined;
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
      <button disabled={busy} onClick={refresh}>
        {error ? 'Retry checks' : 'Refresh checks'}
      </button>
    </section>
  );
}

const checkTypes = {
  pullrequest_state_check: 'Pull request state',
  current_user_permission_check: 'Merge permission',
  git_mergeability_check: 'Git merge',
  standard_merge_check: 'Branch restriction',
  custom_pre_merge_check: 'Pre-merge check',
  custom_on_merge_check: 'On-merge check',
  merge_queue_check: 'Merge queue',
};
const outcomes = {
  PASSED: 'Passed',
  FAILED: 'Failed',
  PENDING: 'Pending',
  SKIPPED: 'Skipped',
  UNKNOWN: 'Unknown',
};
export function BitbucketMergeChecks({
  accountId,
  options,
}: {
  accountId: string;
  options: ProviderBitbucketMergeabilityOptions;
}) {
  const request = useMemo(
    () => ({ method: 'providerBitbucketPullMergeability' as const, accountId, options }),
    [accountId, options],
  );
  const { result, busy, error, refresh } = useBitbucketChecks(request, 1);
  const checks = result?.kind === 'providerBitbucketPullMergeability' ? result.checks : undefined;
  return (
    <section aria-label="Bitbucket merge checks">
      <h4>Merge checks</h4>
      {busy && <p role="status">Loading merge checks…</p>}
      {error && <p role="alert">{error}</p>}
      {checks?.length === 0 && <p role="status">No merge checks reported.</p>}
      {checks && (
        <ul>
          {checks.map((check, index) => (
            <li key={index}>
              <strong>{check.name || checkTypes[check.type]}</strong>
              {check.name && ` (${checkTypes[check.type]})`} · {outcomes[check.status]} ·{' '}
              {check.required ? 'Required' : 'Optional'} ·{' '}
              {check.blocking ? 'Blocks merge' : 'Nonblocking'}
              {check.detail && <p>{check.detail}</p>}
            </li>
          ))}
        </ul>
      )}
      <button disabled={busy} onClick={refresh}>
        {error ? 'Retry merge checks' : 'Refresh merge checks'}
      </button>
    </section>
  );
}
