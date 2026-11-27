import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import { defaultRangeExtractor, measureElement, useVirtualizer } from '@tanstack/react-virtual';
import type { Ref, Snapshot } from '@openkraken/ipc-contract';
import { RefControls } from './ref-controls.js';
import { ReferenceActions, ReferenceDialog, type ReferenceReview } from './references.js';
import { referenceDragProps } from './reference-drop.js';
import { blockStart, blockLength, groupReferences, referenceGroups } from './reference-list.js';
import { useRepository } from './store.js';

// Estimates match the one-line rows and collapsible headings; measured heights replace them.
const headingHeightEstimate = 28;
const rowHeightEstimate = 26;
type ReviewHandler = (review: ReferenceReview) => void;
type Collapse = { collapsed: ReadonlySet<Ref['kind']>; toggle: (kind: Ref['kind']) => void };

function ReferenceRow({
  reference,
  snapshot,
  busy,
  onReview,
}: {
  onReview: ReviewHandler;
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
        <ReferenceActions reference={reference} onReview={onReview} />
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
  // The heading is named by its title; the toggle also reads out the count.
  return (
    <h3 className="ref-section-heading" aria-label={title}>
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
  reviewedName,
  onFilterFocus,
  onReview,
  collapse,
}: {
  snapshot: Snapshot;
  busy: boolean;
  reviewedName?: string;
  onFilterFocus: () => void;
  onReview: ReviewHandler;
  collapse: Collapse;
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState<string>();
  const scroll = useRef<HTMLDivElement>(null);
  const list = useMemo(
    () => groupReferences(snapshot.refs, query, collapse.collapsed),
    [snapshot.refs, query, collapse.collapsed],
  );
  const retain = reviewedName ?? focused;
  const focusedBlock = useMemo(() => (retain ? list.focusedBlock(retain) : -1), [list, retain]);
  const getItemKey = useCallback(
    (index: number) => {
      const section = list.section(index)!;
      return section.collapsed
        ? `section:${section.kind}`
        : list.refs[blockStart(section, index)]!.name;
    },
    [list],
  );
  const estimatedHeights = useRef(new Map<Ref['kind'], number>());
  const virtual = useVirtualizer({
    count: list.blocks,
    getScrollElement: () => scroll.current,
    getItemKey,
    estimateSize: (index) => {
      const section = list.section(index)!;
      return (
        (index === section.firstBlock && section.title ? headingHeightEstimate : 0) +
        blockLength(section, index) *
          (estimatedHeights.current.get(section.kind) ?? rowHeightEstimate)
      );
    },
    measureElement: (element, entry, instance) => {
      const height = measureElement(element, entry, instance);
      const index = instance.indexFromElement(element);
      const section = list.section(index);
      if (section && height > 0) {
        const heading = index === section.firstBlock && section.title ? headingHeightEstimate : 0;
        const refHeight = (height - heading) / blockLength(section, index);
        if (!section.collapsed && refHeight > 0)
          estimatedHeights.current.set(section.kind, refHeight);
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
  // so React can preserve focus when a ref moves to another block.
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
    const section = list.section(item.index)!;
    const start = blockStart(section, item.index);
    const end = start + blockLength(section, item.index);
    if (item.index === section.firstBlock && section.title)
      cells.push(
        <div key={section.title} style={{ gridRow: track++ }}>
          <SectionHeading
            kind={section.kind}
            title={section.title}
            count={section.total}
            collapse={collapse}
          />
        </div>,
      );
    for (let index = start; index < end; index++) {
      const reference = list.refs[index]!;
      cells.push(
        <div
          key={reference.name}
          style={{ gridRow: track++ }}
          role="listitem"
          aria-posinset={section.firstPosition + index - section.from}
          aria-setsize={list.listed}
        >
          <ReferenceRow reference={reference} snapshot={snapshot} busy={busy} onReview={onReview} />
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
          onFocus={onFilterFocus}
          maxLength={1000}
          onChange={(event) => {
            setQuery(event.target.value);
            scroll.current?.scrollTo(0, 0);
          }}
        />
      </label>
      <p className="reference-match-count" role="status">
        {list.count.toLocaleString()} matching references
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
  const { snapshot, busy, syncing } = useRepository();
  return (
    snapshot && (
      <RepositorySidebar
        key={snapshot.repository.id}
        snapshot={snapshot}
        busy={!!busy && !syncing}
      />
    )
  );
}

function RepositorySidebar({ snapshot, busy }: { snapshot: Snapshot; busy: boolean }) {
  const aside = useRef<HTMLElement>(null);
  const [review, setReview] = useState<ReferenceReview>();
  const present = useMemo(
    () => !review || snapshot.refs.some((ref) => ref.name === review.reference.name),
    [snapshot.refs, review],
  );
  if (!present) setReview(undefined);
  function closeReview() {
    aside.current?.querySelector<HTMLDialogElement>('dialog[open]')?.close();
    if (review) {
      const row = aside.current?.querySelector(
        `[data-reference-name="${CSS.escape(review.reference.name)}"]`,
      );
      row
        ?.querySelector<HTMLButtonElement>(`[data-review-action="${review.action}"]`)
        ?.focus({ preventScroll: true });
    }
    setReview(undefined);
  }
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
  // Once the user enters the filter, keep it available across ref refreshes.
  const [filterUsed, setFilterUsed] = useState(false);
  const large = snapshot.refs.length >= 100 || filterUsed;
  return (
    <aside ref={aside} className={`refs${large ? ' virtualized-refs' : ''}`}>
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
          <button
            disabled={busy}
            onClick={() => void useRepository.getState().setView({ hiddenRefs: [] })}
          >
            Reset graph view
          </button>
        </div>
      )}
      {large ? (
        <VirtualReferences
          snapshot={snapshot}
          busy={busy}
          reviewedName={review?.reference.name}
          onFilterFocus={() => setFilterUsed(true)}
          onReview={setReview}
          collapse={collapse}
        />
      ) : (
        referenceGroups.map(([kind, title]) => {
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
                    onReview={setReview}
                  />
                ))}
              </div>
            </section>
          ) : null;
        })
      )}
      {review && present && (
        <ReferenceDialog
          action={review.action}
          reference={review.reference}
          target={review.reference.target}
          close={closeReview}
        />
      )}
    </aside>
  );
}
