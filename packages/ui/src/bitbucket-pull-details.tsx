import { useEffect, useId, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { ProviderBitbucketPullDetails, ProviderPullOptions } from '@openkraken/ipc-contract';
import { useProviderPoll } from './provider-polling.js';

type PersonRow = { id: string; name: string; description: string; date?: string | null };
function People({ label, rows }: { label: string; rows: PersonRow[] | null }) {
  const scroll = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const visible = (rows ?? []).filter((row) =>
    `${row.name} ${row.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const virtual = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 72,
    overscan: 3,
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), ...(visible[active] ? [active] : [])])].sort(
        (a, b) => a - b,
      ),
  });
  const activate = (index: number) => {
    const bounded = Math.max(0, Math.min(index, visible.length - 1));
    setActive(bounded);
    virtual.scrollToIndex(bounded);
  };
  return (
    <section aria-label={label}>
      <p>
        {label}: {rows === null ? 'Not available' : rows.length}
      </p>
      {rows !== null && rows.length > 0 && (
        <>
          <label>
            Search {label.toLowerCase()}
            <input
              type="search"
              maxLength={1000}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
                scroll.current?.scrollTo(0, 0);
              }}
            />
          </label>
          <div
            ref={scroll}
            role="listbox"
            aria-label={label}
            className="provider-repositories"
            tabIndex={0}
            aria-activedescendant={visible[active] ? `${listId}-${visible[active].id}` : undefined}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') activate(active + 1);
              else if (event.key === 'ArrowUp') activate(active - 1);
              else if (event.key === 'Home') activate(0);
              else if (event.key === 'End') activate(visible.length - 1);
              else return;
              event.preventDefault();
            }}
          >
            <div style={{ position: 'relative', height: virtual.getTotalSize() }}>
              {virtual.getVirtualItems().map((item) => {
                const row = visible[item.index]!;
                return (
                  <div
                    key={row.id}
                    id={`${listId}-${row.id}`}
                    role="option"
                    aria-label={row.name}
                    aria-selected={item.index === active}
                    aria-posinset={item.index + 1}
                    aria-setsize={visible.length}
                    className="provider-repository"
                    style={{
                      position: 'absolute',
                      top: item.start,
                      height: item.size,
                      width: '100%',
                    }}
                    onClick={() => activate(item.index)}
                  >
                    <strong>{row.name}</strong>
                    <span>{row.description}</span>
                    {row.date && (
                      <time dateTime={row.date}>{new Date(row.date).toLocaleString()}</time>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {visible.length === 0 && <p>No people match.</p>}
        </>
      )}
    </section>
  );
}
const booleanLabel = (value: boolean | null) =>
  value === null ? 'Not available' : value ? 'Yes' : 'No';
function endpointLabel(endpoint: ProviderBitbucketPullDetails['source']) {
  return `${endpoint.repository ? `${endpoint.repository.owner}/${endpoint.repository.name}` : 'Unavailable repository'}:${endpoint.branch ?? 'Unavailable branch'}`;
}

export function BitbucketPullDetails({
  target,
  number,
}: {
  target: { accountId: string; repository: ProviderPullOptions['repository'] };
  number: number;
}) {
  const [detail, setDetail] = useState<ProviderBitbucketPullDetails>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setPending(true);
    setError('');
    setDetail(undefined);
    void window.openkraken
      .request({
        id,
        method: 'providerBitbucketPullRequest',
        accountId: target.accountId,
        options: { repository: target.repository, number },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'providerBitbucketPullRequest') setDetail(result.pullRequest);
        else if (result.kind === 'error') setError(result.message);
      })
      .catch(() => {
        if (alive) setError('Bitbucket pull-request details could not be loaded.');
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
        method: 'providerBitbucketPullRequest',
        accountId: target.accountId,
        options: { repository: target.repository, number },
      });
      if (result.kind !== 'providerBitbucketPullRequest')
        throw new Error('Bitbucket pull-request details could not be refreshed.');
      return {
        commit: () => {
          setDetail(result.pullRequest);
          setError('');
        },
      };
    },
    1,
  );
  return (
    <section className="pull-details" aria-label="Bitbucket pull-request details">
      {pending && <p role="status">Loading pull request #{number}…</p>}
      {error && <p role="alert">{error}</p>}
      {detail && (
        <>
          <h3>
            #{detail.number} {detail.title}
          </h3>
          <p>
            {detail.state[0]!.toUpperCase() + detail.state.slice(1)}
            {detail.draft ? ' · Draft' : ''} · {detail.author ?? 'Deleted account'}
          </p>
          <p>
            {endpointLabel(detail.source)} → {endpointLabel(detail.destination)}
          </p>
          {!detail.source.repository && <p>Source repository unavailable.</p>}
          <p>
            Updated{' '}
            <time dateTime={detail.updatedAt}>{new Date(detail.updatedAt).toLocaleString()}</time>
          </p>
          <p>
            Comments: {detail.comments ?? 'Not available'} · Open tasks:{' '}
            {detail.openTasks ?? 'Not available'}
          </p>
          <p>
            Queued: {booleanLabel(detail.queued)} · Close source branch on merge:{' '}
            {booleanLabel(detail.closeSourceBranch)}
          </p>
          <p>
            Source commit: <code>{detail.source.commit ?? 'Not available'}</code>
          </p>
          <p>
            Destination commit: <code>{detail.destination.commit ?? 'Not available'}</code>
          </p>
          {detail.mergeCommit && (
            <p>
              Merge commit: <code>{detail.mergeCommit}</code>
            </p>
          )}
          {detail.closedBy && <p>Closed by: {detail.closedBy.name}</p>}
          {detail.reason && <p className="pull-body">Reason: {detail.reason}</p>}
          <p className="pull-body">{detail.body || 'No description.'}</p>
          <p className="provider-url">{detail.url}</p>
          <People
            label="Reviewers"
            rows={
              detail.reviewers?.map((user, index) => ({
                id: user?.id ?? `deleted-${index}`,
                name: user?.name ?? 'Deleted account',
                description: 'Added as reviewer',
              })) ?? null
            }
          />
          <People
            label="Review participants"
            rows={
              detail.participants?.map((item, index) => ({
                id: item.user?.id ?? `deleted-${index}`,
                name: item.user?.name ?? 'Deleted account',
                description: `${item.role === 'REVIEWER' ? 'Reviewer' : 'Participant'} · Approved: ${item.approved ? 'Yes' : 'No'} · ${item.state === 'changes_requested' ? 'Changes requested' : item.state === 'approved' ? 'Approved' : 'No review state'}`,
                date: item.participatedAt,
              })) ?? null
            }
          />
        </>
      )}
      <button type="button" disabled={pending} onClick={() => setAttempt((value) => value + 1)}>
        {error ? 'Retry details' : 'Refresh details'}
      </button>
    </section>
  );
}
