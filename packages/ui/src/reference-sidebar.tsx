import { useMemo, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { Ref, Snapshot } from '@openkraken/ipc-contract';
import { RefControls } from './ref-controls.js';
import { ReferenceActions } from './references.js';
import { referenceDragProps } from './reference-drop.js';
import { useRepository } from './store.js';

const groups = [
  ['local', 'Branches'],
  ['remote', 'Remotes'],
  ['tag', 'Tags'],
  ['stash', 'Stashes'],
  ['other', 'Other refs'],
] as const;
type Row = { kind: 'heading'; title: string } | { kind: 'ref'; reference: Ref; position: number };

function ReferenceRow({
  reference,
  snapshot,
  busy,
}: {
  reference: Ref;
  snapshot: Snapshot;
  busy: boolean;
}) {
  return (
    <div
      className={`ref ${reference.isHead ? 'current' : ''} ${snapshot.view.hiddenRefs.includes(reference.name) ? 'hidden-ref' : ''}`}
      data-reference-name={reference.name}
      {...referenceDragProps(reference, snapshot.repository.id, busy)}
      title={`${reference.name}\n${reference.target}`}
    >
      <div className="ref-label">
        <span>
          {reference.isHead ? '● ' : ''}
          {reference.shortName}
        </span>
        {reference.upstream && (
          <small>
            {reference.upstream.gone
              ? 'gone'
              : `↑${reference.upstream.ahead} ↓${reference.upstream.behind}`}
          </small>
        )}
      </div>
      <RefControls reference={reference} />
      <ReferenceActions reference={reference} />
    </div>
  );
}

function VirtualReferences({ snapshot, busy }: { snapshot: Snapshot; busy: boolean }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState<string>();
  const scroll = useRef<HTMLDivElement>(null);
  const { rows, count } = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const buckets = new Map<Ref['kind'], Ref[]>(groups.map(([kind]) => [kind, []]));
    for (const ref of snapshot.refs) {
      if (!search || ref.name.toLocaleLowerCase().includes(search))
        buckets.get(ref.kind)!.push(ref);
    }
    const rows: Row[] = [];
    let count = 0;
    for (const [kind, title] of groups) {
      const refs = buckets.get(kind)!;
      if (!refs.length) continue;
      rows.push({ kind: 'heading', title });
      for (const reference of refs) rows.push({ kind: 'ref', reference, position: ++count });
    }
    return { rows, count };
  }, [snapshot.refs, query]);
  const focusedIndex = useMemo(() => {
    const index = focused
      ? rows.findIndex((row) => row.kind === 'ref' && row.reference.name === focused)
      : -1;
    return index < 0 ? undefined : index;
  }, [rows, focused]);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    getItemKey: (index) => {
      const row = rows[index]!;
      return row.kind === 'ref' ? row.reference.name : row.title;
    },
    estimateSize: (index) => (rows[index]?.kind === 'heading' ? 48 : 120),
    overscan: 4,
    // A focused action or its modal must survive scrolling offscreen.
    rangeExtractor: (range) =>
      [
        ...new Set([
          ...defaultRangeExtractor(range),
          ...(focusedIndex === undefined ? [] : [focusedIndex]),
        ]),
      ].sort((a, b) => a - b),
  });
  return (
    <>
      <label className="reference-filter">
        Filter references
        <input
          value={query}
          maxLength={1000}
          onChange={(event) => {
            setQuery(event.target.value);
            scroll.current?.scrollTo(0, 0);
          }}
        />
      </label>
      <p className="reference-match-count" role="status">
        {count.toLocaleString()} matching references
      </p>
      <div
        className="reference-scroll"
        ref={scroll}
        role="list"
        aria-label="Reference list"
        tabIndex={0}
        onFocusCapture={(event) => {
          if (event.target instanceof HTMLElement) {
            const row = event.target.closest<HTMLElement>('[data-reference-name]');
            if (row) setFocused(row.dataset.referenceName);
          }
        }}
        onBlurCapture={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            setFocused(undefined);
        }}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const row = rows[item.index]!;
            return (
              <div
                key={item.key}
                ref={virtual.measureElement}
                data-index={item.index}
                role={row.kind === 'ref' ? 'listitem' : undefined}
                aria-posinset={row.kind === 'ref' ? row.position : undefined}
                aria-setsize={row.kind === 'ref' ? count : undefined}
                style={{
                  position: 'absolute',
                  top: 0,
                  width: '100%',
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {row.kind === 'heading' ? (
                  <h3>{row.title}</h3>
                ) : (
                  <ReferenceRow reference={row.reference} snapshot={snapshot} busy={busy} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

export function ReferenceSidebar() {
  const { snapshot, busy: active, syncing, setView } = useRepository();
  if (!snapshot) return null;
  const busy = !!active && !syncing;
  const large = snapshot.refs.length >= 100;
  return (
    <aside className={`refs${large ? ' virtualized-refs' : ''}`}>
      <h2>
        References <span>{snapshot.refs.length}</span>
      </h2>
      {(snapshot.view.hiddenRefs.length > 0 ||
        snapshot.view.soloRef ||
        snapshot.view.pinnedRef) && (
        <div className="view-summary" aria-label="Active graph view">
          {snapshot.view.hiddenRefs.length > 0 && (
            <p>{snapshot.view.hiddenRefs.length} hidden refs</p>
          )}
          {snapshot.view.soloRef && <p>Solo: {snapshot.view.soloRef}</p>}
          {snapshot.view.pinnedRef && <p>Pinned: {snapshot.view.pinnedRef}</p>}
          <button disabled={busy} onClick={() => void setView({ hiddenRefs: [] })}>
            Reset graph view
          </button>
        </div>
      )}
      {large ? (
        <VirtualReferences key={snapshot.repository.id} snapshot={snapshot} busy={busy} />
      ) : (
        groups.map(([kind, title]) => {
          const refs = snapshot.refs.filter((ref) => ref.kind === kind);
          return refs.length ? (
            <section key={kind}>
              <h3>{title}</h3>
              {refs.map((reference) => (
                <ReferenceRow
                  key={reference.name}
                  reference={reference}
                  snapshot={snapshot}
                  busy={busy}
                />
              ))}
            </section>
          ) : null;
        })
      )}
    </aside>
  );
}
