import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import { defaultRangeExtractor, measureElement, useVirtualizer } from '@tanstack/react-virtual';
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
type ReferenceBlock = {
  kind: Ref['kind'];
  refs: Ref[];
  title?: string;
  total: number;
  firstPosition: number;
};
type Collapse = { collapsed: ReadonlySet<Ref['kind']>; toggle: (kind: Ref['kind']) => void };
const refsPerBlock = 4;
const headingHeightEstimate = 48;

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
      <div className="ref-actions">
        <RefControls reference={reference} />
        <ReferenceActions reference={reference} />
      </div>
    </div>
  );
}

function SectionHeading({
  kind,
  title,
  count,
  collapse,
}: {
  kind: Ref['kind'];
  title: string;
  count: number;
  collapse: Collapse;
}) {
  return (
    <h3 className="ref-section-heading">
      <button
        type="button"
        aria-expanded={!collapse.collapsed.has(kind)}
        onClick={() => collapse.toggle(kind)}
      >
        {title}
        <span className="ref-section-count">{count.toLocaleString()}</span>
      </button>
    </h3>
  );
}

function VirtualReferences({
  snapshot,
  busy,
  collapse,
}: {
  snapshot: Snapshot;
  busy: boolean;
  collapse: Collapse;
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState<string>();
  const scroll = useRef<HTMLDivElement>(null);
  const { blocks, count, listed } = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const buckets = new Map<Ref['kind'], Ref[]>(groups.map(([kind]) => [kind, []]));
    for (const ref of snapshot.refs) {
      if (!search || ref.name.toLocaleLowerCase().includes(search))
        buckets.get(ref.kind)!.push(ref);
    }
    const blocks: ReferenceBlock[] = [];
    let count = 0,
      listed = 0;
    for (const [kind, title] of groups) {
      const matches = buckets.get(kind)!;
      count += matches.length;
      if (!matches.length) continue;
      if (collapse.collapsed.has(kind)) {
        // A collapsed section keeps its heading so it can be expanded again.
        blocks.push({ kind, refs: [], title, total: matches.length, firstPosition: listed + 1 });
        continue;
      }
      for (let start = 0; start < matches.length; start += refsPerBlock) {
        const refs = matches.slice(start, start + refsPerBlock);
        blocks.push({
          kind,
          refs,
          title: start === 0 ? title : undefined,
          total: matches.length,
          firstPosition: listed + 1,
        });
        listed += refs.length;
      }
    }
    return { blocks, count, listed };
  }, [snapshot.refs, query, collapse.collapsed]);
  const focusedBlock = useMemo(
    () =>
      focused ? blocks.findIndex((block) => block.refs.some((ref) => ref.name === focused)) : -1,
    [blocks, focused],
  );
  const getItemKey = useCallback(
    (index: number) => blocks[index]!.refs[0]?.name ?? `section:${blocks[index]!.kind}`,
    [blocks],
  );
  const estimatedHeights = useRef(new Map<Ref['kind'], number>());
  const virtual = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scroll.current,
    getItemKey,
    estimateSize: (index) => {
      const block = blocks[index]!;
      return (
        (block.title ? headingHeightEstimate : 0) +
        block.refs.length * (estimatedHeights.current.get(block.kind) ?? 120)
      );
    },
    measureElement: (element, entry, instance) => {
      const height = measureElement(element, entry, instance);
      const block = blocks[instance.indexFromElement(element)];
      if (block && height > 0) {
        const refHeight = (height - (block.title ? headingHeightEstimate : 0)) / block.refs.length;
        if (block.refs.length && refHeight > 0) estimatedHeights.current.set(block.kind, refHeight);
      }
      return height;
    },
    overscan: 1,
    // A focused action or its modal must survive scrolling offscreen.
    rangeExtractor: (range) =>
      [
        ...new Set([...defaultRangeExtractor(range), ...(focusedBlock < 0 ? [] : [focusedBlock])]),
      ].sort((a, b) => a - b),
  });
  // One element measures all grid rows in a block. The controls share a parent
  // so React keeps a focused dialog mounted when a ref moves to another block.
  const cells: ReactElement[] = [];
  let track = 1;
  let previousEnd = 0;
  for (const item of virtual.getVirtualItems()) {
    const gap = item.start - previousEnd;
    if (gap > 0) {
      cells.push(
        <div
          key={'gap-' + item.key}
          aria-hidden="true"
          style={{ gridRow: track++, height: gap }}
        />,
      );
    }
    const firstTrack = track;
    const block = blocks[item.index]!;
    if (block.title)
      cells.push(
        <div key={block.title} style={{ gridRow: track++ }}>
          <SectionHeading
            kind={block.kind}
            title={block.title}
            count={block.total}
            collapse={collapse}
          />
        </div>,
      );
    for (const [index, reference] of block.refs.entries()) {
      cells.push(
        <div
          key={reference.name}
          style={{ gridRow: track++ }}
          role="listitem"
          aria-posinset={block.firstPosition + index}
          aria-setsize={listed}
        >
          <ReferenceRow reference={reference} snapshot={snapshot} busy={busy} />
        </div>,
      );
    }
    cells.push(
      <div
        key={'measure-' + item.key}
        aria-hidden="true"
        ref={virtual.measureElement}
        data-index={item.index}
        style={{ gridRow: firstTrack + ' / ' + track, pointerEvents: 'none' }}
      />,
    );
    previousEnd = item.end;
  }
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
            setFocused(row?.dataset.referenceName);
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
        <div className="reference-grid" style={{ height: virtual.getTotalSize() }}>
          {cells}
        </div>
      </div>
    </>
  );
}

export function ReferenceSidebar() {
  const { snapshot, busy: active, syncing, setView } = useRepository();
  const [collapsed, setCollapsed] = useState<ReadonlySet<Ref['kind']>>(new Set());
  const collapse: Collapse = {
    collapsed,
    toggle: (kind) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (!next.delete(kind)) next.add(kind);
        return next;
      }),
  };
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
        <VirtualReferences
          key={snapshot.repository.id}
          snapshot={snapshot}
          busy={busy}
          collapse={collapse}
        />
      ) : (
        groups.map(([kind, title]) => {
          const refs = snapshot.refs.filter((ref) => ref.kind === kind);
          return refs.length ? (
            <section key={kind}>
              <SectionHeading kind={kind} title={title} count={refs.length} collapse={collapse} />
              <div hidden={collapsed.has(kind)}>
                {refs.map((reference) => (
                  <ReferenceRow
                    key={reference.name}
                    reference={reference}
                    snapshot={snapshot}
                    busy={busy}
                  />
                ))}
              </div>
            </section>
          ) : null;
        })
      )}
    </aside>
  );
}
