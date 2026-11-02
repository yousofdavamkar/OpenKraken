import { useEffect, useId, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { ProviderBitbucketComment, ProviderPullOptions } from '@openkraken/ipc-contract';
import { pollNumberedPages, useProviderPoll } from './provider-polling.js';

function matches(comment: ProviderBitbucketComment, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return `${comment.id} #${comment.id} ${comment.author?.name ?? ''} ${comment.body ?? ''} ${comment.inline?.path ?? ''}`
    .toLocaleLowerCase()
    .includes(needle);
}
function SelectedComment({
  comment,
  parent,
  onParent,
}: {
  comment: ProviderBitbucketComment;
  parent: ProviderBitbucketComment | undefined;
  onParent: (id: number) => void;
}) {
  const position = comment.inline;
  const resolution = comment.resolution;
  const line = (side: string, start: number | null, end: number | null) =>
    end === null
      ? null
      : start !== null && start !== end
        ? `${side} lines ${start}–${end}`
        : `${side} line ${end}`;
  return (
    <section aria-label="Selected comment">
      <h4>
        Comment #{comment.id} · {comment.author?.name ?? 'Unavailable author'}
      </h4>
      <p>
        {comment.pending === null
          ? 'Publication status unavailable.'
          : comment.pending
            ? 'Pending publication'
            : 'Published'}
      </p>
      <p>
        Created:{' '}
        {comment.createdAt ? (
          <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>
        ) : (
          'Unavailable'
        )}{' '}
        · Updated:{' '}
        {comment.updatedAt ? (
          <time dateTime={comment.updatedAt}>{new Date(comment.updatedAt).toLocaleString()}</time>
        ) : (
          'Unavailable'
        )}
      </p>
      <p className="pull-body">
        {comment.deleted ? 'Comment deleted.' : comment.body || 'Empty comment.'}
      </p>
      {comment.parentId !== null &&
        (parent ? (
          <button onClick={() => onParent(parent.id)}>Show parent comment #{parent.id}</button>
        ) : (
          <p>Parent comment #{comment.parentId} is not loaded.</p>
        ))}
      {position && (
        <div>
          <p>
            <code>{position.path}</code>
          </p>
          {position.oldLine === null && position.newLine === null ? (
            <p>File-level comment</p>
          ) : (
            <>
              <p>{line('Old', position.oldStart, position.oldLine)}</p>
              <p>{line('New', position.newStart, position.newLine)}</p>
            </>
          )}
          <p>
            {position.outdated === null
              ? 'Location freshness unavailable.'
              : position.outdated
                ? 'Outdated location'
                : 'Location marked current by Bitbucket.'}
          </p>
          <p>No commit identifier is supplied for this location.</p>
        </div>
      )}
      <p>
        Resolution:{' '}
        {resolution.status === 'unknown'
          ? 'Unavailable'
          : resolution.status === 'unresolved'
            ? 'No resolution record'
            : 'Resolved'}
      </p>
      {resolution.status === 'resolved' && (
        <p>
          Resolved by {resolution.author?.name ?? 'unavailable author'}
          {resolution.createdAt ? (
            <>
              {' '}
              ·{' '}
              <time dateTime={resolution.createdAt}>
                {new Date(resolution.createdAt).toLocaleString()}
              </time>
            </>
          ) : null}
        </p>
      )}
    </section>
  );
}
export function BitbucketComments({
  target,
  number,
  repositoryId,
}: {
  target: { accountId: string; repository: ProviderPullOptions['repository'] };
  number: number;
  repositoryId: string;
}) {
  const [comments, setComments] = useState<ProviderBitbucketComment[]>([]);
  const [page, setPage] = useState(1);
  const [next, setNext] = useState<number | null>(null);
  const [limited, setLimited] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<number>();
  const scroll = useRef<HTMLDivElement>(null);
  const listId = useId();
  const visible = comments.filter((comment) => matches(comment, query));
  const virtual = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 88,
    overscan: 3,
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), ...(visible[active] ? [active] : [])])].sort(
        (a, b) => a - b,
      ),
  });
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setPending(true);
    setError('');
    void window.openkraken
      .request({
        id,
        method: 'providerBitbucketPullComments',
        accountId: target.accountId,
        options: { repository: target.repository, number, repositoryId, page },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'providerBitbucketPullComments') {
          setComments((previous) => [
            ...new Map(
              [...(page === 1 ? [] : previous), ...result.page.comments].map((comment) => [
                comment.id,
                comment,
              ]),
            ).values(),
          ]);
          setNext(result.page.nextPage);
          setLimited(result.page.limited);
        } else if (result.kind === 'error') {
          setError(result.message);
          if (result.code === 'STALE_PROVIDER_MERGE') {
            setComments([]);
            setSelected(undefined);
            setNext(null);
          }
        }
      })
      .catch(() => {
        if (alive) setError('Comments could not be loaded.');
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [target, number, repositoryId, page, attempt]);
  useProviderPoll(pending, `${page}/${attempt}`, async (read) => {
    const result = await pollNumberedPages(
      page,
      async (current) => {
        const response = await read({
          method: 'providerBitbucketPullComments',
          accountId: target.accountId,
          options: { repository: target.repository, number, repositoryId, page: current },
        });
        if (response.kind !== 'providerBitbucketPullComments')
          throw new Error('Comments could not be refreshed.');
        return {
          items: response.page.comments,
          nextPage: response.page.nextPage,
          limited: response.page.limited,
        };
      },
      (comment) => comment.id,
    );
    const activeId = visible[active]?.id;
    return {
      commit: () => {
        setComments(result.items);
        setNext(result.nextPage);
        setLimited(result.limited);
        setError('');
        setActive(
          Math.max(
            0,
            result.items
              .filter((comment) => matches(comment, query))
              .findIndex((comment) => comment.id === activeId),
          ),
        );
        if (selected !== undefined && !result.items.some((comment) => comment.id === selected))
          setSelected(undefined);
      },
    };
  });
  const activate = (index: number) => {
    const bounded = Math.max(0, Math.min(index, visible.length - 1));
    setActive(bounded);
    virtual.scrollToIndex(bounded);
  };
  const choose = (index: number) => {
    const comment = visible[index];
    if (comment) setSelected(comment.id);
  };
  const comment = comments.find((item) => item.id === selected);
  const parent =
    comment?.parentId === null ? undefined : comments.find((item) => item.id === comment?.parentId);
  const [parentJump, setParentJump] = useState<number>();
  useEffect(() => {
    if (parentJump === undefined) return;
    const index = visible.findIndex((comment) => comment.id === parentJump);
    if (index >= 0) {
      setActive(index);
      virtual.scrollToIndex(index);
      scroll.current?.focus();
    }
    setParentJump(undefined);
  }, [parentJump, visible, virtual]);
  return (
    <section aria-label="Bitbucket comments">
      <label>
        Search loaded comments
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
      <p role="status">{pending ? 'Loading comments…' : `${comments.length} comments loaded.`}</p>
      {error && <p role="alert">{error}</p>}
      <div
        role="listbox"
        aria-label="Comments"
        ref={scroll}
        className="provider-repositories"
        tabIndex={0}
        aria-activedescendant={visible[active] ? `${listId}-${visible[active].id}` : undefined}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') activate(active + 1);
          else if (event.key === 'ArrowUp') activate(active - 1);
          else if (event.key === 'Home') activate(0);
          else if (event.key === 'End') activate(visible.length - 1);
          else if (event.key === 'Enter') choose(active);
          else return;
          event.preventDefault();
        }}
      >
        <div style={{ position: 'relative', height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((item) => {
            const comment = visible[item.index]!;
            return (
              <div
                key={comment.id}
                id={`${listId}-${comment.id}`}
                role="option"
                aria-label={`Open comment #${comment.id}`}
                aria-selected={active === item.index}
                aria-posinset={item.index + 1}
                aria-setsize={visible.length}
                className="provider-repository"
                style={{ position: 'absolute', top: item.start, height: item.size, width: '100%' }}
                onClick={() => {
                  activate(item.index);
                  choose(item.index);
                  scroll.current?.focus();
                }}
              >
                <strong>
                  #{comment.id} · {comment.author?.name ?? 'Unavailable author'}
                </strong>
                <span>
                  {comment.deleted
                    ? 'Comment deleted.'
                    : comment.body?.slice(0, 240) || 'Empty comment.'}
                </span>
                <span>
                  {comment.parentId !== null
                    ? `Reply to #${comment.parentId}`
                    : comment.inline
                      ? comment.inline.path
                      : 'General comment'}
                  {comment.pending ? ' · Pending publication' : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {!pending && visible.length === 0 && <p>No comments match.</p>}
      {next !== null && (
        <button disabled={pending} onClick={() => setPage(next)}>
          Load more comments
        </button>
      )}
      {limited && <p>Comment limit reached (10,000 comments).</p>}
      <button
        disabled={pending}
        onClick={() => {
          setComments([]);
          setSelected(undefined);
          setNext(null);
          setPage(1);
          setAttempt(attempt + 1);
          setActive(0);
        }}
      >
        Refresh comments
      </button>
      {error && (
        <button disabled={pending} onClick={() => setAttempt(attempt + 1)}>
          Retry comments
        </button>
      )}
      {comment && (
        <SelectedComment
          comment={comment}
          parent={parent}
          onParent={(id) => {
            setQuery('');
            setSelected(id);
            setParentJump(id);
          }}
        />
      )}
    </section>
  );
}
