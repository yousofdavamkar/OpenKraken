import { BitbucketPullDetails } from './bitbucket-pull-details.js';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type {
  ProviderAccount,
  ProviderPullDetails,
  ProviderPullListOptions,
  ProviderPullSummary,
} from '@openkraken/ipc-contract';
import { CommentDiscussion, PullFiles, PullReviews, WriteReview } from './pull-review.js';
import { MergeRequestDetails } from './merge-request-details.js';
import { PullChecks } from './pull-checks.js';
import { MergePullRequest } from './pull-merge.js';
import { CreatePullRequest } from './pull-create.js';
import { ProviderRepositoryPicker } from './provider-repositories.js';
import { ProviderPolling, pollNumberedPages, useProviderPoll } from './provider-polling.js';

type RepositorySelection = {
  provider: ProviderAccount['provider'];
  accountId: string;
  origin: string;
  repository: ProviderPullListOptions['repository'];
};
function PullDetails({
  target,
  number,
  refreshList,
}: {
  target: RepositorySelection;
  number: number;
  refreshList: () => void;
}) {
  const [tab, setTab] = useState<'details' | 'files' | 'reviews' | 'comments' | 'checks'>(
    'details',
  );
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
  useProviderPoll(
    pending,
    `${number}/${attempt}`,
    async (read) => {
      const result = await read({
        method: 'providerPullRequest',
        accountId: target.accountId,
        options: { repository: target.repository, number },
      });
      if (result.kind !== 'providerPullRequest')
        throw new Error('Pull-request details could not be refreshed.');
      return {
        commit: () => {
          setDetail(result.pullRequest);
          setError('');
        },
        resetChildren:
          (tab === 'checks' && detail?.head.sha !== result.pullRequest.head.sha) ||
          (tab === 'files' &&
            (detail?.head.sha !== result.pullRequest.head.sha ||
              detail?.base.sha !== result.pullRequest.base.sha)),
      };
    },
    1,
  );
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
            <button aria-pressed={tab === 'checks'} onClick={() => setTab('checks')}>
              Checks
            </button>
            <MergePullRequest
              target={target}
              detail={detail}
              finished={(changed) => {
                if (changed) refreshList();
                else setAttempt((value) => value + 1);
              }}
            />
            <WriteReview
              context={{ ...target, detail }}
              submitted={() => setReviewsVersion((value) => value + 1)}
            />
          </div>
          {tab === 'checks' && <PullChecks key={detail.head.sha} context={{ ...target, detail }} />}
          {tab === 'comments' && <CommentDiscussion context={{ ...target, detail }} />}
          {tab === 'files' && (
            <PullFiles
              key={`${detail.head.sha}/${detail.base.sha}`}
              context={{ ...target, detail }}
            />
          )}
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
  const noun = target.provider === 'gitlab' ? 'merge' : 'pull';
  const title = target.provider === 'gitlab' ? 'Merge' : 'Pull';
  const prefix = target.provider === 'gitlab' ? '!' : '#';
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
  const restoreScroll = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (restoreScroll.current !== undefined && scroll.current)
      scroll.current.scrollTop = restoreScroll.current;
    restoreScroll.current = undefined;
  }, [pulls]);
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
        if (alive) setError(`${title} requests could not be loaded.`);
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [target, state, page, attempt, title]);
  const search = query.trim().toLocaleLowerCase();
  const visible = pulls.filter((pr) =>
    `${prefix}${pr.number} ${pr.title} ${pr.author ?? ''}`.toLocaleLowerCase().includes(search),
  );
  useProviderPoll(
    pending,
    `${state}/${page}/${attempt}`,
    async (read) => {
      const currentId = visible[active]?.number;
      const top = Math.floor((scroll.current?.scrollTop ?? 0) / 56);
      const anchor = visible[top]?.number;
      const offset = (scroll.current?.scrollTop ?? 0) % 56;
      const result = await pollNumberedPages(
        page,
        async (page) => {
          const result = await read({
            method: 'providerPullRequests',
            accountId: target.accountId,
            options: { repository: target.repository, state, page },
          });
          if (result.kind !== 'providerPullRequests')
            throw new Error(`${title} requests could not be refreshed.`);
          return { ...result.page, items: result.page.pullRequests };
        },
        (pull) => pull.number,
      );
      const matches = result.items.filter((pull) =>
        `${prefix}${pull.number} ${pull.title} ${pull.author ?? ''}`
          .toLocaleLowerCase()
          .includes(search),
      );
      return {
        commit: () => {
          const index = matches.findIndex((pull) => pull.number === currentId);
          const anchorIndex = matches.findIndex((pull) => pull.number === anchor);
          restoreScroll.current =
            anchorIndex >= 0 ? anchorIndex * 56 + offset : scroll.current?.scrollTop;
          setPulls(result.items);
          setNext(result.nextPage);
          setLimited(result.limited);
          setError('');
          setActive(index >= 0 ? index : Math.max(0, Math.min(active, matches.length - 1)));
        },
      };
    },
    0,
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
      <section aria-label={`${title}-request list`}>
        <label>
          Search loaded {noun} requests
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
          {pulls.length} {noun} request{pulls.length === 1 ? '' : 's'} loaded · {visible.length}{' '}
          match
          {pending ? ' · Loading…' : ''}
        </p>
        <div
          ref={scroll}
          className="provider-repositories pull-list"
          role="listbox"
          aria-label={`${title} requests`}
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
                  aria-label={`Open ${noun} request ${prefix}${pr.number}: ${pr.title}`}
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
                    {prefix}
                    {pr.number} {pr.title}
                  </strong>
                  <span>
                    {pr.state === 'merged' || (target.provider === 'github' && pr.mergedAt)
                      ? 'Merged'
                      : pr.state === 'locked'
                        ? 'Locked'
                        : pr.state === 'declined'
                          ? 'Declined'
                          : pr.state === 'superseded'
                            ? 'Superseded'
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
            {pulls.length
              ? `No loaded ${noun} requests match.`
              : `No ${noun} requests in this state.`}
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
              Retry {noun} requests
            </button>
          </p>
        )}
        {next !== null && !error && (
          <button type="button" disabled={pending} onClick={() => setPage(next)}>
            Load more {noun} requests
          </button>
        )}
        {limited && (
          <p>Showing at most 10,000 {noun} requests. Change the state filter to narrow the list.</p>
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
          Refresh {noun} requests
        </button>
        <p>Search covers loaded results. Use arrow keys and Enter to open details.</p>
      </section>
      {selected !== undefined ? (
        target.provider === 'bitbucket' ? (
          <BitbucketPullDetails key={selected} target={target} number={selected} />
        ) : target.provider === 'gitlab' ? (
          <MergeRequestDetails
            key={selected}
            target={target}
            number={selected}
            refreshList={() => {
              setPulls([]);
              setSelected(undefined);
              setNext(null);
              setPage(1);
              setAttempt((value) => value + 1);
              setActive(0);
              scroll.current?.scrollTo(0, 0);
            }}
          />
        ) : (
          <PullDetails
            key={selected}
            target={target}
            number={selected}
            refreshList={() => {
              setPulls([]);
              setSelected(undefined);
              setNext(null);
              setPage(1);
              setAttempt((value) => value + 1);
              setActive(0);
              scroll.current?.scrollTo(0, 0);
            }}
          />
        )
      ) : (
        <p>Select a {noun} request to view its details.</p>
      )}
    </div>
  );
}
function PullRequestDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState<RepositorySelection>();
  const [state, setState] = useState<ProviderPullListOptions['state']>('open');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="reference-dialog pull-request-dialog"
      aria-label={target?.provider === 'gitlab' ? 'Browse merge requests' : 'Browse pull requests'}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <h2>{target?.provider === 'gitlab' ? 'Merge requests' : 'Pull requests'}</h2>
      {target ? (
        <>
          <p>
            {target.origin}/{target.repository.owner}/{target.repository.name}
          </p>
          <div className="dialog-actions">
            {target.provider !== 'bitbucket' && (
              <CreatePullRequest
                target={target}
                created={() => {
                  setState('open');
                  setVersion((value) => value + 1);
                }}
              />
            )}
            <button type="button" onClick={() => setTarget(undefined)}>
              Choose repository
            </button>
            <label>
              {target.provider === 'gitlab' ? 'Merge-request state' : 'Pull-request state'}{' '}
              <select
                aria-label={
                  target.provider === 'gitlab' ? 'Merge-request state' : 'Pull-request state'
                }
                value={state}
                onChange={(event) => {
                  const value = event.target.value;
                  if (
                    value === 'open' ||
                    (target.provider !== 'bitbucket' && value === 'closed') ||
                    value === 'all' ||
                    (target.provider === 'gitlab' && (value === 'merged' || value === 'locked')) ||
                    (target.provider === 'bitbucket' &&
                      (value === 'merged' || value === 'declined' || value === 'superseded'))
                  )
                    setState(value);
                }}
              >
                <option value="open">Open</option>
                {target.provider !== 'bitbucket' && (
                  <option value="closed">
                    {target.provider === 'gitlab' ? 'Closed' : 'Closed (including merged)'}
                  </option>
                )}
                {target.provider === 'gitlab' && (
                  <>
                    <option value="merged">Merged</option>
                    <option value="locked">Locked</option>
                  </>
                )}
                {target.provider === 'bitbucket' && (
                  <>
                    <option value="merged">Merged</option>
                    <option value="declined">Declined</option>
                    <option value="superseded">Superseded</option>
                  </>
                )}
                <option value="all">All</option>
              </select>
            </label>
          </div>
          <ProviderPolling
            key={`${target.accountId}/${target.repository.owner}/${target.repository.name}/${state}/${version}`}
            accountId={target.accountId}
            scope={`pulls/${target.repository.owner}/${target.repository.name}`}
          >
            <PullPages target={target} state={state} />
          </ProviderPolling>
        </>
      ) : (
        <ProviderRepositoryPicker
          collaboration="pulls"
          onSelect={(url, accountId, repository, provider) => {
            setState('open');
            setTarget({
              provider,
              accountId,
              origin: new URL(url).origin,
              repository: { owner: repository.owner, name: repository.name },
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
