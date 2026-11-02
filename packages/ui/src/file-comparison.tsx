import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { EditorState, type Text } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { Change, MergeView, presentableDiff, unifiedMergeView } from '@codemirror/merge';
import { textEncodingSchema, type TextEncoding } from '@openkraken/ipc-contract';
import type { CommitComparisonOptions, FileComparison } from '@openkraken/ipc-contract';
type ViewMode = 'hunks' | 'inline' | 'split';
const theme = EditorView.theme(
  {
    '&': { backgroundColor: '#121b27', color: '#dae5f3', height: '100%' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'monospace' },
    '.cm-gutters': { backgroundColor: '#182332', color: '#94a3b8' },
  },
  { dark: true },
);
// Native hunks decide which lines changed, including ignored whitespace. CodeMirror
// only refines those ranges into word highlights; it never re-diffs the whole file.
function nativeChanges(data: FileComparison, a: Text, b: Text, words: boolean) {
  const changes: Change[] = [];
  const position = (doc: Text, line: number) =>
    line > doc.lines ? doc.length : doc.line(Math.max(1, line)).from;
  for (const hunk of data.hunks) {
    let oldLine = hunk.oldStart + (hunk.oldLines === 0 ? 1 : 0);
    let newLine = hunk.newStart + (hunk.newLines === 0 ? 1 : 0);
    let start: [number, number] | undefined;
    const flush = () => {
      if (!start) return;
      const fromA = position(a, start[0]),
        fromB = position(b, start[1]);
      const toA = position(a, oldLine),
        toB = position(b, newLine);
      if (words) {
        for (const change of presentableDiff(a.sliceString(fromA, toA), b.sliceString(fromB, toB), {
          timeout: 30,
          scanLimit: 500,
        }))
          changes.push(
            new Change(
              fromA + change.fromA,
              fromA + change.toA,
              fromB + change.fromB,
              fromB + change.toB,
            ),
          );
      } else changes.push(new Change(fromA, toA, fromB, toB));
      start = undefined;
    };
    for (const line of hunk.lines) {
      if (line.kind === 'context') flush();
      else start ??= [oldLine, newLine];
      if (line.kind !== 'add') oldLine++;
      if (line.kind !== 'del') newLine++;
    }
    flush();
  }
  return changes;
}
function TextComparison({
  data,
  mode,
  words,
}: {
  data: FileComparison;
  mode: 'inline' | 'split';
  words: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const extensions = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      lineNumbers(),
      theme,
      syntaxHighlighting(defaultHighlightStyle),
      /\.[cm]?[jt]sx?$/.test(data.file.path)
        ? javascript({
            typescript: /\.[cm]?tsx?$/.test(data.file.path),
            jsx: /x$/.test(data.file.path),
          })
        : [],
    ];
    const a = EditorState.create({ doc: data.oldVersion.text ?? '' }).doc;
    const b = EditorState.create({ doc: data.newVersion.text ?? '' }).doc;
    const changes = nativeChanges(data, a, b, words);
    const diffConfig = { override: () => changes };
    const view =
      mode === 'split'
        ? new MergeView({
            parent: host.current,
            a: { doc: a, extensions },
            b: { doc: b, extensions },
            diffConfig,
            highlightChanges: words,
          })
        : new EditorView({
            parent: host.current,
            doc: b,
            extensions: [
              ...extensions,
              unifiedMergeView({
                original: a,
                diffConfig,
                mergeControls: false,
                highlightChanges: words,
              }),
            ],
          });
    return () => view.destroy();
  }, [data, mode, words]);
  return (
    <div
      ref={host}
      className="comparison-code"
      aria-label={mode === 'split' ? 'Before and after' : 'Inline changes'}
    />
  );
}
function HunkComparison({ data }: { data: FileComparison }) {
  const scroll = useRef<HTMLDivElement>(null);
  const rows = useMemo(
    () =>
      data.hunks.flatMap((hunk) => [
        {
          kind: 'header',
          text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.header}`,
          oldNo: undefined,
          newNo: undefined,
          noNewline: false,
        },
        ...hunk.lines,
      ]),
    [data],
  );
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 24,
    overscan: 10,
  });
  return (
    <div className="comparison-hunks" ref={scroll} aria-label="Diff hunks" tabIndex={0}>
      <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
        {virtual.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          return (
            <div
              key={item.key}
              className={`comparison-line ${row.kind}`}
              style={{ position: 'absolute', top: item.start, height: item.size }}
            >
              <span className="line-number">{row.oldNo}</span>
              <span className="line-number">{row.newNo}</span>
              <span aria-hidden="true">
                {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}
              </span>
              <code>{row.text}</code>
              {row.noNewline && <small> (no final newline)</small>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
export function FileComparisonDialog({
  repoId,
  options,
  onClose,
}: {
  repoId: string;
  options: CommitComparisonOptions;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<FileComparison>();
  const [error, setError] = useState('');
  const [mode, setMode] = useState<ViewMode>('hunks');
  const [whitespace, setWhitespace] =
    useState<NonNullable<CommitComparisonOptions['whitespace']>>('exact');
  const [encoding, setEncoding] = useState<TextEncoding>();
  const [allowLarge, setAllowLarge] = useState(false);
  const [words, setWords] = useState(true);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const { commit, parent, pathBytes } = options;
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setData(undefined);
    setError('');
    void window.openkraken
      .request({
        id,
        method: 'commitComparison',
        repoId,
        options: { commit, parent, pathBytes, whitespace, allowLarge, encoding },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'error') setError(result.message);
        if (result.kind === 'fileComparison') setData(result.comparison);
      })
      .catch((error: unknown) => {
        if (alive) setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [repoId, commit, parent, pathBytes, whitespace, allowLarge, encoding]);
  const text =
    data &&
    [data.oldVersion, data.newVersion].every(
      (version) => version.kind === 'text' || version.kind === 'missing',
    );
  return (
    <dialog
      ref={dialog}
      className="reference-dialog file-comparison-dialog"
      aria-label="File comparison"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>{data?.file.path ?? 'File comparison'}</h2>
        <button autoFocus onClick={onClose}>
          Close comparison
        </button>
      </header>
      <div className="comparison-toolbar">
        <label>
          Diff view{' '}
          <select
            aria-label="Diff view"
            value={mode}
            onChange={(event) => setMode(event.target.value as ViewMode)}
          >
            <option value="hunks">Hunks</option>
            <option value="inline">Inline</option>
            <option value="split">Split</option>
          </select>
        </label>
        <label>
          Whitespace{' '}
          <select
            aria-label="Whitespace"
            value={whitespace}
            onChange={(event) => setWhitespace(event.target.value as typeof whitespace)}
          >
            <option value="exact">Show all changes</option>
            <option value="all">Ignore all whitespace</option>
            <option value="changes">Ignore whitespace amount</option>
            <option value="eol">Ignore trailing whitespace</option>
          </select>
        </label>
        <label>
          Encoding{' '}
          <select
            aria-label="Encoding"
            value={encoding ?? ''}
            onChange={(event) =>
              setEncoding(
                event.target.value ? textEncodingSchema.parse(event.target.value) : undefined,
              )
            }
          >
            <option value="">Auto-detect</option>
            {textEncodingSchema.options.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {mode !== 'hunks' && (
          <label>
            <input
              type="checkbox"
              checked={words}
              onChange={(event) => setWords(event.target.checked)}
            />
            Word highlights
          </label>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">Loading comparison…</p>}
      {data && (
        <>
          <p className="comparison-metadata">
            Before: {data.oldVersion.encoding ?? data.oldVersion.kind} ·{' '}
            {data.oldVersion.bytes.toLocaleString()} bytes · {data.file.oldMode} → After:{' '}
            {data.newVersion.encoding ?? data.newVersion.kind} ·{' '}
            {data.newVersion.bytes.toLocaleString()} bytes · {data.file.newMode}
          </p>
          {data.guard ? (
            <div>
              <p>
                This file exceeds the {data.guard.limit.toLocaleString()} {data.guard.reason}{' '}
                display limit.
              </p>
              {data.guard.canLoad ? (
                <button onClick={() => setAllowLarge(true)}>Load large comparison</button>
              ) : (
                <p>The hard display limit prevents loading this file.</p>
              )}
            </div>
          ) : text ? (
            <>
              {!data.hunks.length && <p>No text changes with these whitespace settings.</p>}
              {mode === 'hunks' ? (
                <HunkComparison data={data} />
              ) : (
                <TextComparison data={data} mode={mode} words={words} />
              )}
            </>
          ) : (
            <div>
              <p>
                {[data.oldVersion, data.newVersion].some((version) => version.kind === 'submodule')
                  ? 'Submodule reference changed'
                  : 'Binary file changed'}
              </p>
              <p>
                Before: <code>{data.oldVersion.oid ?? 'Absent'}</code>
              </p>
              <p>
                After: <code>{data.newVersion.oid ?? 'Absent'}</code>
              </p>
            </div>
          )}
        </>
      )}
    </dialog>
  );
}
