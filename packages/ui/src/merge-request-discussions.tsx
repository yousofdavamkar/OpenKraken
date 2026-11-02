import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type {
  ProviderMergeRequestDetails,
  ProviderMergeRequestDiscussion,
  ProviderMergeRequestPosition,
  ProviderPullOptions,
} from '@openkraken/ipc-contract';
import { pollNumberedPages, useProviderPoll } from './provider-polling.js';

type Revision = ProviderMergeRequestDetails['diffRefs'];
function DiffContext({
  position,
  revision,
}: {
  position: ProviderMergeRequestPosition;
  revision: Revision;
}) {
  const matches =
    revision &&
    revision.base === position.revision.base &&
    revision.head === position.revision.head &&
    revision.start === position.revision.start;
  return (
    <div>
      <p>
        {!revision
          ? 'Displayed diff is not ready'
          : matches
            ? 'Matches displayed diff'
            : 'Different diff revision'}
      </p>
      <p>
        <code>{position.oldPath}</code> → <code>{position.newPath}</code>
      </p>
      {position.kind === 'text' ? (
        <>
          {position.oldLine !== null && <p>Old line {position.oldLine}</p>}
          {position.newLine !== null && <p>New line {position.newLine}</p>}
          {position.oldLine === null && position.newLine === null && (
            <p>Line location unavailable.</p>
          )}
          {position.range && (
            <p>
              Range: {position.range.start.side} line{' '}
              {position.range.start.side === 'old'
                ? position.range.start.oldLine
                : position.range.start.newLine}{' '}
              → {position.range.end.side} line{' '}
              {position.range.end.side === 'old'
                ? position.range.end.oldLine
                : position.range.end.newLine}
            </p>
          )}
        </>
      ) : position.kind === 'image' ? (
        <p>
          Image position: x {position.x ?? 'unavailable'}, y {position.y ?? 'unavailable'} ·{' '}
          {position.width ?? '?'} × {position.height ?? '?'}
        </p>
      ) : (
        <p>File-level discussion</p>
      )}
      <p>
        Merge base: <code>{position.revision.base}</code>
      </p>
      <p>
        Source tip: <code>{position.revision.head}</code>
      </p>
      <p>
        Target tip: <code>{position.revision.start}</code>
      </p>
    </div>
  );
}
function DiscussionNotes({
  discussion,
  revision,
}: {
  discussion: ProviderMergeRequestDiscussion;
  revision: Revision;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [active, setActive] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const notes = discussion.notes;
  const virtual = useVirtualizer({
    count: notes.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 240,
    overscan: 2,
    getItemKey: (index) => notes[index]!.id,
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), ...(notes[active] ? [active] : [])])].sort(
        (a, b) => a - b,
      ),
  });
  return (
    <section aria-label="Selected discussion">
      <h4>Discussion #{notes[0]!.id}</h4>
      <p>
        {notes.length} notes · {discussion.individual ? 'Individual comment' : 'Thread'}
      </p>
      <div
        ref={scroll}
        className="pr-comments"
        role="list"
        aria-label="Discussion notes"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          let index = active;
          if (event.key === 'Home') index = 0;
          else if (event.key === 'End') index = notes.length - 1;
          else if (event.key === 'ArrowDown') index++;
          else if (event.key === 'ArrowUp') index--;
          else return;
          event.preventDefault();
          index = Math.max(0, Math.min(index, notes.length - 1));
          setActive(index);
          virtual.scrollToIndex(index);
        }}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const note = notes[item.index]!;
            return (
              <article
                key={note.id}
                ref={virtual.measureElement}
                data-index={item.index}
                data-active={active === item.index}
                role="listitem"
                className={item.index === 0 ? 'pr-comment-root' : 'pr-comment-reply'}
                style={{
                  position: 'absolute',
                  top: 0,
                  transform: `translateY(${item.start}px)`,
                  width: '100%',
                }}
              >
                <p>
                  {note.system ? 'System note' : item.index === 0 ? 'Comment' : 'Reply'} #{note.id}
                </p>
                <strong>{note.author ?? 'Deleted account'}</strong> ·{' '}
                <time dateTime={note.createdAt}>{new Date(note.createdAt).toLocaleString()}</time>
                {note.resolvable && (
                  <p>
                    {note.resolved === null
                      ? 'Resolution unavailable'
                      : note.resolved
                        ? `Resolved${note.resolvedBy ? ` by ${note.resolvedBy}` : ''}`
                        : 'Unresolved'}
                    {note.resolvedAt && (
                      <>
                        {' '}
                        ·{' '}
                        <time dateTime={note.resolvedAt}>
                          {new Date(note.resolvedAt).toLocaleString()}
                        </time>
                      </>
                    )}
                  </p>
                )}
                <pre>{note.body}</pre>
                {note.position ? (
                  <>
                    <button
                      aria-expanded={expanded.has(note.id)}
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (next.has(note.id)) next.delete(note.id);
                          else next.add(note.id);
                          return next;
                        })
                      }
                    >
                      {expanded.has(note.id) ? 'Hide' : 'Show'} diff context for note #{note.id}
                    </button>
                    {expanded.has(note.id) && (
                      <DiffContext position={note.position} revision={revision} />
                    )}
                  </>
                ) : (
                  note.type === 'DiffNote' && <p>Diff location unavailable.</p>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
export function MergeRequestDiscussions({
  accountId,
  repository,
  number,
  revision,
}: ProviderPullOptions & { accountId: string; revision: Revision }) {
  const [discussions, setDiscussions] = useState<ProviderMergeRequestDiscussion[]>([]);
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [limited, setLimited] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<string>();
  const scroll = useRef<HTMLDivElement>(null);
  const restoreScroll = useRef<number | undefined>(undefined);
  const listId = useId();
  useLayoutEffect(() => {
    if (restoreScroll.current !== undefined && scroll.current)
      scroll.current.scrollTop = restoreScroll.current;
    restoreScroll.current = undefined;
  }, [discussions]);
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setPending(true);
    setError('');
    void window.openkraken
      .request({
        id,
        method: 'providerMergeRequestDiscussions',
        accountId,
        options: { repository, number, page },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'error') setError(result.message);
        else if (result.kind === 'providerMergeRequestDiscussions') {
          setDiscussions((current) => {
            const unique = new Map(
              (page === 1 ? [] : current).map((discussion) => [discussion.id, discussion]),
            );
            for (const discussion of result.page.discussions) unique.set(discussion.id, discussion);
            return [...unique.values()];
          });
          setNext(result.page.nextPage);
          setLimited(result.page.limited);
        }
      })
      .catch(() => {
        if (alive) setError('Discussions could not be loaded.');
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [accountId, repository, number, page, attempt]);
  const search = query.trim().toLocaleLowerCase();
  const matches = (discussion: ProviderMergeRequestDiscussion) =>
    !search ||
    discussion.notes.some((note) =>
      `#${note.id} ${note.author ?? ''} ${note.body} ${note.position?.oldPath ?? ''} ${note.position?.newPath ?? ''}`
        .toLocaleLowerCase()
        .includes(search),
    );
  const visible = discussions.filter(matches);
  useProviderPoll(pending, `${number}/${page}/${attempt}`, async (read) => {
    const activeId = visible[active]?.id;
    const top = Math.floor((scroll.current?.scrollTop ?? 0) / 56);
    const anchor = visible[top]?.id;
    const offset = (scroll.current?.scrollTop ?? 0) % 56;
    const result = await pollNumberedPages(
      page,
      async (page) => {
        const result = await read({
          method: 'providerMergeRequestDiscussions',
          accountId,
          options: { repository, number, page },
        });
        if (result.kind !== 'providerMergeRequestDiscussions')
          throw new Error('Discussions could not be refreshed.');
        return { ...result.page, items: result.page.discussions };
      },
      (discussion) => discussion.id,
    );
    const filtered = result.items.filter(matches);
    return {
      commit: () => {
        const index = filtered.findIndex((discussion) => discussion.id === activeId);
        const anchorIndex = filtered.findIndex((discussion) => discussion.id === anchor);
        restoreScroll.current =
          anchorIndex >= 0 ? anchorIndex * 56 + offset : scroll.current?.scrollTop;
        setDiscussions(result.items);
        setNext(result.nextPage);
        setLimited(result.limited);
        setError('');
        setActive(index >= 0 ? index : Math.max(0, Math.min(active, filtered.length - 1)));
        if (!result.items.some((discussion) => discussion.id === selected)) setSelected(undefined);
      },
    };
  });
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
  const discussion = discussions.find((discussion) => discussion.id === selected);
  return (
    <section aria-label="Merge-request discussions">
      <label>
        Search loaded discussions
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
      <p role="status">
        {discussions.length} discussions loaded · {visible.length} match
        {pending ? ' · Loading…' : ''}
      </p>
      <div
        ref={scroll}
        className="provider-repositories pull-list"
        role="listbox"
        aria-label="Discussions"
        tabIndex={0}
        aria-activedescendant={visible[active] ? `${listId}-${visible[active].id}` : undefined}
        onKeyDown={(event) => {
          let index = active;
          if (event.key === 'ArrowDown') index++;
          else if (event.key === 'ArrowUp') index--;
          else if (event.key === 'Home') index = 0;
          else if (event.key === 'End') index = visible.length - 1;
          else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (visible[active]) setSelected(visible[active].id);
            return;
          } else return;
          event.preventDefault();
          index = Math.max(0, Math.min(index, visible.length - 1));
          setActive(index);
          virtual.scrollToIndex(index);
        }}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const entry = visible[item.index]!;
            const root = entry.notes[0]!;
            return (
              <div
                key={entry.id}
                id={`${listId}-${entry.id}`}
                role="option"
                aria-label={`Open discussion #${root.id}`}
                aria-selected={entry.id === selected}
                aria-posinset={item.index + 1}
                aria-setsize={visible.length}
                data-active={active === item.index}
                className="provider-repository"
                style={{ position: 'absolute', top: item.start, height: item.size, width: '100%' }}
                onClick={() => {
                  setActive(item.index);
                  setSelected(entry.id);
                  scroll.current?.focus();
                }}
              >
                <strong>
                  #{root.id} · {root.author ?? 'Deleted account'} · {entry.notes.length} notes
                </strong>
                <span>{root.body.slice(0, 160)}</span>
              </div>
            );
          })}
        </div>
      </div>
      {!pending && !error && !visible.length && (
        <p>{discussions.length ? 'No loaded discussions match.' : 'No discussions yet.'}</p>
      )}
      {error && (
        <p role="alert">
          {error}{' '}
          <button disabled={pending} onClick={() => setAttempt((value) => value + 1)}>
            Retry discussions
          </button>
        </p>
      )}
      {next !== null && !error && (
        <button disabled={pending} onClick={() => setPage(next)}>
          Load more discussions
        </button>
      )}
      {limited && <p>Showing at most 1,000 discussions. Further discussions may be omitted.</p>}
      <button
        disabled={pending}
        onClick={() => {
          setPage(1);
          setAttempt((value) => value + 1);
          setSelected(undefined);
          setNext(null);
          setActive(0);
          scroll.current?.scrollTo(0, 0);
        }}
      >
        Refresh discussions
      </button>
      <p>Search covers loaded notes. Use arrow keys and Enter to open a discussion.</p>
      {discussion && (
        <DiscussionNotes key={discussion.id} discussion={discussion} revision={revision} />
      )}
    </section>
  );
}
