import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ProviderPullComment } from '@openkraken/ipc-contract';
import type { PullContext } from './pull-review.js';
import { pollNumberedPages, useProviderPoll } from './provider-polling.js';

export function PullComments({
  context,
  onReply,
  onLoaded,
}: {
  context: PullContext;
  onReply?: (id: number) => void;
  onLoaded?: () => void;
}) {
  const { accountId, repository, detail } = context;
  const [comments, setComments] = useState<ProviderPullComment[]>([]);
  const [page, setPage] = useState(1),
    [attempt, setAttempt] = useState(0);
  const [next, setNext] = useState<number | null>(null),
    [limited, setLimited] = useState(false);
  const [pending, setPending] = useState(true),
    [error, setError] = useState('');
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setPending(true);
    setError('');
    void window.openkraken
      .request({
        id,
        method: 'providerPullComments',
        accountId,
        options: { repository, number: detail.number, page },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'error') setError(result.message);
        if (result.kind === 'providerPullComments') {
          setComments((current) => {
            const unique = new Map(
              (page === 1 ? [] : current).map((comment) => [comment.id, comment]),
            );
            for (const comment of result.page.comments) unique.set(comment.id, comment);
            return [...unique.values()];
          });
          setNext(result.page.nextPage);
          setLimited(result.page.limited);
          loaded.current?.();
        }
      })
      .catch(() => {
        if (alive) setError('Review comments could not be loaded.');
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [accountId, repository, detail.number, page, attempt]);
  useProviderPoll(pending, `${detail.number}/${page}/${attempt}`, async (read) => {
    const result = await pollNumberedPages(
      page,
      async (page) => {
        const result = await read({
          method: 'providerPullComments',
          accountId,
          options: { repository, number: detail.number, page },
        });
        if (result.kind !== 'providerPullComments')
          throw new Error('Inline comments could not be refreshed.');
        return { ...result.page, items: result.page.comments };
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
  const threads = new Map<number, ProviderPullComment[]>();
  for (const comment of comments) {
    const id = comment.replyTo ?? comment.id;
    const thread = threads.get(id) ?? [];
    if (comment.replyTo === null) thread.unshift(comment);
    else thread.push(comment);
    threads.set(id, thread);
  }
  const rows = [...threads.values()].flat();
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 240,
    overscan: 2,
  });
  return (
    <section aria-label="Inline review comments">
      <p role="status">
        {comments.length} comments loaded{pending ? ' · Loading…' : ''}
      </p>
      <div
        ref={scroll}
        tabIndex={0}
        className="pr-comments"
        role="list"
        aria-label="Comment threads"
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const comment = rows[item.index]!;
            const threadId = comment.replyTo ?? comment.id;
            const outdated = comment.line === null && comment.originalLine !== null;
            return (
              <article
                role="listitem"
                key={comment.id}
                data-index={item.index}
                ref={virtual.measureElement}
                className={comment.replyTo === null ? 'pr-comment-root' : 'pr-comment-reply'}
                style={{
                  position: 'absolute',
                  top: 0,
                  transform: `translateY(${item.start}px)`,
                  width: '100%',
                }}
              >
                <p>
                  Thread #{threadId}
                  {comment.replyTo !== null ? ` · Reply #${comment.id}` : ''}
                </p>
                <strong>{comment.author ?? 'Deleted account'}</strong> ·{' '}
                <time dateTime={comment.createdAt}>
                  {new Date(comment.createdAt).toLocaleString()}
                </time>
                <p>
                  <code>{comment.path}</code> · {comment.side ?? 'File'}
                  {comment.line !== null
                    ? ` line ${comment.startLine ? `${comment.startLine}–` : ''}${comment.line}`
                    : outdated
                      ? ` · Outdated · original line ${comment.originalStartLine ? `${comment.originalStartLine}–` : ''}${comment.originalLine}`
                      : ' comment'}
                </p>
                {comment.replyTo !== null && !comments.some((entry) => entry.id === threadId) && (
                  <p>Original comment #{threadId} is not loaded.</p>
                )}
                <pre>{comment.body || 'No comment text.'}</pre>
                <details>
                  <summary>Comment diff context</summary>
                  <pre>{comment.hunk || 'No diff context supplied.'}</pre>
                  {comment.hunkTruncated && <p>Diff context is truncated.</p>}
                  <p>
                    Original commit: <code>{comment.originalCommitId}</code>
                  </p>
                </details>
                {onReply && (
                  <button
                    disabled={detail.state !== 'open' || detail.merged}
                    onClick={() => onReply(threadId)}
                  >
                    Reply to thread #{threadId}
                  </button>
                )}
              </article>
            );
          })}
        </div>
      </div>
      {error && (
        <p role="alert">
          {error}{' '}
          <button disabled={pending} onClick={() => setAttempt((value) => value + 1)}>
            Retry comments
          </button>
        </p>
      )}
      {next !== null && !error && (
        <button disabled={pending} onClick={() => setPage(next)}>
          Load more comments
        </button>
      )}
      {limited && <p>Showing at most 10,000 comments.</p>}
      <button
        disabled={pending}
        onClick={() => {
          setComments([]);
          setNext(null);
          setPage(1);
          setAttempt((value) => value + 1);
        }}
      >
        Refresh comments
      </button>
    </section>
  );
}
