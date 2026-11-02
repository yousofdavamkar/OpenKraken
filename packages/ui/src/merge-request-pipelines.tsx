import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type {
  ProviderMergePipeline,
  ProviderMergePipelineDetails,
  ProviderMergePipelineJob,
  ProviderMergePipelinesOptions,
} from '@openkraken/ipc-contract';
import { pollNumberedPages, useProviderPoll, type PollRead } from './provider-polling.js';

type Row = ProviderMergePipeline | ProviderMergePipelineJob;
type Context = Omit<ProviderMergePipelinesOptions, 'page'> & { accountId: string };
type Selection = { id: string; sha: string; page: number };
const label = (row: Row) =>
  'stage' in row
    ? `#${row.id} ${row.name} ${row.stage} ${row.status}`
    : `#${row.id} ${row.name ?? ''} ${row.ref} ${row.status} ${row.sha}`;

export function MergeRequestPipelines(props: Context) {
  return <PipelinePages {...props} />;
}

function PipelinePages({
  accountId,
  repository,
  number,
  head,
  pipeline,
}: Context & { pipeline?: Selection }) {
  const kind = pipeline ? 'jobs' : 'pipelines';
  const title = pipeline ? 'Jobs' : 'Pipelines';
  const [rows, setRows] = useState<Row[]>([]);
  const [details, setDetails] = useState<ProviderMergePipelineDetails>();
  const [page, setPage] = useState(1);
  const [next, setNext] = useState<number | null>(null);
  const [limited, setLimited] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const sources = useRef(new Map<string, number>());
  const scroll = useRef<HTMLDivElement>(null);
  const listId = useId();
  const pipelineId = pipeline?.id,
    pipelineSha = pipeline?.sha,
    pipelinePage = pipeline?.page;
  const load = useCallback(
    async (page: number, read: PollRead) => {
      const options = { repository, number, head, page };
      const result = await read(
        pipelineId && pipelineSha && pipelinePage
          ? {
              method: 'providerMergeRequestPipelineJobs',
              accountId,
              options: { ...options, pipelineId, pipelineSha, pipelinePage },
            }
          : { method: 'providerMergeRequestPipelines', accountId, options },
      );
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'providerMergeRequestPipelines')
        return { ...result.page, items: result.page.pipelines as Row[], details: undefined };
      if (result.kind === 'providerMergeRequestPipelineJobs')
        return { ...result.page, items: result.page.jobs as Row[], details: result.page.pipeline };
      throw new Error('Pipeline loading was cancelled.');
    },
    [accountId, repository, number, head, pipelineId, pipelineSha, pipelinePage],
  );
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setPending(true);
    setError('');
    void load(page, (request) => window.openkraken.request({ ...request, id }))
      .then((result) => {
        if (!alive) return;
        if (page === 1) sources.current.clear();
        for (const item of result.items) sources.current.set(item.id, page);
        setRows((current) => [
          ...new Map(
            [...(page === 1 ? [] : current), ...result.items].map((row) => [row.id, row]),
          ).values(),
        ]);
        setDetails(result.details);
        setNext(result.nextPage);
        setLimited(result.limited);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setError(error instanceof Error ? error.message : 'Pipeline data could not be loaded.');
        setRows([]);
        setSelected(undefined);
        setDetails(undefined);
        setNext(null);
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [load, page, attempt]);
  const visible = rows.filter((row) => label(row).toLowerCase().includes(query.toLowerCase()));
  const activeIndex = Math.max(0, Math.min(active, visible.length - 1));
  useProviderPoll(
    pending,
    `${number}/${head}/${pipelineId}/${pipelineSha}/${pipelinePage}/${page}/${attempt}`,
    async (read) => {
      const refreshedPages = new Map<string, number>();
      let metadata: ProviderMergePipelineDetails | undefined;
      const result = await pollNumberedPages(
        page,
        async (page) => {
          const result = await load(page, read);
          for (const item of result.items) refreshedPages.set(item.id, page);
          metadata = result.details;
          return result;
        },
        (row) => row.id,
      );
      const old = rows.find((row) => row.id === selected);
      const fresh = result.items.find((row) => row.id === selected);
      const resetChildren =
        !pipeline &&
        !!old &&
        (!fresh ||
          ('sha' in old && 'sha' in fresh && old.sha !== fresh.sha) ||
          sources.current.get(old.id) !== refreshedPages.get(old.id));
      const activeId = visible[activeIndex]?.id;
      return {
        resetChildren,
        commit: () => {
          sources.current = refreshedPages;
          setRows(result.items);
          setDetails(metadata);
          setNext(result.nextPage);
          setLimited(result.limited);
          setError('');
          if (!fresh) setSelected(undefined);
          const index = result.items
            .filter((row) => label(row).toLowerCase().includes(query.toLowerCase()))
            .findIndex((row) => row.id === activeId);
          setActive(Math.max(0, index));
        },
      };
    },
    pipeline ? 3 : 2,
  );
  const virtual = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 92,
    overscan: 3,
    getItemKey: (index) => visible[index]!.id,
    rangeExtractor: (range) =>
      [
        ...new Set([
          ...defaultRangeExtractor(range),
          ...(visible[activeIndex] ? [activeIndex] : []),
        ]),
      ].sort((a, b) => a - b),
  });
  const row = rows.find((item) => item.id === selected);
  const refresh = () => {
    setRows([]);
    setSelected(undefined);
    setDetails(undefined);
    setNext(null);
    setLimited(false);
    setPage(1);
    setActive(0);
    setAttempt((value) => value + 1);
    scroll.current?.scrollTo(0, 0);
  };
  return (
    <section aria-label={pipeline ? 'Pipeline jobs' : 'Merge-request pipelines'}>
      {pipeline ? (
        <>
          <h4>Pipeline #{pipeline.id}</h4>
          {details && (
            <>
              <p>
                {details.name && <strong>{details.name} · </strong>}
                {details.status} · {details.source ?? 'Source not reported'} · {details.ref}
              </p>
              <p>
                Commit <code>{details.sha}</code>
              </p>
              <p>
                <code>{details.url}</code>
              </p>
              {details.duration !== null && <p>Duration: {details.duration} seconds</p>}
              {details.queuedDuration !== null && <p>Queued: {details.queuedDuration} seconds</p>}
              {details.createdAt && <p>Created {details.createdAt}</p>}
              {details.updatedAt && <p>Updated {details.updatedAt}</p>}
            </>
          )}
          <p>Ordinary jobs only. Retried attempts and trigger jobs are not included.</p>
        </>
      ) : (
        <>
          <p>
            Source head <code>{head}</code>
          </p>
          <p>
            Pipelines can include historical and merged-result commits. Their statuses do not
            guarantee that merging is allowed.
          </p>
        </>
      )}
      <p role="status" aria-label={`${title} loaded`}>
        {rows.length} {kind} loaded{pending ? ' · Loading…' : ''}
      </p>
      <label>
        Search loaded {kind}{' '}
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            scroll.current?.scrollTo(0, 0);
          }}
        />
      </label>
      <div
        ref={scroll}
        className="pull-check-list"
        role="listbox"
        aria-label={title}
        tabIndex={0}
        aria-activedescendant={
          visible[activeIndex] ? `${listId}-${visible[activeIndex].id}` : undefined
        }
        onKeyDown={(event) => {
          let index = activeIndex;
          if (event.key === 'ArrowDown') index++;
          else if (event.key === 'ArrowUp') index--;
          else if (event.key === 'Home') index = 0;
          else if (event.key === 'End') index = visible.length - 1;
          else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (visible[activeIndex]) setSelected(visible[activeIndex].id);
            return;
          } else return;
          event.preventDefault();
          index = Math.max(0, Math.min(index, visible.length - 1));
          setActive(index);
          if (visible.length) virtual.scrollToIndex(index);
        }}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const row = visible[item.index]!;
            return (
              <div
                key={row.id}
                id={`${listId}-${row.id}`}
                role="option"
                aria-selected={selected === row.id}
                aria-posinset={item.index + 1}
                aria-setsize={visible.length}
                data-active={activeIndex === item.index}
                className="pull-check-row"
                title={label(row)}
                onClick={() => {
                  setActive(item.index);
                  setSelected(row.id);
                  scroll.current?.focus();
                }}
                style={{
                  position: 'absolute',
                  top: item.start,
                  height: item.size,
                  width: '100%',
                  overflow: 'hidden',
                  boxSizing: 'border-box',
                }}
              >
                <strong>
                  #{row.id} {row.name}
                </strong>
                <p>
                  {row.status} · {'stage' in row ? row.stage : row.ref}
                </p>
                {'sha' in row && (
                  <p>
                    {row.sha.slice(0, 12)} ·{' '}
                    {row.sha === head ? 'Matches source head' : 'Different commit'}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {!pending && !error && !visible.length && (
        <p>{query ? 'No loaded results match this search.' : `No ${kind} reported.`}</p>
      )}
      {error && <p role="alert">{error}</p>}
      {limited && (
        <p>
          The 1,000-{pipeline ? 'job' : 'pipeline'} display limit was reached. Further results may
          be omitted.
        </p>
      )}
      <div className="dialog-actions">
        <button disabled={pending} onClick={refresh}>
          {error ? `Retry ${kind}` : `Refresh ${kind}`}
        </button>
        {next !== null && !error && (
          <button disabled={pending} onClick={() => setPage(next)}>
            Load more {kind}
          </button>
        )}
      </div>
      {row &&
        ('stage' in row ? (
          <section aria-label="Selected job">
            <h4>{row.name}</h4>
            <p>
              {row.status} · {row.stage}
            </p>
            <p>{row.allowFailure ? 'Failure allowed' : 'Failure not allowed'}</p>
            {row.failureReason && <p>{row.failureReason}</p>}
            <p>Created {row.createdAt}</p>
            {row.startedAt && <p>Started {row.startedAt}</p>}
            {row.finishedAt && <p>Finished {row.finishedAt}</p>}
            {row.duration !== null && <p>Duration: {row.duration} seconds</p>}
            {row.queuedDuration !== null && <p>Queued: {row.queuedDuration} seconds</p>}
            <p>
              <code>{row.url}</code>
            </p>
          </section>
        ) : (
          <PipelinePages
            key={`${row.id}/${row.sha}/${sources.current.get(row.id)}`}
            accountId={accountId}
            repository={repository}
            number={number}
            head={head}
            pipeline={{ id: row.id, sha: row.sha, page: sources.current.get(row.id)! }}
          />
        ))}
    </section>
  );
}
