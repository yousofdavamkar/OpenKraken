import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { WorkingDiff } from '@openkraken/ipc-contract';
type Row =
  | { kind: 'header'; hunk: number }
  | { kind: 'line'; line: WorkingDiff['hunks'][number]['lines'][number] };
export function WorkingDiffDialog({
  diff,
  busy,
  error,
  onApply,
  onClose,
}: {
  diff: WorkingDiff;
  busy: boolean;
  error?: string;
  onApply: (lines: number[]) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    scroll = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const rows = useMemo<Row[]>(
    () =>
      diff.hunks.flatMap((h, i) => [
        { kind: 'header', hunk: i } as Row,
        ...h.lines.map((line): Row => ({ kind: 'line', line })),
      ]),
    [diff],
  );
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: (i) => (rows[i]?.kind === 'header' ? 38 : 26),
    overscan: 10,
  });
  const changed = diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'context');
  const toggle = (ids: number[]) =>
    setSelected((previous) => {
      const next = new Set(previous),
        remove = ids.every((id) => previous.has(id));
      for (const id of ids) {
        if (remove) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  return (
    <dialog
      ref={dialog}
      className="working-diff"
      aria-label="Working file changes"
      onCancel={onClose}
    >
      <div className="diff-heading">
        <div>
          <h2>{diff.path}</h2>
          <p>{diff.side === 'index' ? 'Staged changes' : 'Unstaged changes'}</p>
        </div>
        <button onClick={onClose}>Close diff</button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {diff.partialReason ? (
        <p>{diff.partialReason}</p>
      ) : (
        <>
          <div className="diff-actions">
            <button onClick={() => toggle(changed.map((l) => l.id))}>
              {selected.size === changed.length ? 'Clear selection' : 'Select all changes'}
            </button>
            <span>{selected.size} changed lines selected</span>
            <button
              className="primary"
              disabled={busy || !selected.size}
              onClick={() => onApply([...selected])}
            >
              {diff.side === 'index' ? 'Unstage selected lines' : 'Stage selected lines'}
            </button>
          </div>
          <p className="diff-note">
            Within a replacement block, kept deleted lines stay before selected additions. Select
            the whole hunk to keep its complete replacement.
          </p>
          <div ref={scroll} className="diff-scroll">
            <div style={{ height: virtual.getTotalSize(), position: 'relative', minWidth: '100%' }}>
              {virtual.getVirtualItems().map((item) => {
                const row = rows[item.index]!;
                return (
                  <div
                    key={item.key}
                    className={`diff-row ${row.kind === 'line' ? row.line.kind : 'hunk'}`}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      minWidth: '100%',
                      height: item.size,
                      transform: `translateY(${item.start}px)`,
                    }}
                  >
                    {row.kind === 'header' ? (
                      <>
                        <button
                          disabled={busy}
                          aria-label={`Select hunk ${row.hunk + 1}`}
                          aria-pressed={diff.hunks[row.hunk]!.lines.filter(
                            (l) => l.kind !== 'context',
                          ).every((l) => selected.has(l.id))}
                          onClick={() =>
                            toggle(
                              diff.hunks[row.hunk]!.lines.filter((l) => l.kind !== 'context').map(
                                (l) => l.id,
                              ),
                            )
                          }
                        >
                          Select hunk {row.hunk + 1}
                        </button>
                        <code>
                          @@ -{diff.hunks[row.hunk]!.oldStart} +{diff.hunks[row.hunk]!.newStart} @@
                          {diff.hunks[row.hunk]!.header}
                        </code>
                      </>
                    ) : (
                      <>
                        <span className="diff-check">
                          {row.line.kind !== 'context' && (
                            <input
                              type="checkbox"
                              aria-label={`${row.line.kind === 'add' ? 'Add' : 'Remove'} line ${row.line.kind === 'add' ? row.line.newNo : row.line.oldNo}`}
                              checked={selected.has(row.line.id)}
                              disabled={busy}
                              onChange={() => toggle([row.line.id])}
                            />
                          )}
                        </span>
                        <span className="line-number">{row.line.oldNo}</span>
                        <span className="line-number">{row.line.newNo}</span>
                        <code className="diff-text">
                          {row.line.kind === 'add' ? '+' : row.line.kind === 'del' ? '−' : ' '}{' '}
                          {row.line.text}
                          {row.line.noNewline && (
                            <span className="no-newline"> ⏎ no final newline</span>
                          )}
                        </code>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </dialog>
  );
}
