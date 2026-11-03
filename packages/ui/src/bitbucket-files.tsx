import { editorTheme } from './editor-theme.js';
import { useEffect, useId, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { EditorState } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import type {
  ProviderBitbucketFilesOptions,
  ProviderBitbucketFile,
  ProviderBitbucketDiff,
} from '@openkraken/ipc-contract';
import { pollNumberedPages, useProviderPoll } from './provider-polling.js';

type Context = { accountId: string; options: Omit<ProviderBitbucketFilesOptions, 'page'> };
function Patch({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const doc = EditorState.create({ doc: text }).doc;
    const lines = [];
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const kind = line.text.startsWith('@@')
        ? 'hunk'
        : line.text.startsWith('+')
          ? 'added'
          : line.text.startsWith('-')
            ? 'removed'
            : null;
      if (kind) lines.push(Decoration.line({ class: `pr-patch-${kind}` }).range(line.from));
    }
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ 'aria-label': 'Bitbucket patch', tabindex: '0' }),
          lineNumbers(),
          keymap.of(defaultKeymap),
          EditorView.decorations.of(Decoration.set(lines)),
          editorTheme('300px'),
        ],
      }),
    });
    return () => view.destroy();
  }, [text]);
  return <div ref={host} className="pr-patch" />;
}
function FileDiff({
  context,
  file,
  onStale,
}: {
  context: Context;
  file: { path: string; page: number };
  onStale: () => void;
}) {
  const [diff, setDiff] = useState<ProviderBitbucketDiff>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const stale = useRef(onStale);
  stale.current = onStale;
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setPending(true);
    setDiff(undefined);
    setError('');
    void window.openkraken
      .request({
        id,
        method: 'providerBitbucketPullDiff',
        accountId: context.accountId,
        options: { ...context.options, ...file },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'providerBitbucketPullDiff') setDiff(result.diff);
        else if (result.kind === 'error') {
          setError(result.message);
          if (result.code === 'STALE_PROVIDER_MERGE') stale.current();
        }
      })
      .catch(() => {
        if (alive) setError('The file diff could not be loaded.');
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [context, file, attempt]);
  useProviderPoll(
    pending,
    `${file.path}/${file.page}/${attempt}`,
    async (read) => {
      const result = await read({
        method: 'providerBitbucketPullDiff',
        accountId: context.accountId,
        options: { ...context.options, ...file },
      });
      if (result.kind !== 'providerBitbucketPullDiff')
        throw new Error('The file diff could not be refreshed.');
      return {
        commit: () => {
          setDiff(result.diff);
          setError('');
        },
      };
    },
    3,
  );
  return (
    <section aria-label="File diff">
      <h4>{file.path}</h4>
      {pending && <p role="status">Loading diff…</p>}
      {error && <p role="alert">{error}</p>}
      {diff && (
        <>
          {diff.text ? (
            <Patch text={diff.text} />
          ) : (
            <p>No text diff was returned. Binary files may have no text patch.</p>
          )}
          {diff.truncated && <p>Diff truncated at 262,144 characters.</p>}
        </>
      )}
      <button disabled={pending} onClick={() => setAttempt(attempt + 1)}>
        {error ? 'Retry diff' : 'Refresh diff'}
      </button>
    </section>
  );
}
export function BitbucketFiles({ context }: { context: Context }) {
  const [files, setFiles] = useState<(ProviderBitbucketFile & { page: number })[]>([]);
  const [page, setPage] = useState(1);
  const [next, setNext] = useState<number | null>(null);
  const [limited, setLimited] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<{ path: string; page: number }>();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const id = useId();
  const visible = files.filter((file) =>
    `${file.path} ${file.previousPath ?? ''} ${file.status}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const virtual = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 56,
    overscan: 3,
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), ...(visible[active] ? [active] : [])])].sort(
        (a, b) => a - b,
      ),
  });
  const clearStale = () => {
    setFiles([]);
    setSelected(undefined);
    setNext(null);
    setError('The pull-request comparison changed. Refresh details before loading files.');
  };
  useEffect(() => {
    const requestId = crypto.randomUUID();
    let alive = true;
    setPending(true);
    setError('');
    void window.openkraken
      .request({
        id: requestId,
        method: 'providerBitbucketPullFiles',
        accountId: context.accountId,
        options: { ...context.options, page },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'providerBitbucketPullFiles') {
          setFiles((previous) => [
            ...new Map(
              [
                ...(page === 1 ? [] : previous),
                ...result.page.files.map((file) => ({ ...file, page })),
              ].map((file) => [file.path, file]),
            ).values(),
          ]);
          setNext(result.page.nextPage);
          setLimited(result.page.limited);
        } else if (result.kind === 'error') {
          setError(result.message);
          if (result.code === 'STALE_PROVIDER_MERGE') {
            setFiles([]);
            setSelected(undefined);
            setNext(null);
          }
        }
      })
      .catch(() => {
        if (alive) setError('Changed files could not be loaded.');
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(requestId);
    };
  }, [context, page, attempt]);
  useProviderPoll(pending, `${page}/${attempt}`, async (read) => {
    const result = await pollNumberedPages(
      page,
      async (number) => {
        const response = await read({
          method: 'providerBitbucketPullFiles',
          accountId: context.accountId,
          options: { ...context.options, page: number },
        });
        if (response.kind !== 'providerBitbucketPullFiles')
          throw new Error('Changed files could not be refreshed.');
        return {
          items: response.page.files.map((file) => ({ ...file, page: number })),
          nextPage: response.page.nextPage,
          limited: response.page.limited,
        };
      },
      (file) => file.path,
    );
    const selection = selected && result.items.find((file) => file.path === selected.path);
    return {
      commit: () => {
        setFiles(result.items);
        setNext(result.nextPage);
        setLimited(result.limited);
        setError('');
        if (selected && (!selection || selection.page !== selected.page))
          setSelected(selection ? { path: selection.path, page: selection.page } : undefined);
        const activePath = visible[active]?.path;
        const updated = result.items.filter((file) =>
          `${file.path} ${file.previousPath ?? ''} ${file.status}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
        );
        setActive(
          Math.max(
            0,
            updated.findIndex((file) => file.path === activePath),
          ),
        );
      },
      resetChildren: !!selected && (!selection || selection.page !== selected.page),
    };
  });
  const activate = (index: number) => {
    const bounded = Math.max(0, Math.min(index, visible.length - 1));
    setActive(bounded);
    virtual.scrollToIndex(bounded);
  };
  const open = (index: number) => {
    const file = visible[index];
    if (file) setSelected({ path: file.path, page: file.page });
  };
  return (
    <section aria-label="Bitbucket changed files">
      <label>
        Search loaded files
        <input
          type="search"
          maxLength={1000}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            scroll.current?.scrollTo(0, 0);
          }}
        />
      </label>
      <p role="status">{pending ? 'Loading files…' : `${files.length} files loaded.`}</p>
      {error && <p role="alert">{error}</p>}
      <div
        ref={scroll}
        role="listbox"
        aria-label="Changed files"
        className="provider-repositories"
        tabIndex={0}
        aria-activedescendant={visible[active] ? `${id}-${active}` : undefined}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') activate(active + 1);
          else if (event.key === 'ArrowUp') activate(active - 1);
          else if (event.key === 'Home') activate(0);
          else if (event.key === 'End') activate(visible.length - 1);
          else if (event.key === 'Enter') open(active);
          else return;
          event.preventDefault();
        }}
      >
        <div style={{ position: 'relative', height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((item) => {
            const file = visible[item.index]!;
            return (
              <div
                key={file.path}
                id={`${id}-${item.index}`}
                role="option"
                aria-label={`Open ${file.path}`}
                aria-selected={item.index === active}
                aria-posinset={item.index + 1}
                aria-setsize={visible.length}
                className="provider-repository"
                style={{ position: 'absolute', top: item.start, height: item.size, width: '100%' }}
                onClick={() => {
                  activate(item.index);
                  open(item.index);
                }}
              >
                <strong>{file.path}</strong>
                <span>
                  {file.status} · +{file.additions} −{file.deletions}
                  {file.previousPath ? ` · from ${file.previousPath}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {!pending && visible.length === 0 && <p>No files match.</p>}
      {next && (
        <button disabled={pending} onClick={() => setPage(next)}>
          Load more files
        </button>
      )}
      {limited && (
        <p>File limit reached (10,000 files). Narrow the change in Bitbucket to inspect more.</p>
      )}
      <button
        disabled={pending}
        onClick={() => {
          setFiles([]);
          setSelected(undefined);
          setNext(null);
          setPage(1);
          setAttempt(attempt + 1);
          setActive(0);
        }}
      >
        Refresh files
      </button>
      {error && (
        <button disabled={pending} onClick={() => setAttempt(attempt + 1)}>
          Retry files
        </button>
      )}
      {selected && (
        <FileDiff
          key={`${selected.path}/${selected.page}`}
          context={context}
          file={selected}
          onStale={clearStale}
        />
      )}
    </section>
  );
}
