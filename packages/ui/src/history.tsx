import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { passageBuckets } from '@openkraken/graph';
import { paintGraph, ROW_HEIGHT, LANE_WIDTH, GRAPH_PADDING } from '@openkraken/graph/canvas';
import { navigationTarget, refBadges, refNavigationTargets } from './history-model.js';
import { AuthorAvatar, useVisibleAvatars } from './avatars.js';
import { CommandButton } from './commands.js';
import { useRepository } from './store.js';
import { useTheme } from './theme.js';
import { CommitBadges, CommitReferencesDialog } from './commit-references.js';
import type { RefBadge } from './history-model.js';
const noBadges: RefBadge[] = [];
const dateFormatter = new Intl.DateTimeFormat();
export function History() {
  const theme = useTheme();
  const graphColors = useMemo(
    () => [
      theme.colors.graph1,
      theme.colors.graph2,
      theme.colors.graph3,
      theme.colors.graph4,
      theme.colors.graph5,
      theme.colors.graph6,
      theme.colors.graph7,
      theme.colors.graph8,
      theme.colors.graph9,
      theme.colors.graph10,
    ],
    [theme.colors],
  );
  const state = useRepository();
  const {
    snapshot,
    rows,
    layout,
    passages,
    maxColumns,
    query,
    matches,
    selection,
    paging,
    busy: active,
    syncing,
    searchResults,
    searching,
    searchTruncated,
  } = state;
  const busy = syncing ? undefined : active;
  const viewport = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    search = useRef<HTMLInputElement>(null);
  const [bounds, setBounds] = useState({ width: 500, height: 400 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [references, setReferences] = useState<{
    repoId: string;
    oid: string;
    opener: HTMLButtonElement;
  }>();
  useEffect(() => {
    setReferences((current) => (current?.repoId === snapshot?.repository.id ? current : undefined));
  }, [snapshot?.repository.id]);
  const closeReferences = () => {
    setReferences(undefined);
    if (references?.opener.isConnected) references.opener.focus({ preventScroll: true });
    else viewport.current?.focus({ preventScroll: true });
  };
  const graphWidth = Math.max(80, maxColumns * LANE_WIDTH + GRAPH_PADDING * 2);
  const totalWidth = graphWidth + 500;
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  useVisibleAvatars(virtual.getVirtualItems().map((item) => rows[item.index]!.author.email));
  const buckets = useMemo(() => passageBuckets(passages), [passages]);
  const selected = useMemo(() => new Set(selection.selected), [selection.selected]);
  const matching = useMemo(() => (matches ? new Set(matches) : undefined), [matches]);
  const synthetic = useMemo(
    () => new Set(rows.filter((r) => r.kind !== 'commit').map((r) => r.oid)),
    [rows],
  );
  const badges = useMemo(
    () => (snapshot ? refBadges(snapshot.refs, snapshot.view) : undefined),
    [snapshot?.refs, snapshot?.view],
  );
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => setBounds({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    paintGraph(ctx, layout, {
      width: Math.min(bounds.width, Math.max(0, graphWidth - scroll.left)),
      height: bounds.height,
      scrollTop: scroll.top,
      scrollLeft: scroll.left,
      dpr: devicePixelRatio,
      matches: matching,
      selected,
      synthetic,
      passages: buckets,
      colors: graphColors,
      background: theme.colors.background,
    });
  }, [
    layout,
    bounds,
    graphWidth,
    scroll,
    matching,
    selected,
    synthetic,
    buckets,
    graphColors,
    theme.colors.background,
  ]);
  useLayoutEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        performance.mark('repository-painted');
        if (performance.getEntriesByName('repository-open-start').length)
          performance.measure(
            'repository-first-paint',
            'repository-open-start',
            'repository-painted',
          );
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [snapshot?.cursor]);
  useEffect(() => {
    const index = rows.findIndex((r) => r.oid === selection.focus);
    if (index >= 0) virtual.scrollToIndex(index, { align: 'auto' });
  }, [selection.focus, snapshot?.cursor]);
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!snapshot) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      useRepository.setState({ selection: { ...selection, selected: rows.map((r) => r.oid) } });
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      useRepository.setState({ selection: { ...selection, selected: [] } });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      state.setDetail(rows.find((r) => r.oid === selection.focus));
      return;
    }
    const refs = refNavigationTargets(snapshot, rows);
    const target = navigationTarget(
      rows,
      selection.focus,
      event.key,
      event.shiftKey,
      refs.head,
      refs.upstream,
    );
    if (target) {
      event.preventDefault();
      void state.navigate(target);
    } else if (event.key === 'ArrowDown' && snapshot.hasMore && !paging) {
      event.preventDefault();
      void state.loadMore();
    }
  }
  const focused = rows.findIndex((r) => r.oid === selection.focus);
  const activeVisible = virtual.getVirtualItems().some((item) => item.index === focused);
  return (
    <>
      <div className="history-search">
        <CommandButton
          command="history.search"
          onClick={() => {
            search.current?.focus();
            search.current?.select();
          }}
        >
          Find commits
        </CommandButton>
        <input
          ref={search}
          aria-label="Search commits"
          placeholder="Search loaded history…"
          value={query}
          maxLength={200}
          onChange={(event) => void state.search(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              void state.search('');
              viewport.current?.focus();
            }
            if (event.key === 'Enter' && matches?.length) {
              const first = rows.find((r) => matching?.has(r.oid));
              if (first) state.select(first.oid);
              viewport.current?.focus();
            }
          }}
        />
        <span aria-live="polite">
          {query.trim() ? `${matches?.length ?? 0} loaded matches` : ''}
        </span>
        {query.trim() && (
          <button disabled={!!searching || !!busy} onClick={() => void state.searchAll()}>
            Search all history
          </button>
        )}
      </div>
      {searchResults && (
        <div className="search-results" aria-label="All history results">
          <p>
            Literal message/author matches · {searchResults.length}
            {searchTruncated ? '+' : ''} results
          </p>
          {!searchResults.length && <p>No matches in repository history.</p>}
          {searchResults.map((commit) => (
            <button
              key={commit.oid}
              onClick={() => {
                state.setDetail(commit);
                if (rows.some((r) => r.oid === commit.oid)) state.select(commit.oid);
              }}
            >
              <code>{commit.oid.slice(0, 8)}</code> {commit.summary}
            </button>
          ))}
        </div>
      )}
      <div
        className="column-head graph-columns"
        style={{
          gridTemplateColumns: `${graphWidth}px 80px minmax(160px, 1fr) 130px 90px`,
          minWidth: totalWidth,
          transform: `translateX(${-scroll.left}px)`,
        }}
      >
        <span>GRAPH</span>
        <span>COMMIT</span>
        <span>MESSAGE / REFS</span>
        <span>AUTHOR</span>
        <span>DATE</span>
      </div>
      <div className="graph-viewport">
        <canvas
          ref={canvas}
          data-testid="commit-graph"
          aria-hidden="true"
          className="graph-canvas"
          style={{
            width: Math.min(bounds.width, Math.max(0, graphWidth - scroll.left)),
            height: bounds.height,
          }}
        />
        <div
          className="history-scroll"
          ref={viewport}
          role="grid"
          aria-label="Commit history"
          tabIndex={0}
          aria-rowcount={rows.length}
          aria-colcount={5}
          aria-multiselectable="true"
          aria-activedescendant={activeVisible ? `commit-row-${focused}` : undefined}
          onKeyDown={keyDown}
          onScroll={(event) => {
            const element = event.currentTarget;
            setScroll({ top: element.scrollTop, left: element.scrollLeft });
            if (
              element.scrollTop > 0 &&
              element.scrollHeight - element.scrollTop - element.clientHeight < 280 &&
              !paging &&
              !busy &&
              !state.error
            )
              void state.loadMore();
          }}
        >
          <div
            className="history-space"
            style={{ height: virtual.getTotalSize(), minWidth: totalWidth }}
          >
            {virtual.getVirtualItems().map((item) => {
              const commit = rows[item.index]!;
              return (
                <div
                  id={`commit-row-${item.index}`}
                  className={`commit-row graph-columns ${selected.has(commit.oid) ? 'selected' : ''} ${matching && !matching.has(commit.oid) ? 'dimmed' : ''}`}
                  key={commit.oid}
                  role="row"
                  aria-selected={selected.has(commit.oid)}
                  aria-rowindex={item.index + 1}
                  data-oid={commit.oid}
                  data-column={layout[item.index]?.column}
                  style={{
                    transform: `translateY(${item.start}px)`,
                    gridTemplateColumns: `${graphWidth}px 80px minmax(160px, 1fr) 130px 90px`,
                  }}
                  onClick={(event) => {
                    state.select(
                      commit.oid,
                      event.shiftKey
                        ? 'range'
                        : event.ctrlKey || event.metaKey
                          ? 'toggle'
                          : 'single',
                    );
                    viewport.current?.focus({ preventScroll: true });
                  }}
                  onDoubleClick={() => state.setDetail(commit)}
                >
                  <span role="gridcell" className="graph-description">
                    <span className="sr-only">
                      {commit.kind !== 'commit'
                        ? commit.kind
                        : commit.isStash
                          ? 'Stash'
                          : commit.parents.length > 1
                            ? `Merge of ${commit.parents.length} parents`
                            : `${commit.parents.length} parent`}
                    </span>
                  </span>
                  <code role="gridcell">
                    {commit.kind === 'commit' ? commit.oid.slice(0, 8) : commit.kind.toUpperCase()}
                  </code>
                  <span role="gridcell" className="commit-subject" title={commit.body}>
                    <CommitBadges
                      badges={badges?.get(commit.oid) ?? noBadges}
                      oid={commit.oid}
                      open={(opener) => {
                        if (snapshot)
                          setReferences({
                            repoId: snapshot.repository.id,
                            oid: commit.oid,
                            opener,
                          });
                      }}
                    />
                    {commit.isStash && <b className="badge">stash</b>}
                    {commit.summary || '(empty message)'}
                  </span>
                  <span role="gridcell" className="author" title={commit.author.email}>
                    <AuthorAvatar name={commit.author.name} email={commit.author.email} />
                    {commit.author.name}
                  </span>
                  <time role="gridcell">
                    {commit.kind === 'commit'
                      ? dateFormatter.format(commit.author.time * 1000)
                      : ''}
                  </time>
                </div>
              );
            })}
          </div>
          {!rows.length && (
            <p className="empty">No commits yet. This repository is ready for its first commit.</p>
          )}
        </div>
      </div>
      <div className="history-bottom">
        <span>
          {selection.selected.length} selected · ↑↓ navigate · Shift+↑↓ ancestry · h HEAD · Enter
          details
        </span>
        {snapshot?.hasMore ? (
          <button disabled={!!paging || !!busy} onClick={() => void state.loadMore()}>
            {paging ? 'Loading…' : 'Load more commits'}
          </button>
        ) : (
          <span>End of history</span>
        )}
      </div>
      {references && references.repoId === snapshot?.repository.id && (
        <CommitReferencesDialog
          key={references.oid}
          oid={references.oid}
          badges={badges?.get(references.oid) ?? noBadges}
          close={closeReferences}
        />
      )}
    </>
  );
}
