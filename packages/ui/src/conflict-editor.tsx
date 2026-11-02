import { useEffect, useRef, useState } from 'react';
import type { ConflictPreview, ResolveConflict } from '@openkraken/ipc-contract';
import { useRepository } from './store.js';
import MergeWorker from './merge-worker?worker';
import { renderMerge, type MergePart, type MergeResult } from './merge-model.js';
export function ConflictEditor({
  document,
  busy,
  error,
  close,
  resolve,
}: {
  document: ConflictPreview;
  busy: boolean;
  error?: string;
  close: () => void;
  resolve: (options: ResolveConflict) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [output, setOutput] = useState(document.working.text ?? '');
  const [parts, setParts] = useState<MergePart[]>();
  const [mergeError, setMergeError] = useState('');
  const [chunkMode, setChunkMode] = useState(false);
  const [resolutions, setResolutions] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Record<number, { ours: boolean[]; theirs: boolean[] }>>(
    {},
  );
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (!document.editable) return;
    const worker = new MergeWorker();
    const timer = setTimeout(() => {
      worker.terminate();
      setMergeError('Merge calculation timed out. Use the output editor or an external tool.');
    }, 5000);
    worker.onmessage = (event: MessageEvent<MergeResult>) => {
      clearTimeout(timer);
      worker.terminate();
      if (event.data.kind === 'error') setMergeError(event.data.message);
      else setParts(event.data.parts);
    };
    worker.onerror = () => {
      clearTimeout(timer);
      worker.terminate();
      setMergeError('Merge calculation failed. The output editor remains available.');
    };
    worker.postMessage({
      base: document.base?.text ?? '',
      ours: document.ours?.text ?? '',
      theirs: document.theirs?.text ?? '',
    });
    return () => {
      clearTimeout(timer);
      worker.terminate();
    };
  }, [document]);
  const apply = (choice: ResolveConflict['choice']) =>
    resolve(
      choice === 'output'
        ? { pathBytes: document.pathBytes, token: document.token, choice, text: output }
        : { pathBytes: document.pathBytes, token: document.token, choice },
    );
  const choose = (index: number, selection: { ours: boolean[]; theirs: boolean[] }) => {
    const part = parts?.[index];
    if (!parts || !part || part.kind !== 'conflict') return;
    const value = [
      ...part.ours.filter((_, i) => selection.ours[i]),
      ...part.theirs.filter((_, i) => selection.theirs[i]),
    ].join('');
    const next = { ...resolutions, [index]: value };
    setSelected({ ...selected, [index]: selection });
    setResolutions(next);
    setOutput(renderMerge(parts, next));
  };
  const unresolved =
    parts?.filter((part, index) => part.kind === 'conflict' && resolutions[index] === undefined)
      .length ?? 0;
  return (
    <dialog
      ref={dialog}
      className="conflict-editor"
      aria-label={`Resolve ${document.path}`}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <h2>Resolve {document.path}</h2>
      {document.operation === 'rebase' && (
        <p>
          During rebase, ours is the destination branch and theirs is the commit being replayed.
        </p>
      )}
      {document.working.kind === 'submodule' && (
        <p>
          Choosing a side updates only the submodule commit pointer. Files inside the submodule stay
          unchanged.
        </p>
      )}
      <div className="conflict-sides">
        {(['ours', 'theirs'] as const).map((side) => (
          <section key={side}>
            <h3>{side === 'ours' ? 'Ours' : 'Theirs'}</h3>
            {document[side]?.text !== undefined ? (
              <textarea
                aria-label={side === 'ours' ? 'Ours' : 'Theirs'}
                value={document[side].text}
                readOnly
                spellCheck={false}
              />
            ) : (
              <p>
                {document[side]
                  ? `${document[side].mode === '160000' ? 'Submodule commit' : 'Binary or large file'}: ${document[side].oid}`
                  : 'File absent on this side'}
              </p>
            )}
            <button disabled={busy} onClick={() => apply(side)}>
              {document[side] ? `Use ${side} and stage` : `Delete file (${side} absent)`}
            </button>
          </section>
        ))}
      </div>
      <details>
        <summary>Base version</summary>
        <pre>{document.base?.text ?? (document.base ? document.base.oid : 'No base version')}</pre>
      </details>
      {document.editable ? (
        <>
          {parts && parts.every((part) => part.kind === 'stable') && (
            <button
              disabled={busy}
              onClick={() =>
                resolve({
                  pathBytes: document.pathBytes,
                  token: document.token,
                  choice: 'output',
                  text: renderMerge(parts, {}),
                })
              }
            >
              Auto-merge and stage
            </button>
          )}
          {parts && !chunkMode && (
            <>
              <p>
                Chunk editing builds a new output from the three stages, replacing the current
                output draft.
              </p>
              <button
                disabled={busy}
                onClick={() => {
                  setChunkMode(true);
                  setResolutions({});
                  setSelected({});
                  setOutput(renderMerge(parts, {}));
                }}
              >
                Use chunk editor
              </button>
            </>
          )}
          {chunkMode && parts && (
            <section aria-label="Conflict chunks">
              {parts.map((part, index) =>
                part.kind === 'stable' ? null : (
                  <fieldset key={index}>
                    <legend>Chunk {index + 1}</legend>
                    {(['ours', 'theirs', 'both'] as const).map((side) => (
                      <button
                        key={side}
                        disabled={busy}
                        aria-label={`Take ${side} for chunk ${index + 1}`}
                        onClick={() =>
                          choose(index, {
                            ours: part.ours.map(() => side !== 'theirs'),
                            theirs: part.theirs.map(() => side !== 'ours'),
                          })
                        }
                      >
                        Take {side}
                      </button>
                    ))}
                    <details>
                      <summary>Choose individual lines</summary>
                      <div className="conflict-sides">
                        {(['ours', 'theirs'] as const).map((side) => (
                          <div key={side}>
                            <h4>{side}</h4>
                            {part[side].map((line, lineIndex) => (
                              <label className="merge-line" key={lineIndex}>
                                <input
                                  type="checkbox"
                                  disabled={busy}
                                  checked={selected[index]?.[side][lineIndex] ?? false}
                                  aria-label={`Chunk ${index + 1} ${side} line ${lineIndex + 1}`}
                                  onChange={(event) => {
                                    const value = selected[index] ?? {
                                      ours: part.ours.map(() => false),
                                      theirs: part.theirs.map(() => false),
                                    };
                                    choose(index, {
                                      ...value,
                                      [side]: value[side].map((checked, at) =>
                                        at === lineIndex ? event.target.checked : checked,
                                      ),
                                    });
                                  }}
                                />
                                <code>{line}</code>
                              </label>
                            ))}
                          </div>
                        ))}
                      </div>
                    </details>
                  </fieldset>
                ),
              )}
              <p>
                {unresolved
                  ? `${unresolved} chunks need a choice.`
                  : 'All chunks resolved. Review the output before saving.'}
              </p>
            </section>
          )}
          {mergeError && <p role="status">{mergeError}</p>}
          <label>
            Output
            <textarea
              className="merge-output"
              aria-label="Output"
              value={output}
              maxLength={2 * 1024 * 1024}
              disabled={busy}
              spellCheck={false}
              onChange={(event) => {
                setOutput(event.target.value);
                setChunkMode(false);
              }}
            />
          </label>
          {!chunkMode && /^(<<<<<<<|=======|>>>>>>>)/m.test(output) && (
            <p>Output contains conflict markers. Resolve them before saving.</p>
          )}
          <button disabled={busy || (chunkMode && unresolved > 0)} onClick={() => apply('output')}>
            Save and stage output
          </button>
        </>
      ) : (
        <p>
          This file cannot be edited as UTF-8 text here. Choose a whole side or resolve it with an
          external tool.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {document.externalTool && document.working.kind !== 'submodule' && (
        <button disabled={busy} onClick={() => apply('external')}>
          Open {document.externalTool} merge tool
        </button>
      )}
      <div className="dialog-actions">
        {busy && (
          <button onClick={() => void useRepository.getState().cancel()}>Cancel operation</button>
        )}
        <button disabled={busy} onClick={() => apply('delete')}>
          Delete file and resolve
        </button>
        <button disabled={busy} onClick={close}>
          Close
        </button>
      </div>
    </dialog>
  );
}
