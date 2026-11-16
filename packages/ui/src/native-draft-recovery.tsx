import { useEffect, useState } from 'react';
import type { Result } from '@openkraken/ipc-contract';

export function NativeDraftRecovery({
  requestId,
  promptId,
  useText,
  disabled,
}: {
  requestId: string;
  promptId: string;
  useText: (text: string) => void;
  disabled: boolean;
}) {
  const [list, setList] = useState<Extract<Result, { kind: 'nativeDraftCandidates' }>>();
  const [selection, setSelection] = useState('');
  const [preview, setPreview] = useState<{ text: string; sameSource: boolean }>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void window.openkraken
      .request({ id: crypto.randomUUID(), method: 'nativeDraftCandidates', requestId, promptId })
      .then((result) => {
        if (!live) return;
        if (result.kind !== 'nativeDraftCandidates')
          throw new Error(
            result.kind === 'error' ? result.message : 'Could not list earlier drafts.',
          );
        setList(result);
        if (result.unreadable) setError('Some saved Git editor drafts could not be read.');
      })
      .catch((error) => {
        if (live) setError(String(error));
      });
    return () => {
      live = false;
    };
  }, [requestId, promptId]);
  useEffect(() => {
    const candidate = list?.entries.find((entry) => entry.promptId === selection);
    if (!list || !candidate) return;
    let live = true;
    void window.openkraken
      .request({
        id: crypto.randomUUID(),
        method: 'nativeDraftRead',
        repoId: list.repoId,
        promptId: candidate.promptId,
      })
      .then((result) => {
        if (!live) return;
        if (result.kind !== 'nativeDraftText' || result.revision !== candidate.revision)
          throw new Error(
            'The earlier draft changed. Review its current copy in Saved file drafts.',
          );
        setPreview({ text: result.text, sameSource: candidate.sameSource });
      })
      .catch((error) => {
        if (live) setError(String(error));
      });
    return () => {
      live = false;
    };
  }, [list, selection]);
  return (
    <>
      {error && <p role="status">{error}</p>}
      {!!list?.entries.length && (
        <details>
          <summary>Earlier drafts for this document</summary>
          <label>
            Saved draft{' '}
            <select
              value={selection}
              onChange={(event) => {
                setPreview(undefined);
                setError('');
                setSelection(event.target.value);
              }}
            >
              <option value="">Choose a draft</option>
              {list.entries.map((entry) => (
                <option key={entry.promptId} value={entry.promptId}>
                  {entry.path} · {new Date(entry.updatedAt).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          {preview && (
            <>
              <textarea
                aria-label="Earlier Git editor text"
                readOnly
                rows={6}
                value={preview.text}
              />
              {preview.sameSource ? (
                <button
                  disabled={disabled}
                  onClick={() => {
                    useText(preview.text);
                    setSelection('');
                    setPreview(undefined);
                  }}
                >
                  Use a copy of this draft
                </button>
              ) : (
                <p>The starting document has changed. Copy any text you want to keep.</p>
              )}
            </>
          )}
        </details>
      )}
    </>
  );
}
