import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type {
  ProviderAccount,
  ProviderIssueDetails,
  ProviderIssueListOptions,
  ProviderIssueSummary,
  ProviderIssueComment,
} from '@openkraken/ipc-contract';
import { IssueAction } from './issue-actions.js';
import { ProviderRepositoryPicker } from './provider-repositories.js';
import { ProviderPolling, pollNumberedPages, useProviderPoll } from './provider-polling.js';

type RepositorySelection = {
  provider: ProviderAccount['provider'];
  accountId: string;
  origin: string;
  repository: ProviderIssueListOptions['repository'];
};
function issueContext(issue: ProviderIssueDetails | undefined) {
  return issue && 'provider' in issue
    ? `${issue.id}/${issue.projectId}/${issue.confidential}`
    : 'github';
}
function IssueComments({ target, number }: { target: RepositorySelection; number: number }) {
  const noun = target.provider === 'gitlab' ? 'notes' : 'comments';
  const title = target.provider === 'gitlab' ? 'Notes' : 'Comments';
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
        } else if (result.kind === 'error' || result.kind === 'cancelled') {
          setError(result.kind === 'error' ? result.message : 'Comment loading cancelled.');
          if (target.provider === 'gitlab') {
            setComments([]);
            setNext(null);
            setLimited(false);
          }
        }
      })
      .catch(() => {
        if (alive) {
          setError('Issue comments could not be loaded.');
          if (target.provider === 'gitlab') {
            setComments([]);
            setNext(null);
            setLimited(false);
          }
        }
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [target, number, page, attempt]);
  useProviderPoll(pending, `${number}/${page}/${attempt}`, async (read) => {
    const result = await pollNumberedPages(
      Math.min(10, page),
      async (page) => {
        const result = await read({
          method: 'providerIssueComments',
          accountId: target.accountId,
          options: { repository: target.repository, number, page },
        });
        if (result.kind !== 'providerIssueComments')
          throw new Error('Issue comments could not be refreshed.');
        return {
          ...result.page,
          items: result.page.comments,
          limited: result.page.limited || (page === 10 && result.page.nextPage !== null),
        };
      },
      (comment) => comment.id,
    );
    return {
      commit: () => {
        setComments(result.items);
        setNext(result.nextPage);
        setLimited(result.limited);
        setError('');
      },
    };
  });
  const virtual = useVirtualizer({
    count: comments.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 150,
    overscan: 4,
    getItemKey: (index) => comments[index]!.id,
  });
  return (
    <section aria-label={`Issue ${noun}`}>
      <p role="status">
        {comments.length} {noun} loaded{pending ? ' · Loading…' : ''}
      </p>
      {error && (
        <p role="alert">
          {error}{' '}
          <button disabled={pending} onClick={() => setAttempt((value) => value + 1)}>
            Retry {noun}
          </button>
        </p>
      )}
      <div
        className="issue-comments"
        role="list"
        aria-label={title}
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
                {'provider' in comment && (
                  <p>
                    {comment.system ? 'System activity' : 'User note'}
                    {comment.internal === true
                      ? ' · Internal note'
                      : comment.confidential === true
                        ? ' · Confidential note'
                        : ''}
                    {comment.noteType === 'DiscussionNote' ? ' · Thread note' : ''}
                  </p>
                )}
                <pre>{comment.body || 'Empty comment'}</pre>
              </article>
            );
          })}
        </div>
      </div>
      {!pending && !error && !comments.length && <p>No issue {noun}.</p>}
      {limited && (
        <p>
          The {target.provider === 'gitlab' ? 'note' : 'comment'} display limit was reached.
          Additional {noun} are available on the provider.
        </p>
      )}
      <div className="dialog-actions">
        {next !== null && page < 10 && !error && (
          <button disabled={pending} onClick={() => setPage(next)}>
            Load more {noun}
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
          Refresh {noun}
        </button>
      </div>
    </section>
  );
}
function IssueDetails({
  target,
  number,
  refreshList,
}: {
  target: RepositorySelection;
  number: number;
  refreshList: () => void;
}) {
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
  useProviderPoll(
    pending,
    `${number}/${attempt}`,
    async (read) => {
      const result = await read({
        method: 'providerIssue',
        accountId: target.accountId,
        options: { repository: target.repository, number },
      });
      if (result.kind !== 'providerIssue') throw new Error('Issue details could not be refreshed.');
      return {
        resetChildren: issueContext(detail) !== issueContext(result.issue),
        commit: () => {
          setDetail(result.issue);
          setError('');
        },
      };
    },
    1,
  );
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
          {'provider' in detail && (
            <>
              <p>
                {detail.confidential ? 'Confidential issue' : 'Non-confidential issue'} ·{' '}
                {detail.issueType}
              </p>
              {detail.locked === null && <p>Conversation lock not reported</p>}
              {detail.dueDate && <p>Due: {detail.dueDate}</p>}
              {detail.weight !== null && <p>Weight: {detail.weight}</p>}
            </>
          )}
          <p>Labels: {detail.labels.join(', ') || 'None'}</p>
          <p>Assignees: {detail.assignees.join(', ') || 'Unassigned'}</p>
          <p>
            Milestone: {detail.milestone ?? 'None'} · {detail.comments} comment
            {detail.comments === 1 ? '' : 's'}
            {detail.locked ? ' · Conversation locked' : ''}
          </p>
          <div className="dialog-actions">
            {
              <>
                <IssueAction
                  target={target}
                  intent={{ action: 'comment', number }}
                  finished={() => setAttempt((value) => value + 1)}
                />
                <IssueAction
                  target={target}
                  intent={{
                    action: 'state',
                    number,
                    state: detail.state === 'open' ? 'closed' : 'open',
                  }}
                  finished={(changed) => {
                    if (changed) refreshList();
                    else setAttempt((value) => value + 1);
                  }}
                />
              </>
            }
            <button aria-pressed={tab === 'details'} onClick={() => setTab('details')}>
              Details
            </button>
            <button aria-pressed={tab === 'comments'} onClick={() => setTab('comments')}>
              {target.provider === 'gitlab' ? 'Notes' : 'Comments'}
            </button>
          </div>
          {tab === 'details' ? (
            <>
              <p className="pull-url">{detail.url}</p>
              <pre className="pull-body">{detail.body || 'No description provided.'}</pre>
            </>
          ) : (
            <IssueComments key={issueContext(detail)} target={target} number={number} />
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
  const restoreScroll = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (restoreScroll.current !== undefined && scroll.current)
      scroll.current.scrollTop = restoreScroll.current;
    restoreScroll.current = undefined;
  }, [issues]);
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
            method: 'providerIssues',
            accountId: target.accountId,
            options: { repository: target.repository, state, page },
          });
          if (result.kind !== 'providerIssues') throw new Error('Issues could not be refreshed.');
          return { ...result.page, items: result.page.issues };
        },
        (issue) => issue.number,
      );
      const matches = result.items.filter((issue) =>
        `#${issue.number} ${issue.title} ${issue.author ?? ''} ${issue.labels.join(' ')} ${issue.assignees.join(' ')}`
          .toLocaleLowerCase()
          .includes(search),
      );
      return {
        commit: () => {
          const index = matches.findIndex((issue) => issue.number === currentId);
          const anchorIndex = matches.findIndex((issue) => issue.number === anchor);
          restoreScroll.current =
            anchorIndex >= 0 ? anchorIndex * 56 + offset : scroll.current?.scrollTop;
          setIssues(result.items);
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
        <IssueDetails
          key={selected}
          target={target}
          number={selected}
          refreshList={() => {
            setIssues([]);
            setSelected(undefined);
            setNext(null);
            setPage(1);
            setAttempt((value) => value + 1);
            setActive(0);
            scroll.current?.scrollTo(0, 0);
          }}
        />
      ) : (
        <p>Select an issue to view its details.</p>
      )}
    </div>
  );
}
function IssueDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState<RepositorySelection>();
  const [version, setVersion] = useState(0);
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
            {
              <IssueAction
                target={target}
                intent={{ action: 'create' }}
                finished={(changed) => {
                  if (changed) {
                    setState('open');
                    setVersion((value) => value + 1);
                  }
                }}
              />
            }
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
          <ProviderPolling
            key={`${target.accountId}/${target.repository.owner}/${target.repository.name}/${state}/${version}`}
            accountId={target.accountId}
            scope={`issues/${target.repository.owner}/${target.repository.name}`}
          >
            <IssuePages target={target} state={state} />
          </ProviderPolling>
        </>
      ) : (
        <ProviderRepositoryPicker
          collaboration="issues"
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
