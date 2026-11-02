import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { EditorState } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import type {
  ProviderMergeRequestFile,
  ProviderMergeRequestFilesOptions,
} from '@openkraken/ipc-contract';
import { pollNumberedPages, useProviderPoll } from './provider-polling.js';

function MergePatch({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const document = EditorState.create({ doc: text });
    const decorations = [];
    for (let i = 1; i <= document.doc.lines; i++) {
      const line = document.doc.line(i);
      const kind = line.text.startsWith('@@')
        ? 'hunk'
        : line.text.startsWith('+')
          ? 'added'
          : line.text.startsWith('-')
            ? 'removed'
            : undefined;
      if (kind) decorations.push(Decoration.line({ class: `pr-patch-${kind}` }).range(line.from));
    }
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ 'aria-label': 'Provider patch', tabindex: '0' }),
          lineNumbers(),
          keymap.of(defaultKeymap),
          EditorView.decorations.of(Decoration.set(decorations)),
          EditorView.theme(
            {
              '&': { height: '300px', backgroundColor: '#10151e', color: '#d8e5f5' },
              '.cm-scroller': { overflow: 'auto', fontFamily: 'monospace' },
              '.cm-gutters': { backgroundColor: '#182332', color: '#9daec2' },
            },
            { dark: true },
          ),
        ],
      }),
    });
    return () => view.destroy();
  }, [text]);
  return <div ref={host} className="pr-patch" />;
}

export function MergeRequestFiles({
  accountId,
  repository,
  number,
  revision,
}: Omit<ProviderMergeRequestFilesOptions, 'page'> & { accountId: string }) {
  const [files, setFiles] = useState<ProviderMergeRequestFile[]>([]);
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [limited, setLimited] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string>();
  const [active, setActive] = useState(0);
  const listId = useId();
  const scroll = useRef<HTMLDivElement>(null);
  const restoreScroll = useRef<number | undefined>(undefined);
  const { base, head, start } = revision;
  useLayoutEffect(() => {
    if (restoreScroll.current !== undefined && scroll.current)
      scroll.current.scrollTop = restoreScroll.current;
    restoreScroll.current = undefined;
  }, [files]);
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setPending(true);
    setError('');
    void window.openkraken
      .request({
        id,
        method: 'providerMergeRequestFiles',
        accountId,
        options: { repository, number, revision: { base, head, start }, page },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'error') {
          setError(result.message);
          if (result.code === 'STALE_PROVIDER_MERGE') {
            setFiles([]);
            setSelected(undefined);
            setNext(null);
          }
        } else if (result.kind === 'providerMergeRequestFiles') {
          setFiles((current) => {
            const unique = new Map((page === 1 ? [] : current).map((file) => [file.path, file]));
            for (const file of result.page.files) unique.set(file.path, file);
            return [...unique.values()];
          });
          setNext(result.page.nextPage);
          setLimited(result.page.limited);
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
      void window.openkraken.cancel(id);
    };
  }, [accountId, repository, number, base, head, start, page, attempt]);
  useProviderPoll(
    pending,
    `${number}/${base}/${head}/${start}/${page}/${attempt}`,
    async (read) => {
      const currentPath = files[active]?.path;
      const top = Math.floor((scroll.current?.scrollTop ?? 0) / 42);
      const anchor = files[top]?.path;
      const offset = (scroll.current?.scrollTop ?? 0) % 42;
      const result = await pollNumberedPages(
        page,
        async (page) => {
          const result = await read({
            method: 'providerMergeRequestFiles',
            accountId,
            options: { repository, number, revision: { base, head, start }, page },
          });
          if (result.kind !== 'providerMergeRequestFiles')
            throw new Error('Changed files could not be refreshed.');
          return { ...result.page, items: result.page.files };
        },
        (file) => file.path,
      );
      return {
        commit: () => {
          const index = result.items.findIndex((file) => file.path === currentPath);
          const anchorIndex = result.items.findIndex((file) => file.path === anchor);
          restoreScroll.current =
            anchorIndex >= 0 ? anchorIndex * 42 + offset : scroll.current?.scrollTop;
          setFiles(result.items);
          setNext(result.nextPage);
          setLimited(result.limited);
          setError('');
          setActive(index >= 0 ? index : Math.max(0, Math.min(active, result.items.length - 1)));
          if (!result.items.some((file) => file.path === selected)) setSelected(undefined);
        },
      };
    },
  );
  const virtual = useVirtualizer({
    count: files.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 42,
    overscan: 3,
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), ...(files[active] ? [active] : [])])].sort(
        (a, b) => a - b,
      ),
  });
  const file = files.find((file) => file.path === selected);
  return (
    <section aria-label="Merge-request files">
      <p role="status">
        {files.length} files loaded{pending ? ' · Loading…' : ''}
      </p>
      <div
        ref={scroll}
        className="pr-files"
        role="listbox"
        aria-label="Changed files"
        tabIndex={0}
        aria-activedescendant={files[active] ? `${listId}-${active}` : undefined}
        onKeyDown={(event) => {
          let index = active;
          if (event.key === 'ArrowDown') index++;
          else if (event.key === 'ArrowUp') index--;
          else if (event.key === 'Home') index = 0;
          else if (event.key === 'End') index = files.length - 1;
          else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (files[active]) setSelected(files[active].path);
            return;
          } else return;
          event.preventDefault();
          index = Math.max(0, Math.min(index, files.length - 1));
          setActive(index);
          virtual.scrollToIndex(index);
        }}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const entry = files[item.index]!;
            return (
              <div
                key={entry.path}
                id={`${listId}-${item.index}`}
                role="option"
                className="pr-file"
                title={entry.path}
                aria-selected={selected === entry.path}
                aria-posinset={item.index + 1}
                aria-setsize={files.length}
                data-active={active === item.index}
                onClick={() => {
                  setActive(item.index);
                  setSelected(entry.path);
                  scroll.current?.focus();
                }}
                style={{ position: 'absolute', top: item.start, height: item.size, width: '100%' }}
              >
                {entry.status} · {entry.path}
                {entry.generated ? ' · Generated' : ''}
              </div>
            );
          })}
        </div>
      </div>
      {error && (
        <p role="alert">
          {error}{' '}
          <button disabled={pending} onClick={() => setAttempt((value) => value + 1)}>
            Retry files
          </button>
        </p>
      )}
      {next !== null && !error && (
        <button disabled={pending} onClick={() => setPage(next)}>
          Load more files
        </button>
      )}
      {limited && <p>Showing at most 3,000 files. Further files may be omitted.</p>}
      <p>GitLab may omit files and patches that exceed its configured diff limits.</p>
      <button
        disabled={pending}
        onClick={() => {
          setPage(1);
          setAttempt((value) => value + 1);
          setNext(null);
          setActive(0);
          scroll.current?.scrollTo(0, 0);
        }}
      >
        Refresh files
      </button>
      {file && (
        <section aria-label="Selected file patch">
          <h4>{file.path}</h4>
          {file.previousPath && <p>Previously: {file.previousPath}</p>}
          <p>
            File mode: {file.oldMode} → {file.newMode}
          </p>
          {file.collapsed && <p>GitLab collapsed this patch.</p>}
          {file.tooLarge && <p>GitLab omitted this patch because it exceeds its size limit.</p>}
          {file.patch === null ? (
            <p>No text diff was supplied. Binary or mode-only changes may have no text patch.</p>
          ) : (
            <MergePatch text={file.patch} />
          )}
          {file.patchTruncated && <p>This patch exceeds the display limit and is truncated.</p>}
        </section>
      )}
    </section>
  );
}
