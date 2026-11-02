import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ProviderCheck, ProviderPullChecksPage } from '@openkraken/ipc-contract';
import type { PullContext } from './pull-review.js';
import { useProviderPoll } from './provider-polling.js';

export function PullChecks({ context }: { context: PullContext }) {
  const [rows, setRows] = useState<ProviderCheck[]>([]);
  const [summary, setSummary] = useState<Pick<ProviderPullChecksPage, 'state' | 'total'>>();
  const [after, setAfter] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const cursors = useRef(new Set<string>());
  const scroll = useRef<HTMLDivElement>(null);
  const { accountId, repository, detail } = context;
  const head = detail.head.sha,
    number = detail.number;
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setBusy(true);
    setError('');
    if (after === null) {
      setRows([]);
      setSummary(undefined);
      setNext(null);
      cursors.current.clear();
    }
    void window.openkraken
      .request({
        id,
        method: 'providerPullChecks',
        accountId,
        options: { repository, number, head, after },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'error') {
          setRows([]);
          setSummary(undefined);
          setNext(null);
          setError(result.message);
          setStale(result.code === 'STALE_PROVIDER_PULL');
        } else if (result.kind === 'providerPullChecks') {
          if (result.page.nextCursor && cursors.current.has(result.page.nextCursor)) {
            setRows([]);
            setSummary(undefined);
            setError('The provider repeated a check page. Refresh checks to start again.');
            setNext(null);
            return;
          }
          if (result.page.nextCursor) cursors.current.add(result.page.nextCursor);
          setSummary({ state: result.page.state, total: result.page.total });
          setRows((previous) =>
            result.page.state === null
              ? []
              : [
                  ...new Map(
                    [...previous, ...result.page.checks].map((row) => [row.id, row]),
                  ).values(),
                ],
          );
          setNext(result.page.nextCursor);
        } else if (result.kind === 'cancelled') {
          setRows([]);
          setSummary(undefined);
          setNext(null);
          setError('Check loading cancelled.');
        }
      })
      .catch(() => {
        if (alive) {
          setError('Check results could not be loaded.');
          setRows([]);
          setSummary(undefined);
          setNext(null);
        }
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [accountId, repository, number, head, after, attempt]);
  useProviderPoll(busy, `${number}/${head}/${after}/${pages}/${attempt}`, async (read) => {
    const checks = new Map<string, ProviderCheck>();
    const seen = new Set<string>();
    let cursor: string | null = null;
    let latest: ProviderPullChecksPage | undefined;
    let loaded = 0;
    for (let i = 0; i < Math.min(10, pages); i++) {
      const result = await read({
        method: 'providerPullChecks',
        accountId,
        options: { repository, number, head, after: cursor },
      });
      if (result.kind !== 'providerPullChecks')
        throw new Error('Check results could not be refreshed.');
      latest = result.page;
      loaded++;
      if (latest.state === null) {
        checks.clear();
        break;
      }
      for (const check of latest.checks) checks.set(check.id, check);
      cursor = latest.nextCursor;
      if (cursor === null) break;
      if (seen.has(cursor))
        throw new Error('The provider repeated a check page. Refresh checks to start again.');
      seen.add(cursor);
    }
    const page = latest!;
    return {
      commit: () => {
        setRows([...checks.values()]);
        setSummary({ state: page.state, total: page.total });
        setNext(page.nextCursor);
        setPages(loaded);
        cursors.current = seen;
        setStale(false);
        setError('');
      },
    };
  });
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 92,
    overscan: 5,
    getItemKey: (index) => rows[index]!.id,
  });
  const refresh = () => {
    setAfter(null);
    setPages(1);
    setAttempt((value) => value + 1);
    scroll.current?.scrollTo(0, 0);
  };
  return (
    <section aria-label="Pull-request checks">
      <p>
        Checks for head <code>{head}</code>
      </p>
      <p>Provider results can change. This is not a guarantee that branch rules allow merging.</p>
      {busy && <p role="status">Loading checks…</p>}
      {error && <p role="alert">{error}</p>}
      {summary && (
        <>
          <p>Provider rollup: {summary.state ?? 'No check results reported'}</p>
          <p>
            {rows.length} loaded · {summary.total} reported contexts
          </p>
          <div
            ref={scroll}
            className="pull-check-list"
            role="list"
            aria-label="Check results"
            tabIndex={0}
            onKeyDown={(event) => {
              if (rows.length && (event.key === 'Home' || event.key === 'End')) {
                event.preventDefault();
                virtual.scrollToIndex(event.key === 'Home' ? 0 : rows.length - 1, {
                  align: event.key === 'Home' ? 'start' : 'end',
                });
              }
            }}
          >
            <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
              {virtual.getVirtualItems().map((item) => {
                const row = rows[item.index]!;
                return (
                  <div
                    role="listitem"
                    aria-posinset={item.index + 1}
                    aria-setsize={rows.length}
                    key={item.key}
                    data-index={item.index}
                    ref={virtual.measureElement}
                    className="pull-check-row"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${item.start}px)`,
                    }}
                  >
                    <strong>{row.name}</strong>
                    <p>
                      {row.kind === 'check' ? 'Check run' : 'Commit status'} · {row.status}
                      {row.conclusion
                        ? ` · ${row.conclusion}`
                        : row.kind === 'check' && row.status === 'COMPLETED'
                          ? ' · Conclusion not reported'
                          : ''}
                    </p>
                    {row.description && <p>{row.description}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
      {next && pages >= 10 && (
        <p>
          The 1,000-context display limit was reached. Additional results are available on the
          provider.
        </p>
      )}
      <div className="dialog-actions">
        <button disabled={busy || stale} onClick={refresh}>
          Refresh checks
        </button>
        {next && pages < 10 && (
          <button
            disabled={busy || !!error}
            onClick={() => {
              setAfter(next);
              setPages((value) => value + 1);
              setAttempt((value) => value + 1);
            }}
          >
            Load more checks
          </button>
        )}
      </div>
    </section>
  );
}
