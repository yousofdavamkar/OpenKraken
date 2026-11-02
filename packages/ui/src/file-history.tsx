import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FileHistoryEntry } from '@openkraken/ipc-contract';
export function FileHistoryPanel({
  repoId,
  commit,
  pathBytes,
  onSelect,
}: {
  repoId: string;
  commit: string;
  pathBytes: string;
  onSelect: (entry: FileHistoryEntry) => void;
}) {
  const [entries, setEntries] = useState<FileHistoryEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setLoading(true);
    setError('');
    void window.openkraken
      .request({ id, method: 'fileHistory', repoId, options: { commit, pathBytes, offset } })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'error') setError(result.message);
        if (result.kind === 'fileHistory') {
          setEntries((current) =>
            offset === 0 ? result.page.entries : [...current, ...result.page.entries],
          );
          setNextOffset(result.page.nextOffset);
          setTruncated(!!result.page.truncated);
        }
      })
      .catch((error: unknown) => {
        if (alive) setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [repoId, commit, pathBytes, offset, attempt]);
  const virtual = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 52,
    overscan: 5,
  });
  return (
    <section className="file-history-panel" aria-label="File history">
      <h3>File history · {entries.length}</h3>
      {error && (
        <p role="alert">
          {error} <button onClick={() => setAttempt((value) => value + 1)}>Retry history</button>
        </p>
      )}
      <div ref={scroll} className="file-history-scroll">
        <ol
          aria-label="File revisions"
          style={{
            height: virtual.getTotalSize(),
            position: 'relative',
            listStyle: 'none',
            margin: 0,
            padding: 0,
          }}
        >
          {virtual.getVirtualItems().map((row) => {
            const entry = entries[row.index]!;
            return (
              <li
                key={entry.oid}
                style={{ position: 'absolute', top: row.start, height: row.size, width: '100%' }}
              >
                <button
                  title={`${entry.path}\n${entry.author} · ${new Date(entry.time * 1000).toLocaleString()}`}
                  onClick={() => onSelect(entry)}
                >
                  <strong>{entry.summary || entry.oid.slice(0, 8)}</strong>
                  <small>
                    {entry.oid.slice(0, 8)} · {entry.path} · {entry.author}
                  </small>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      {loading ? (
        <p role="status">Loading file history…</p>
      ) : nextOffset !== undefined && !error ? (
        <button onClick={() => setOffset(nextOffset)}>Load older file revisions</button>
      ) : (
        !error && <p>{truncated ? 'History display limit reached.' : 'End of file history.'}</p>
      )}
    </section>
  );
}
