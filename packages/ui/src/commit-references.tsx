import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Ref } from '@openkraken/ipc-contract';
import { groupRefBadges } from './history-model.js';

const PREVIEW_LIMIT = 3;

export function CommitBadges({
  refs,
  oid,
  open,
}: {
  refs: readonly Ref[];
  oid: string;
  open: (opener: HTMLButtonElement) => void;
}) {
  const { badges, overflow } = useMemo(() => groupRefBadges(refs, PREVIEW_LIMIT), [refs]);
  const count = refs.length;
  const preview = badges.map((badge) => (
    <b
      className={`badge ${badge.kind}`}
      key={badge.kind + badge.label}
      title={
        badge.names.join('\n') +
        (badge.nameCount > badge.names.length
          ? `\n… ${badge.nameCount - badge.names.length} more references`
          : '')
      }
    >
      {badge.label}
      {badge.nameCount > 1 ? ` (${badge.nameCount})` : ''}
    </b>
  ));
  if (!overflow) return <>{preview}</>;
  return (
    <span className="commit-ref-summary">
      <span className="commit-ref-preview">{preview}</span>
      <button
        type="button"
        className="badge commit-ref-overflow"
        aria-label={`Show all ${count.toLocaleString()} references for commit ${oid.slice(0, 8)}`}
        aria-haspopup="dialog"
        onClick={(event) => {
          event.stopPropagation();
          open(event.currentTarget);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {count.toLocaleString()} refs
      </button>
    </span>
  );
}

export function CommitReferencesDialog({
  oid,
  refs,
  close,
}: {
  oid: string;
  refs: readonly Ref[];
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const names = useMemo(() => groupRefBadges(refs).badges.flatMap((badge) => badge.names), [refs]);
  const matches = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return search ? names.filter((name) => name.toLocaleLowerCase().includes(search)) : names;
  }, [names, query]);
  const getItemKey = useCallback((index: number) => matches[index]!, [matches]);
  const virtual = useVirtualizer({
    count: matches.length,
    getScrollElement: () => scroll.current,
    getItemKey,
    estimateSize: () => 32,
    overscan: 6,
  });
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    filter.current?.focus();
    return () => {
      if (element.open) element.close();
    };
  }, []);
  const dismiss = () => {
    dialog.current?.close();
    close();
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog commit-references-dialog"
      aria-label="Commit references"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      <h2>Commit references</h2>
      <p>
        <code>{oid}</code>
      </p>
      <p>References in the current graph view.</p>
      <label>
        Filter commit references
        <input
          ref={filter}
          value={query}
          maxLength={1000}
          onChange={(event) => {
            setQuery(event.target.value);
            scroll.current?.scrollTo(0, 0);
          }}
        />
      </label>
      <p role="status">{matches.length.toLocaleString()} matching references</p>
      <div
        ref={scroll}
        className="commit-reference-list"
        role="list"
        aria-label="References at this commit"
        tabIndex={0}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => (
            <div
              key={item.key}
              role="listitem"
              aria-posinset={item.index + 1}
              aria-setsize={matches.length}
              className="commit-reference-name"
              title={matches[item.index]}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: item.size,
                transform: `translateY(${item.start}px)`,
              }}
            >
              <code>{matches[item.index]}</code>
            </div>
          ))}
        </div>
        {!matches.length && <p>No references match this filter.</p>}
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={dismiss}>
          Close
        </button>
      </div>
    </dialog>
  );
}
