import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConflictDraft, ConflictPreview, ResolveConflict } from '@openkraken/ipc-contract';
import { useRepository } from './store.js';
import { WorkingFileDraftSession } from './working-file-draft.js';
import MergeWorker from './merge-worker?worker';
import {
  renderMerge,
  resolveChunkChoices,
  type MergePart,
  type MergeResult,
} from './merge-model.js';
export function ConflictEditor({
  document,
  repoId,
  busy,
  error,
  close,
  resolve,
}: {
  document: ConflictPreview;
  repoId: string;
  busy: boolean;
  error?: string;
  close: () => void;
  resolve: (options: ResolveConflict) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const session = useRef<WorkingFileDraftSession | null>(null);
  const version = useRef(0);
  const approved = useRef(false);
  const [draft, setDraft] = useState<ConflictDraft | null>(null);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [status, setStatus] = useState('');
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [parts, setParts] = useState<MergePart[]>();
  const [mergeError, setMergeError] = useState('');
  const initial = document.working.text ?? '';
  const output = draft?.text ?? initial;
  const hasDraft = draft !== null;
  const stale = !!draft && (draft.token !== document.token || !document.editable);
  const locked = busy || !ready || pending || completed || stale || confirmDiscard;
  useEffect(() => {
    const current = new WorkingFileDraftSession();
    session.current = current;
    let live = true;
    void current
      .openConflict(repoId, document.pathBytes)
      .then((saved) => {
        if (live) {
          setDraft(saved);
          setStatus(saved ? 'Recovered conflict draft' : '');
        }
      })
      .catch((error: unknown) => {
        if (live)
          setStorageError(error instanceof Error ? error.message : 'Local drafts are unavailable.');
      })
      .finally(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
      version.current++;
      void current.close(false).catch(() => {});
    };
  }, [repoId, document.pathBytes]);
  useLayoutEffect(() => {
    if (!hasDraft) return;
    const prevent = (event: BeforeUnloadEvent) => {
      if (approved.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [hasDraft]);
  const change = (text: string, choices: ConflictDraft['choices']) => {
    const next: ConflictDraft | null =
      text === initial && choices === null
        ? null
        : { editor: 'conflict', text, token: document.token, choices };
    setDraft(next);
    setActionError('');
    const edit = ++version.current;
    if (!storageError) {
      setStatus('Saving draft…');
      session.current?.change(next, (message) => {
        if (edit === version.current) setStatus(message);
      });
    }
  };
  const finish = async (discard: boolean) => {
    setPending(true);
    approved.current = discard;
    try {
      if (!discard && storageError && draft)
        throw new Error('Copy your output or discard the draft before closing.');
      await session.current?.close(discard, !discard);
      close();
    } catch (error) {
      approved.current = false;
      setActionError(error instanceof Error ? error.message : 'Could not close the draft.');
      setPending(false);
    }
  };
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
  const choices = draft?.choices;
  const selected = useMemo(
    () => new Map(choices?.map((choice) => [choice.index, choice])),
    [choices],
  );
  const resolutions = useMemo(
    () => (choices && parts && !stale ? resolveChunkChoices(parts, choices) : undefined),
    [choices, parts, stale],
  );
  const chunkMode = !!resolutions && !!parts && renderMerge(parts, resolutions) === output;
  const unresolved =
    parts?.filter((part, index) => part.kind === 'conflict' && resolutions?.[index] === undefined)
      .length ?? 0;
  const apply = async (choice: ResolveConflict['choice'], text = output) => {
    if (locked) return;
    setPending(true);
    try {
      const success = await resolve(
        choice === 'output'
          ? { pathBytes: document.pathBytes, token: document.token, choice, text }
          : { pathBytes: document.pathBytes, token: document.token, choice },
      );
      if (success) {
        setCompleted(true);
        await finish(true);
      } else setPending(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The resolution was not confirmed.');
      setPending(false);
    }
  };
  const choose = (index: number, selection: { ours: string; theirs: string }) => {
    if (!parts || !choices) return;
    const next = [...choices.filter((choice) => choice.index !== index), { index, ...selection }];
    const resolved = resolveChunkChoices(parts, next);
    if (resolved) change(renderMerge(parts, resolved), next);
  };
  return (
    <dialog
      ref={dialog}
      className="conflict-editor"
      aria-label={`Resolve ${document.path}`}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy && !pending && ready) void finish(false);
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
            <button disabled={locked} onClick={() => apply(side)}>
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
            <button disabled={locked} onClick={() => void apply('output', renderMerge(parts, {}))}>
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
                disabled={locked}
                onClick={() => {
                  change(renderMerge(parts, {}), []);
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
                        disabled={locked}
                        aria-label={`Take ${side} for chunk ${index + 1}`}
                        onClick={() =>
                          choose(index, {
                            ours: (side !== 'theirs' ? '1' : '0').repeat(part.ours.length),
                            theirs: (side !== 'ours' ? '1' : '0').repeat(part.theirs.length),
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
                                  disabled={locked}
                                  checked={selected.get(index)?.[side][lineIndex] === '1'}
                                  aria-label={`Chunk ${index + 1} ${side} line ${lineIndex + 1}`}
                                  onChange={(event) => {
                                    const value = selected.get(index) ?? {
                                      ours: '0'.repeat(part.ours.length),
                                      theirs: '0'.repeat(part.theirs.length),
                                    };
                                    choose(index, {
                                      ...value,
                                      [side]:
                                        value[side].slice(0, lineIndex) +
                                        (event.target.checked ? '1' : '0') +
                                        value[side].slice(lineIndex + 1),
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
                  ? `${unresolved} ${unresolved === 1 ? 'chunk needs' : 'chunks need'} a choice.`
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
              readOnly={stale || completed}
              disabled={!ready || busy || pending || confirmDiscard}
              spellCheck={false}
              onChange={(event) => {
                change(event.target.value, null);
              }}
            />
          </label>
          {!chunkMode && /^(<<<<<<<|=======|>>>>>>>)/m.test(output) && (
            <p>Output contains conflict markers. Resolve them before saving.</p>
          )}
          {output.length > 2 * 1024 * 1024 && <p>Shorten the merged output to stage it.</p>}
          <button
            disabled={
              locked ||
              output.length > 2 * 1024 * 1024 ||
              (!!choices && (!chunkMode || unresolved > 0))
            }
            onClick={() => apply('output')}
          >
            Save and stage output
          </button>
        </>
      ) : (
        <p>
          This file cannot be edited as UTF-8 text here. Choose a whole side or resolve it with an
          external tool.
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {storageError && <p role="alert">{storageError}</p>}
      {stale && (
        <p role="alert">
          The conflict changed since this draft was saved. Copy the recovered output or discard the
          draft and reopen the conflict.
        </p>
      )}
      {stale && !document.editable && (
        <textarea aria-label="Recovered output" readOnly value={output} />
      )}
      {choices && parts && !chunkMode && !stale && (
        <p role="alert">
          The saved line choices no longer match the merge. Review and edit the recovered output
          before staging.
        </p>
      )}
      {actionError && (
        <>
          <p role="alert">{actionError}</p>
          <button
            disabled={pending || busy}
            onClick={() => {
              approved.current = true;
              close();
            }}
          >
            Close without changing the saved draft
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {document.externalTool && document.working.kind !== 'submodule' && (
        <button disabled={locked} onClick={() => apply('external')}>
          Open {document.externalTool} merge tool
        </button>
      )}
      <div className="dialog-actions">
        {busy && (
          <button onClick={() => void useRepository.getState().cancel()}>Cancel operation</button>
        )}
        <button disabled={locked} onClick={() => apply('delete')}>
          Delete file and resolve
        </button>
        {draft &&
          (confirmDiscard ? (
            <>
              <button disabled={pending} onClick={() => setConfirmDiscard(false)}>
                Keep draft
              </button>
              <button disabled={pending} onClick={() => void finish(true)}>
                Confirm discard
              </button>
            </>
          ) : (
            <button disabled={busy || pending} onClick={() => setConfirmDiscard(true)}>
              Discard conflict draft
            </button>
          ))}
        <button disabled={busy || pending || !ready} onClick={() => void finish(false)}>
          Close
        </button>
      </div>
    </dialog>
  );
}
