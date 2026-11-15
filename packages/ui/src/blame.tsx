import { subscribeDesktopEvents } from './desktop-events.js';
import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { BlameLine } from '@openkraken/ipc-contract';
export function BlamePanel({
  repoId,
  commit,
  pathBytes,
}: {
  repoId: string;
  commit: string;
  pathBytes: string;
}) {
  const [lines, setLines] = useState<BlameLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    let pending: BlameLine[] = [],
      frame: number | undefined;
    setLines([]);
    setLoading(true);
    setError('');
    const flush = () => {
      frame = undefined;
      if (alive && pending.length) {
        const rows = pending;
        pending = [];
        setLines((current) => [...current, ...rows]);
      }
    };
    const unsubscribe = subscribeDesktopEvents((event) => {
      if (event.type !== 'blameLines' || event.id !== id || !alive) return;
      pending.push(...event.lines);
      frame ??= requestAnimationFrame(flush);
    });
    void window.openkraken
      .request({ id, method: 'blame', repoId, options: { commit, pathBytes } })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'error') setError(result.message);
        if (frame !== undefined) cancelAnimationFrame(frame);
        flush();
      })
      .catch((error: unknown) => {
        if (alive) setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      unsubscribe();
      if (frame !== undefined) cancelAnimationFrame(frame);
      void window.openkraken.cancel(id);
    };
  }, [repoId, commit, pathBytes]);
  const virtual = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 26,
    overscan: 10,
  });
  return (
    <section className="blame-panel" aria-label="File blame">
      <p role="status">
        {loading
          ? `Loading attribution · ${lines.length.toLocaleString()} lines`
          : `${lines.length.toLocaleString()} lines attributed`}
      </p>
      {error && (
        <p role="alert">
          {error}
          {lines.length > 0 && ' · Attribution is incomplete.'}
        </p>
      )}
      <div className="blame-scroll" ref={scroll} tabIndex={0}>
        <ol
          aria-label="Attributed lines"
          style={{
            height: virtual.getTotalSize(),
            position: 'relative',
            listStyle: 'none',
            margin: 0,
            padding: 0,
          }}
        >
          {virtual.getVirtualItems().map((item) => {
            const row = lines[item.index]!;
            return (
              <li
                key={row.line}
                className="blame-line"
                style={{ position: 'absolute', top: item.start, height: item.size }}
              >
                <span
                  className="blame-attribution"
                  title={`${row.summary}\n${row.author} <${row.email}>\n${new Date(row.time * 1000).toLocaleString()}\nOriginal line ${row.originalLine}`}
                >
                  <code>{row.oid.slice(0, 8)}</code>
                  <span>{row.author}</span>
                </span>
                <span className="line-number">{row.line}</span>
                <code>{row.text}</code>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
