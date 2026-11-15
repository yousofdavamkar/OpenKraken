import { subscribeDesktopEvents } from './desktop-events.js';
import { useEffect, useRef, useState } from 'react';
import type { DesktopEvent } from '@openkraken/ipc-contract';
type Prompt = Extract<DesktopEvent, { type: 'editorPrompt' }> & { interrupted?: boolean };
function EditorDialog({ prompt, discard }: { prompt: Prompt; discard: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(prompt.text);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (!prompt.interrupted) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [prompt.interrupted]);
  const respond = async (value: string | null) => {
    if (pending || prompt.interrupted) return;
    setPending(true);
    setError('');
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'answerEditor',
        requestId: prompt.id,
        promptId: prompt.promptId,
        text: value,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'editorAnswered' && !result.accepted)
        throw new Error(
          'This editor request is no longer active. Review the current Git operation.',
        );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  const invalid = text.includes('\0') || new TextEncoder().encode(text).length > 1048576;
  return (
    <dialog
      ref={dialog}
      className="reference-dialog git-editor-dialog"
      aria-label="Git document editor"
      onCancel={(event) => {
        event.preventDefault();
        if (!prompt.interrupted) void respond(null);
      }}
    >
      <h2>Git document editor</h2>
      {prompt.interrupted ? (
        <p role="alert">
          The Git operation was interrupted. Saving this text was not confirmed. Copy your text
          before discarding this draft, then inspect the repository before retrying.
        </p>
      ) : (
        <p>Git requested an additional text document. Review your changes before continuing.</p>
      )}
      <code>{prompt.path}</code>
      <label>
        Document text
        <textarea
          autoFocus
          aria-label="Document text"
          rows={18}
          maxLength={1048576}
          spellCheck={false}
          disabled={pending && !prompt.interrupted}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      {invalid && <p role="alert">Enter text of at most 1 MiB without NUL bytes.</p>}
      {error && !prompt.interrupted && <p role="alert">{error}</p>}
      <div className="dialog-actions">
        {prompt.interrupted ? (
          <button onClick={discard}>Discard unsaved draft</button>
        ) : (
          <>
            <button disabled={pending} onClick={() => void respond(null)}>
              Cancel edit
            </button>
            <button
              className="primary"
              disabled={pending || invalid}
              onClick={() => void respond(text)}
            >
              Save and continue
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
export function GitEditors() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  useEffect(
    () =>
      subscribeDesktopEvents((event) => {
        if (event.type === 'editorPrompt')
          setPrompts((current) => [
            ...current.filter((item) => item.promptId !== event.promptId),
            event,
          ]);
        if (event.type === 'editorClosed')
          setPrompts((current) =>
            current.filter((item) => item.promptId !== event.promptId || item.interrupted),
          );
        if (event.type === 'gitRequestsInterrupted')
          setPrompts((current) =>
            current.map((item) =>
              event.requestIds.includes(item.id) ? { ...item, interrupted: true } : item,
            ),
          );
      }),
    [],
  );
  // Keep the same dialog mounted until the service closes it or the user discards
  // interrupted text. Clearing the operation's busy flag must not erase a draft.
  const prompt = prompts[0];
  return prompt ? (
    <EditorDialog
      key={prompt.promptId}
      prompt={prompt}
      discard={() =>
        setPrompts((current) => current.filter((item) => item.promptId !== prompt.promptId))
      }
    />
  ) : null;
}
