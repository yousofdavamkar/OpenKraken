import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { RefBadge } from './history-model.js';

const PREVIEW_LIMIT = 3;
const NAME_LIMIT = 3;

export function CommitBadges({
  badges,
  oid,
  open,
}: {
  badges: readonly RefBadge[];
  oid: string;
  open: (opener: HTMLButtonElement) => void;
}) {
  const { count, overflow } = useMemo(
    () => ({
      count: badges.reduce((total, badge) => total + badge.names.length, 0),
      overflow:
        badges.length > PREVIEW_LIMIT || badges.some((badge) => badge.names.length > NAME_LIMIT),
    }),
    [badges],
  );
  const preview = (overflow ? badges.slice(0, PREVIEW_LIMIT) : badges).map((badge) => (
    <b
      className={`badge ${badge.kind}`}
      key={badge.kind + badge.label}
      title={
        badge.names.slice(0, NAME_LIMIT).join('\n') +
        (badge.names.length > NAME_LIMIT
          ? `\n… ${badge.names.length - NAME_LIMIT} more references`
          : '')
      }
    >
      {badge.label}
      {badge.names.length > 1 ? ` (${badge.names.length})` : ''}
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
  badges,
  close,
}: {
  oid: string;
  badges: readonly RefBadge[];
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const names = useMemo(() => badges.flatMap((badge) => badge.names), [badges]);
  const matches = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return search ? names.filter((name) => name.toLocaleLowerCase().includes(search)) : names;
  }, [names, query]);
  const virtual = useVirtualizer({
    count: matches.length,
    getScrollElement: () => scroll.current,
    getItemKey: (index) => matches[index]!,
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
