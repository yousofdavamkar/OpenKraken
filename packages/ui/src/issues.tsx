import { useEffect, useId, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type {
  ProviderIssueDetails,
  ProviderIssueListOptions,
  ProviderIssueSummary,
  ProviderIssueComment,
} from '@openkraken/ipc-contract';
import { ProviderRepositoryPicker } from './provider-repositories.js';

type RepositorySelection = {
  accountId: string;
  origin: string;
  repository: ProviderIssueListOptions['repository'];
};
function IssueComments({ target, number }: { target: RepositorySelection; number: number }) {
  const [comments, setComments] = useState<ProviderIssueComment[]>([]);
  const [page, setPage] = useState(1),
    [next, setNext] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0),
    [pending, setPending] = useState(true);
  const [error, setError] = useState(''),
    [limited, setLimited] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setPending(true);
    setError('');
    void window.openkraken
      .request({
        id,
        method: 'providerIssueComments',
        accountId: target.accountId,
        options: { repository: target.repository, number, page },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'providerIssueComments') {
          setComments((current) => [
            ...new Map(
              [...(page === 1 ? [] : current), ...result.page.comments].map((comment) => [
                comment.id,
                comment,
              ]),
            ).values(),
          ]);
          setNext(result.page.nextPage);
          setLimited(result.page.limited || (page === 10 && result.page.nextPage !== null));
        } else if (result.kind === 'error') setError(result.message);
        else if (result.kind === 'cancelled') setError('Comment loading cancelled.');
      })
      .catch(() => {
        if (alive) setError('Issue comments could not be loaded.');
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [target, number, page, attempt]);
  const virtual = useVirtualizer({
    count: comments.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 150,
    overscan: 4,
    getItemKey: (index) => comments[index]!.id,
  });
  return (
    <section aria-label="Issue comments">
      <p role="status">
        {comments.length} comments loaded{pending ? ' · Loading…' : ''}
      </p>
      {error && (
        <p role="alert">
          {error}{' '}
          <button disabled={pending} onClick={() => setAttempt((value) => value + 1)}>
            Retry comments
          </button>
        </p>
      )}
      <div
        className="issue-comments"
        role="list"
        aria-label="Comments"
        tabIndex={0}
        ref={scroll}
        onKeyDown={(event) => {
          if (comments.length && (event.key === 'Home' || event.key === 'End')) {
            event.preventDefault();
            virtual.scrollToIndex(event.key === 'Home' ? 0 : comments.length - 1, {
              align: event.key === 'Home' ? 'start' : 'end',
            });
          }
        }}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const comment = comments[item.index]!;
            return (
              <article
                role="listitem"
                aria-posinset={item.index + 1}
                aria-setsize={comments.length}
                key={item.key}
                data-index={item.index}
                ref={virtual.measureElement}
                className="issue-comment"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <strong>{comment.author ?? 'Deleted account'}</strong>
                <p>
                  <time dateTime={comment.createdAt}>
                    {new Date(comment.createdAt).toLocaleString()}
                  </time>
                  {comment.updatedAt !== comment.createdAt ? ' · Edited' : ''}
                </p>
                <pre>{comment.body || 'Empty comment'}</pre>
              </article>
            );
          })}
        </div>
      </div>
      {!pending && !error && !comments.length && <p>No issue comments.</p>}
      {limited && (
        <p>
          The comment display limit was reached. Additional comments are available on the provider.
        </p>
      )}
      <div className="dialog-actions">
        {next !== null && page < 10 && !error && (
          <button disabled={pending} onClick={() => setPage(next)}>
            Load more comments
          </button>
        )}
        <button
          disabled={pending}
          onClick={() => {
            setComments([]);
            setNext(null);
            setLimited(false);
            setPage(1);
            setAttempt((value) => value + 1);
            scroll.current?.scrollTo(0, 0);
          }}
        >
          Refresh comments
        </button>
      </div>
    </section>
  );
}
function IssueDetails({ target, number }: { target: RepositorySelection; number: number }) {
  const [detail, setDetail] = useState<ProviderIssueDetails>();
  const [tab, setTab] = useState<'details' | 'comments'>('details');
  const [attempt, setAttempt] = useState(0),
    [pending, setPending] = useState(true),
    [error, setError] = useState('');
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setPending(true);
    setError('');
    setDetail(undefined);
    void window.openkraken
      .request({
        id,
        method: 'providerIssue',
        accountId: target.accountId,
        options: { repository: target.repository, number },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'providerIssue') setDetail(result.issue);
        else if (result.kind === 'error') setError(result.message);
        else if (result.kind === 'cancelled') setError('Issue loading cancelled.');
      })
      .catch(() => {
        if (alive) setError('Issue details could not be loaded.');
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
    <section className="pull-details" aria-label="Issue details">
      {pending && <p role="status">Loading issue #{number}…</p>}
      {error && <p role="alert">{error}</p>}
      {detail && (
        <>
          <h3>
            #{detail.number} {detail.title}
          </h3>
          <p>
            {detail.state === 'open' ? 'Open' : 'Closed'}
            {detail.stateReason ? ` · ${detail.stateReason}` : ''} ·{' '}
            {detail.author ?? 'Deleted account'}
          </p>
          <p>
            Updated{' '}
            <time dateTime={detail.updatedAt}>{new Date(detail.updatedAt).toLocaleString()}</time>
          </p>
          <p>Labels: {detail.labels.join(', ') || 'None'}</p>
          <p>Assignees: {detail.assignees.join(', ') || 'Unassigned'}</p>
          <p>
            Milestone: {detail.milestone ?? 'None'} · {detail.comments} comment
            {detail.comments === 1 ? '' : 's'}
            {detail.locked ? ' · Conversation locked' : ''}
          </p>
          <div className="dialog-actions">
            <button aria-pressed={tab === 'details'} onClick={() => setTab('details')}>
              Details
            </button>
            <button aria-pressed={tab === 'comments'} onClick={() => setTab('comments')}>
              Comments
            </button>
          </div>
          {tab === 'details' ? (
            <>
              <p className="pull-url">{detail.url}</p>
              <pre className="pull-body">{detail.body || 'No description provided.'}</pre>
            </>
          ) : (
            <IssueComments target={target} number={number} />
          )}
        </>
      )}
      <button disabled={pending} onClick={() => setAttempt((value) => value + 1)}>
        {error ? 'Retry issue' : 'Refresh issue'}
      </button>
    </section>
  );
}
function IssuePages({
  target,
  state,
}: {
  target: RepositorySelection;
  state: ProviderIssueListOptions['state'];
}) {
  const [issues, setIssues] = useState<ProviderIssueSummary[]>([]);
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
        method: 'providerIssues',
        accountId: target.accountId,
        options: { repository: target.repository, state, page },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'providerIssues') {
          setIssues((current) => {
            const unique = new Map(
              (page === 1 ? [] : current).map((issue) => [issue.number, issue]),
            );
            for (const issue of result.page.issues) unique.set(issue.number, issue);
            return [...unique.values()];
          });
          setNext(result.page.nextPage);
          setLimited(result.page.limited);
        } else if (result.kind === 'error') setError(result.message);
      })
      .catch(() => {
        if (alive) setError('Issues could not be loaded.');
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
  const visible = issues.filter((issue) =>
    `#${issue.number} ${issue.title} ${issue.author ?? ''} ${issue.labels.join(' ')} ${issue.assignees.join(' ')}`
      .toLocaleLowerCase()
      .includes(search),
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
      <section aria-label="Issue list">
        <label>
          Search loaded issues
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
          {issues.length} issue{issues.length === 1 ? '' : 's'} loaded · {visible.length} match
          {pending ? ' · Loading…' : ''}
        </p>
        <div
          ref={scroll}
          className="provider-repositories pull-list"
          role="listbox"
          aria-label="Issues"
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
              const issue = visible[item.index]!;
              return (
                <div
                  key={issue.number}
                  id={`${listId}-${issue.number}`}
                  role="option"
                  aria-selected={item.index === active}
                  aria-posinset={item.index + 1}
                  aria-setsize={visible.length}
                  aria-label={`Open issue #${issue.number}: ${issue.title}`}
                  className="provider-repository"
                  style={{
                    position: 'absolute',
                    top: item.start,
                    height: item.size,
                    width: '100%',
                  }}
                  onClick={() => {
                    setActive(item.index);
                    setSelected(issue.number);
                  }}
                >
                  <strong>
                    #{issue.number} {issue.title}
                  </strong>
                  <span>
                    {issue.state === 'closed' ? 'Closed' : 'Open'} ·{' '}
                    {issue.author ?? 'Deleted account'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {!pending && !error && !visible.length && (
          <p>
            {issues.length
              ? 'No loaded issues match.'
              : next !== null
                ? 'No issues on the loaded pages. Load more to continue.'
                : 'No issues in this state.'}
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
              Retry issues
            </button>
          </p>
        )}
        {next !== null && !error && (
          <button type="button" disabled={pending} onClick={() => setPage(next)}>
            Load more issues
          </button>
        )}
        {limited && (
          <p>Issue browsing limit reached. Change the state filter to narrow the list.</p>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setIssues([]);
            setSelected(undefined);
            setNext(null);
            setPage(1);
            setAttempt((value) => value + 1);
            setActive(0);
            scroll.current?.scrollTo(0, 0);
          }}
        >
          Refresh issues
        </button>
        <p>Search covers loaded results. Use arrow keys and Enter to open details.</p>
      </section>
      {selected !== undefined ? (
        <IssueDetails key={selected} target={target} number={selected} />
      ) : (
        <p>Select an issue to view its details.</p>
      )}
    </div>
  );
}
function IssueDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState<RepositorySelection>();
  const [state, setState] = useState<ProviderIssueListOptions['state']>('open');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="reference-dialog pull-request-dialog"
      aria-label="Browse issues"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <h2>Issues</h2>
      {target ? (
        <>
          <p>
            {target.origin}/{target.repository.owner}/{target.repository.name}
          </p>
          <div className="dialog-actions">
            <button onClick={() => setTarget(undefined)}>Choose repository</button>
            <label>
              Issue state{' '}
              <select
                aria-label="Issue state"
                value={state}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === 'open' || value === 'closed' || value === 'all') setState(value);
                }}
              >
                <option value="open">Open</option>
                <option value="closed">Closed</option>
                <option value="all">All</option>
              </select>
            </label>
          </div>
          <IssuePages
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
        <button onClick={close}>Close</button>
      </div>
    </dialog>
  );
}
export function Issues() {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <button onClick={() => setOpened(true)}>Issues</button>
      {opened && <IssueDialog close={() => setOpened(false)} />}
    </>
  );
}
