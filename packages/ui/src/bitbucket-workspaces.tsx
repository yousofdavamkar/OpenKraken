import { useEffect, useId, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { ProviderBitbucketWorkspace } from '@openkraken/ipc-contract';

export function BitbucketWorkspaces({
  accountId,
  onSelect,
}: {
  accountId: string;
  onSelect: (workspace: ProviderBitbucketWorkspace) => void;
}) {
  const [workspaces, setWorkspaces] = useState<ProviderBitbucketWorkspace[]>([]);
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [limited, setLimited] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setPending(true);
    setError('');
    void window.openkraken
      .request({ id, method: 'providerBitbucketWorkspaces', accountId, page })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'error') setError(result.message);
        else if (result.kind === 'providerBitbucketWorkspaces') {
          setWorkspaces((current) => {
            const unique = new Map(
              (page === 1 ? [] : current).map((workspace) => [workspace.id, workspace]),
            );
            for (const workspace of result.page.workspaces) unique.set(workspace.id, workspace);
            return [...unique.values()];
          });
          setNextPage(result.page.nextPage);
          setLimited(result.page.limited);
        }
      })
      .catch(() => {
        if (alive) setError('Workspaces could not be loaded.');
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [accountId, page, attempt]);
  const visible = workspaces.filter((workspace) =>
    workspace.slug.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
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
    <section aria-label="Bitbucket workspaces">
      <label>
        Search loaded workspaces
        <input
          type="search"
          value={query}
          maxLength={1000}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault();
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            scroll.current?.scrollTo(0, 0);
          }}
        />
      </label>
      <p role="status">
        {workspaces.length} workspaces loaded · {visible.length} match{pending ? ' · Loading…' : ''}
      </p>
      <div
        ref={scroll}
        className="provider-repositories"
        role="listbox"
        aria-label="Workspaces"
        tabIndex={0}
        aria-activedescendant={visible[active] ? `${listId}-${visible[active].id}` : undefined}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') activate(active + 1);
          else if (event.key === 'ArrowUp') activate(active - 1);
          else if (event.key === 'Home') activate(0);
          else if (event.key === 'End') activate(visible.length - 1);
          else if (event.key === 'Enter' || event.key === ' ') {
            if (visible[active]) onSelect(visible[active]);
          } else return;
          event.preventDefault();
        }}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const workspace = visible[item.index]!;
            return (
              <div
                key={workspace.id}
                id={`${listId}-${workspace.id}`}
                role="option"
                aria-posinset={item.index + 1}
                aria-setsize={visible.length}
                aria-selected={item.index === active}
                aria-label={`Select workspace ${workspace.slug}`}
                className="provider-repository"
                style={{ position: 'absolute', top: item.start, height: item.size, width: '100%' }}
                onClick={() => onSelect(workspace)}
              >
                <strong>{workspace.slug}</strong>
              </div>
            );
          })}
        </div>
      </div>
      {!pending && !error && visible.length === 0 && (
        <p>
          {workspaces.length
            ? 'No loaded workspaces match.'
            : 'No workspaces available to this account.'}
        </p>
      )}
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" disabled={pending} onClick={() => setAttempt((value) => value + 1)}>
            Retry workspaces
          </button>
        </p>
      )}
      {nextPage !== null && !error && (
        <button type="button" disabled={pending} onClick={() => setPage(nextPage)}>
          Load more workspaces
        </button>
      )}
      {limited && <p>Showing at most 10,000 workspaces.</p>}
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setWorkspaces([]);
          setNextPage(null);
          setLimited(false);
          setPage(1);
          setAttempt((value) => value + 1);
          setActive(0);
          scroll.current?.scrollTo(0, 0);
        }}
      >
        Refresh workspaces
      </button>
      <p>
        Choose a workspace to browse its repositories. Search covers loaded workspaces. Use arrow
        keys and Enter to choose.
      </p>
    </section>
  );
}
