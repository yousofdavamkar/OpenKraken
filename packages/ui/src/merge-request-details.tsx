import { useEffect, useState } from 'react';
import type { ProviderMergeRequestDetails, ProviderPullOptions } from '@openkraken/ipc-contract';
import { MergeRequestDiscussions } from './merge-request-discussions.js';
import { MergeRequestFiles } from './merge-request-files.js';
import { useProviderPoll } from './provider-polling.js';

export function MergeRequestDetails({
  target,
  number,
}: {
  target: { accountId: string; repository: ProviderPullOptions['repository'] };
  number: number;
}) {
  const [tab, setTab] = useState<'details' | 'files' | 'discussions'>('details');
  const [detail, setDetail] = useState<ProviderMergeRequestDetails>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(true);
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setPending(true);
    setError('');
    setDetail(undefined);
    void window.openkraken
      .request({
        id,
        method: 'providerMergeRequest',
        accountId: target.accountId,
        options: { repository: target.repository, number },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'providerMergeRequest') setDetail(result.mergeRequest);
        else if (result.kind === 'error') setError(result.message);
      })
      .catch(() => {
        if (alive) setError('Merge-request details could not be loaded.');
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [target, number, attempt]);
  useProviderPoll(
    pending,
    `${number}/${attempt}`,
    async (read) => {
      const result = await read({
        method: 'providerMergeRequest',
        accountId: target.accountId,
        options: { repository: target.repository, number },
      });
      if (result.kind !== 'providerMergeRequest')
        throw new Error('Merge-request details could not be refreshed.');
      return {
        commit: () => {
          setDetail(result.mergeRequest);
          setError('');
        },
        resetChildren:
          tab === 'files' &&
          (detail?.diffRefs?.base !== result.mergeRequest.diffRefs?.base ||
            detail?.diffRefs?.head !== result.mergeRequest.diffRefs?.head ||
            detail?.diffRefs?.start !== result.mergeRequest.diffRefs?.start ||
            detail?.source.sha !== result.mergeRequest.source.sha),
      };
    },
    1,
  );
  return (
    <section className="pull-details" aria-label="Merge-request details">
      {pending && <p role="status">Loading merge request !{number}…</p>}
      {error && <p role="alert">{error}</p>}
      {detail && (
        <>
          <h3>
            !{detail.number} {detail.title}
          </h3>
          <p>
            {detail.state === 'merged'
              ? 'Merged'
              : detail.state === 'locked'
                ? 'Locked'
                : detail.state === 'closed'
                  ? 'Closed'
                  : detail.draft
                    ? 'Draft'
                    : 'Open'}{' '}
            · {detail.author ?? 'Deleted account'}
          </p>
          <p>
            {detail.source.branch} → {detail.target.branch}
          </p>
          <p>
            Updated{' '}
            <time dateTime={detail.updatedAt}>{new Date(detail.updatedAt).toLocaleString()}</time>
          </p>
          <p>
            {detail.changesCount
              ? `${detail.changesCount.count}${detail.changesCount.limited ? '+' : ''} changes`
              : 'Change count not yet available.'}{' '}
            · {detail.notesCount} notes
          </p>
          <p>Merge status: {detail.mergeStatus}</p>
          {detail.conflicts && <p>Merge conflicts reported.</p>}
          {detail.source.projectId === null ? (
            <p>Source project is no longer available.</p>
          ) : (
            <p>
              Source project: {detail.source.projectId} · Target project: {detail.target.projectId}
            </p>
          )}
          {detail.diffRefs ? (
            <dl>
              <dt>Merge base</dt>
              <dd>
                <code>{detail.diffRefs.base}</code>
              </dd>
              <dt>Source tip for this diff</dt>
              <dd>
                <code>{detail.diffRefs.head}</code>
              </dd>
              <dt>Target tip for this diff</dt>
              <dd>
                <code>{detail.diffRefs.start}</code>
              </dd>
            </dl>
          ) : (
            <p>Diff is still being prepared.</p>
          )}
          {detail.source.sha && detail.diffRefs && detail.source.sha !== detail.diffRefs.head && (
            <p>The source branch has changed since this diff was prepared.</p>
          )}
          <div className="dialog-actions" aria-label="Merge-request sections">
            <button aria-pressed={tab === 'details'} onClick={() => setTab('details')}>
              Details
            </button>
            <button
              aria-pressed={tab === 'files'}
              disabled={!detail.diffRefs}
              onClick={() => setTab('files')}
            >
              Files
            </button>
            <button aria-pressed={tab === 'discussions'} onClick={() => setTab('discussions')}>
              Discussions
            </button>
          </div>
          {tab === 'details' ? (
            <pre className="pull-body">{detail.body || 'No description.'}</pre>
          ) : tab === 'discussions' ? (
            <MergeRequestDiscussions
              accountId={target.accountId}
              repository={target.repository}
              number={number}
              revision={detail.diffRefs}
            />
          ) : (
            detail.diffRefs && (
              <MergeRequestFiles
                key={`${detail.diffRefs.base}/${detail.diffRefs.head}/${detail.diffRefs.start}/${detail.source.sha}`}
                accountId={target.accountId}
                repository={target.repository}
                number={number}
                revision={detail.diffRefs}
              />
            )
          )}
          <p>
            <code>{detail.url}</code>
          </p>
        </>
      )}
      <button type="button" disabled={pending} onClick={() => setAttempt((value) => value + 1)}>
        {error ? 'Retry details' : 'Refresh details'}
      </button>
    </section>
  );
}
