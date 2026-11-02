import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
const FileComparisonDialog = lazy(() =>
  import('./file-comparison.js').then((module) => ({ default: module.FileComparisonDialog })),
);
import type { CommitFiles } from '@openkraken/ipc-contract';
export function CommitFilesPanel({ repoId, oid }: { repoId: string; oid: string }) {
  const [selected, setSelected] = useState<string>();
  const [data, setData] = useState<CommitFiles>();
  const [parent, setParent] = useState<string>();
  const [error, setError] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setData(undefined);
    setSelected(undefined);
    setError('');
    void window.openkraken
      .request({ id, method: 'commitFiles', repoId, oid, parent })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'error') setError(result.message);
        if (result.kind === 'commitFiles') setData(result.files);
      })
      .catch((error: unknown) => {
        if (alive) setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [repoId, oid, parent]);
  const virtual = useVirtualizer({
    count: data?.files.length ?? 0,
    getScrollElement: () => scroll.current,
    estimateSize: () => 36,
    overscan: 5,
  });
  return (
    <section aria-label="Commit file changes">
      <h3>Changed files{data && ` · ${data.files.length}`}</h3>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">Loading changed files…</p>}
      {data && (
        <>
          {data.parents.length > 0 ? (
            <label>
              Compare parent
              <select
                aria-label="Compare parent"
                value={data.parent}
                onChange={(event) => setParent(event.target.value)}
              >
                {data.parents.map((oid, index) => (
                  <option key={oid} value={oid}>
                    Parent {index + 1} · {oid.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p>Root commit · compared with an empty tree</p>
          )}
          {!data.files.length && <p>No file changes against this parent.</p>}
          <div ref={scroll} className="commit-files-scroll">
            <ol
              aria-label="Changed files"
              style={{
                height: virtual.getTotalSize(),
                position: 'relative',
                margin: 0,
                padding: 0,
                listStyle: 'none',
              }}
            >
              {virtual.getVirtualItems().map((row) => {
                const file = data.files[row.index]!;
                const label =
                  file.status === 'renamed' || file.status === 'copied'
                    ? `${file.oldPath} → ${file.newPath}`
                    : file.path;
                return (
                  <li
                    key={file.pathBytes}
                    className="commit-file-row"
                    style={{
                      position: 'absolute',
                      top: row.start,
                      height: row.size,
                      width: '100%',
                    }}
                    title={label}
                  >
                    <span className="file-change-kind">{file.status}</span>
                    <button
                      aria-label={`Compare ${file.path}`}
                      onClick={() => setSelected(file.pathBytes)}
                    >
                      <code>{label}</code>
                    </button>
                    {file.oldMode !== file.newMode && file.oldOid && file.newOid && (
                      <small>
                        {file.oldMode} → {file.newMode}
                      </small>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </>
      )}
      {selected && data && (
        <FileComparisonDialog
          key={`${data.parent}:${selected}`}
          repoId={repoId}
          options={{ commit: oid, parent: data.parent, pathBytes: selected }}
          onClose={() => setSelected(undefined)}
        />
      )}
    </section>
  );
}
