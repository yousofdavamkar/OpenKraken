import { useEffect, useRef, useState } from 'react';
import type { DesktopEvent } from '@openkraken/ipc-contract';
import { useRepository } from './store.js';
type Prompt = Extract<DesktopEvent, { type: 'editorPrompt' }>;
function EditorDialog({ prompt }: { prompt: Prompt }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(prompt.text);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const respond = async (value: string | null) => {
    if (pending) return;
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
        void respond(null);
      }}
    >
      <h2>Git document editor</h2>
      <p>Git requested an additional text document. Review your changes before continuing.</p>
      <code>{prompt.path}</code>
      <label>
        Document text
        <textarea
          autoFocus
          aria-label="Document text"
          rows={18}
          maxLength={1048576}
          spellCheck={false}
          disabled={pending}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      {invalid && <p role="alert">Enter text of at most 1 MiB without NUL bytes.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions">
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
      </div>
    </dialog>
  );
}
export function GitEditors() {
  const busy = useRepository((state) => state.busy);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  useEffect(
    () =>
      window.openkraken.subscribe((event) => {
        if (event.type === 'editorPrompt')
          setPrompts((current) => [
            ...current.filter((item) => item.promptId !== event.promptId),
            event,
          ]);
        if (event.type === 'editorClosed')
          setPrompts((current) => current.filter((item) => item.promptId !== event.promptId));
      }),
    [],
  );
  useEffect(() => {
    if (!busy) setPrompts([]);
  }, [busy]);
  const prompt = prompts.find((prompt) => prompt.id === busy);
  return prompt ? <EditorDialog key={prompt.promptId} prompt={prompt} /> : null;
}
