import { useEffect, useId, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type {
  ProviderPullDetails,
  ProviderPullListOptions,
  ProviderPullSummary,
} from '@openkraken/ipc-contract';
import { CommentDiscussion, PullFiles, PullReviews, WriteReview } from './pull-review.js';
import { ProviderRepositoryPicker } from './provider-repositories.js';

type RepositorySelection = {
  accountId: string;
  origin: string;
  repository: ProviderPullListOptions['repository'];
};
function PullDetails({ target, number }: { target: RepositorySelection; number: number }) {
  const [tab, setTab] = useState<'details' | 'files' | 'reviews' | 'comments'>('details');
  const [reviewsVersion, setReviewsVersion] = useState(0);
  const [detail, setDetail] = useState<ProviderPullDetails>();
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
        method: 'providerPullRequest',
        accountId: target.accountId,
        options: { repository: target.repository, number },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'providerPullRequest') setDetail(result.pullRequest);
        else if (result.kind === 'error') setError(result.message);
      })
      .catch(() => {
        if (alive) setError('Pull-request details could not be loaded.');
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [target, number, attempt]);
  return (
    <section className="pull-details" aria-label="Pull-request details">
      {pending && <p role="status">Loading pull request #{number}…</p>}
      {error && <p role="alert">{error}</p>}
      {detail && (
        <>
          <h3>
            #{detail.number} {detail.title}
          </h3>
          <p>
            {detail.merged
              ? 'Merged'
              : detail.state === 'closed'
                ? 'Closed'
                : detail.draft
                  ? 'Draft'
                  : 'Open'}{' '}
            · {detail.author ?? 'Deleted account'}
          </p>
          <p>
            {detail.head.label} → {detail.base.label}
          </p>
          <p>
            Updated{' '}
            <time dateTime={detail.updatedAt}>{new Date(detail.updatedAt).toLocaleString()}</time>
          </p>
          <p>
            {detail.commits} commits · {detail.changedFiles} files · +{detail.additions} / −
            {detail.deletions}
          </p>
          <p>
            {detail.comments} comments · {detail.reviewComments} review comments
          </p>
          <p>
            Mergeability:{' '}
            {detail.mergeable === null
              ? 'Not yet determined'
              : detail.mergeable
                ? 'Can merge automatically'
                : 'Cannot merge automatically'}
          </p>
          <div className="dialog-actions" aria-label="Pull-request sections">
            <button aria-pressed={tab === 'details'} onClick={() => setTab('details')}>
              Details
            </button>
            <button aria-pressed={tab === 'files'} onClick={() => setTab('files')}>
              Files
            </button>
            <button aria-pressed={tab === 'reviews'} onClick={() => setTab('reviews')}>
              Reviews
            </button>
            <button aria-pressed={tab === 'comments'} onClick={() => setTab('comments')}>
              Comments
            </button>
            <WriteReview
              context={{ ...target, detail }}
              submitted={() => setReviewsVersion((value) => value + 1)}
            />
          </div>
          {tab === 'comments' && <CommentDiscussion context={{ ...target, detail }} />}
          {tab === 'files' && <PullFiles context={{ ...target, detail }} />}
          {tab === 'reviews' && (
            <PullReviews key={reviewsVersion} context={{ ...target, detail }} />
          )}
          {tab === 'details' && (
            <>
              <p className="pull-url">{detail.url}</p>
              <pre className="pull-body">{detail.body || 'No description provided.'}</pre>
              <details>
                <summary>Commit IDs</summary>
                <p>
                  Head: <code>{detail.head.sha}</code>
                </p>
                <p>
                  Base: <code>{detail.base.sha}</code>
                </p>
              </details>
            </>
          )}
        </>
      )}
      <button type="button" disabled={pending} onClick={() => setAttempt((value) => value + 1)}>
        {error ? 'Retry details' : 'Refresh details'}
      </button>
    </section>
  );
}
function PullPages({
  target,
  state,
}: {
  target: RepositorySelection;
  state: ProviderPullListOptions['state'];
}) {
  const [pulls, setPulls] = useState<ProviderPullSummary[]>([]);
  const [page, setPage] = useState(1);
  const [next, setNext] = useState<number | null>(null);
  const [limited, setLimited] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<number>();
  const scroll = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setPending(true);
    setError('');
    void window.openkraken
      .request({
        id,
        method: 'providerPullRequests',
        accountId: target.accountId,
        options: { repository: target.repository, state, page },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'providerPullRequests') {
          setPulls((current) => {
            const unique = new Map((page === 1 ? [] : current).map((pr) => [pr.number, pr]));
            for (const pr of result.page.pullRequests) unique.set(pr.number, pr);
            return [...unique.values()];
          });
          setNext(result.page.nextPage);
          setLimited(result.page.limited);
        } else if (result.kind === 'error') setError(result.message);
      })
      .catch(() => {
        if (alive) setError('Pull requests could not be loaded.');
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [target, state, page, attempt]);
  const search = query.trim().toLocaleLowerCase();
  const visible = pulls.filter((pr) =>
    `#${pr.number} ${pr.title} ${pr.author ?? ''}`.toLocaleLowerCase().includes(search),
  );
  const virtual = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 56,
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
    <div className="pull-browser">
      <section aria-label="Pull-request list">
        <label>
          Search loaded pull requests
          <input
            type="search"
            value={query}
            maxLength={1000}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
              scroll.current?.scrollTo(0, 0);
            }}
          />
        </label>
        <p role="status">
          {pulls.length} pull request{pulls.length === 1 ? '' : 's'} loaded · {visible.length} match
          {pending ? ' · Loading…' : ''}
        </p>
        <div
          ref={scroll}
          className="provider-repositories pull-list"
          role="listbox"
          aria-label="Pull requests"
          tabIndex={0}
          aria-activedescendant={
            visible[active] ? `${listId}-${visible[active].number}` : undefined
          }
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') activate(active + 1);
            else if (event.key === 'ArrowUp') activate(active - 1);
            else if (event.key === 'Home') activate(0);
            else if (event.key === 'End') activate(visible.length - 1);
            else if (event.key === 'Enter' || event.key === ' ') {
              if (visible[active]) setSelected(visible[active].number);
            } else return;
            event.preventDefault();
          }}
        >
          <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
            {virtual.getVirtualItems().map((item) => {
              const pr = visible[item.index]!;
              return (
                <div
                  key={pr.number}
                  id={`${listId}-${pr.number}`}
                  role="option"
                  aria-selected={item.index === active}
                  aria-posinset={item.index + 1}
                  aria-setsize={visible.length}
                  aria-label={`Open pull request #${pr.number}: ${pr.title}`}
                  className="provider-repository"
                  style={{
                    position: 'absolute',
                    top: item.start,
                    height: item.size,
                    width: '100%',
                  }}
                  onClick={() => {
                    setActive(item.index);
                    setSelected(pr.number);
                  }}
                >
                  <strong>
                    #{pr.number} {pr.title}
                  </strong>
                  <span>
                    {pr.mergedAt
                      ? 'Merged'
                      : pr.state === 'closed'
                        ? 'Closed'
                        : pr.draft
                          ? 'Draft'
                          : 'Open'}{' '}
                    · {pr.author ?? 'Deleted account'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {!pending && !error && !visible.length && (
          <p>
            {pulls.length ? 'No loaded pull requests match.' : 'No pull requests in this state.'}
          </p>
        )}
        {error && (
          <p role="alert">
            {error}{' '}
            <button
              type="button"
              disabled={pending}
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry pull requests
            </button>
          </p>
        )}
        {next !== null && !error && (
          <button type="button" disabled={pending} onClick={() => setPage(next)}>
            Load more pull requests
          </button>
        )}
        {limited && (
          <p>Showing at most 10,000 pull requests. Change the state filter to narrow the list.</p>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setPulls([]);
            setSelected(undefined);
            setNext(null);
            setPage(1);
            setAttempt((value) => value + 1);
            setActive(0);
            scroll.current?.scrollTo(0, 0);
          }}
        >
          Refresh pull requests
        </button>
        <p>Search covers loaded results. Use arrow keys and Enter to open details.</p>
      </section>
      {selected !== undefined ? (
        <PullDetails key={selected} target={target} number={selected} />
      ) : (
        <p>Select a pull request to view its details.</p>
      )}
    </div>
  );
}
function PullRequestDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState<RepositorySelection>();
  const [state, setState] = useState<ProviderPullListOptions['state']>('open');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="reference-dialog pull-request-dialog"
      aria-label="Browse pull requests"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <h2>Pull requests</h2>
      {target ? (
        <>
          <p>
            {target.origin}/{target.repository.owner}/{target.repository.name}
          </p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setTarget(undefined)}>
              Choose repository
            </button>
            <label>
              Pull-request state{' '}
              <select
                aria-label="Pull-request state"
                value={state}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === 'open' || value === 'closed' || value === 'all') setState(value);
                }}
              >
                <option value="open">Open</option>
                <option value="closed">Closed (including merged)</option>
                <option value="all">All</option>
              </select>
            </label>
          </div>
          <PullPages
            key={`${target.accountId}/${target.repository.owner}/${target.repository.name}/${state}`}
            target={target}
            state={state}
          />
        </>
      ) : (
        <ProviderRepositoryPicker
          onSelect={(url, accountId) => {
            const [, owner, name] = new URL(url).pathname.split('/');
            setState('open');
            setTarget({
              accountId,
              origin: new URL(url).origin,
              repository: { owner: owner!, name: name!.slice(0, -4) },
            });
          }}
        />
      )}
      <div className="dialog-actions">
        <button type="button" onClick={close}>
          Close
        </button>
      </div>
    </dialog>
  );
}
export function PullRequests() {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <button onClick={() => setOpened(true)}>Pull requests</button>
      {opened && <PullRequestDialog close={() => setOpened(false)} />}
    </>
  );
}
